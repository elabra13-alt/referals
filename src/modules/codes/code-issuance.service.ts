import type { FastifyBaseLogger } from 'fastify';
import type { Code } from '../../db/schema.js';
import { DUPLICATE_WINDOW_MS, type AntiFraudShield } from './anti-fraud-shield.js';
import type { BackupDelivery } from './backup-delivery.js';
import type { CodeGenerator } from './code-generator.js';
import type { CodesRepository } from './codes.repository.js';
import type { DiscountProvisioner } from './discount-provisioner.js';
import { AppError } from '../../lib/errors.js';
import { assessLinkAvailability, linkInactiveError, linkNotFoundError } from '../links/link-availability.js';
import type { CodeRequestBody, IssuedCodeDto } from './codes.schemas.js';

export type CodeRequestOutcome =
  | { kind: 'issued'; code: IssuedCodeDto; whatsappBackup: 'queued' | 'not_requested' }
  | { kind: 'duplicate'; code: IssuedCodeDto };

export function toIssuedCodeDto(code: Code): IssuedCodeDto {
  return {
    code: code.code,
    status: code.status,
    issued_at: code.issuedAt.toISOString(),
    expires_at: code.expiresAt.toISOString(),
    auto_apply_url: code.autoApplyUrl,
  };
}

export class CodeIssuanceService {
  constructor(
    private readonly deps: {
      repo: CodesRepository;
      shield: AntiFraudShield;
      generator: CodeGenerator;
      backupDelivery: BackupDelivery;
      /** Registers codes with the seller's store (e.g. Shopify); absent = codes live only in Referals. */
      discountProvisioner?: DiscountProvisioner;
      log: FastifyBaseLogger;
      now?: () => Date;
    },
  ) {}

  private now(): Date {
    return this.deps.now?.() ?? new Date();
  }

  /** Assumes the IP rate limit was already enforced by the caller. */
  async requestCode(body: CodeRequestBody): Promise<CodeRequestOutcome> {
    const { repo, shield, generator } = this.deps;
    const buyer = { email: body.buyer.email, phone: body.buyer.phone };

    shield.assertEmailAllowed(buyer.email);

    const link = await repo.findLinkContext(body.link_slug);
    if (!link) throw linkNotFoundError();

    const availability = assessLinkAvailability(link, this.now());
    if (availability !== 'active') throw linkInactiveError(availability);

    const outcome = await shield.withIssuanceLock(link.linkId, buyer, async (): Promise<CodeRequestOutcome> => {
      const lockedNow = this.now();
      const existing = await repo.findActiveCodeForBuyer({
        linkId: link.linkId,
        ...buyer,
        issuedSince: new Date(lockedNow.getTime() - DUPLICATE_WINDOW_MS),
        now: lockedNow,
      });
      if (existing) return { kind: 'duplicate', code: toIssuedCodeDto(existing) };

      const created = await generator.generateUnique(link.influencerSlug, link.checkoutBaseUrl, (candidate) =>
        repo.insertCode({
          linkId: link.linkId,
          code: candidate.code,
          buyerEmail: buyer.email,
          buyerPhone: buyer.phone,
          status: 'issued',
          issuedAt: candidate.issuedAt,
          expiresAt: candidate.expiresAt,
          autoApplyUrl: candidate.autoApplyUrl,
        }),
      );
      await this.provisionOrRevoke(link.sellerId, created);
      return { kind: 'issued', code: toIssuedCodeDto(created), whatsappBackup: 'not_requested' };
    });

    if (outcome.kind === 'issued' && body.buyer.send_whatsapp_backup && buyer.phone) {
      this.dispatchBackup(buyer.phone, outcome.code);
      outcome.whatsappBackup = 'queued';
    }
    return outcome;
  }

  /**
   * "Zero broken codes": a code is only shown once the store will accept it. If
   * provisioning fails the code is revoked (so a retry issues a fresh one) and
   * the buyer gets a retryable 503 instead of a code that fails at checkout.
   */
  private async provisionOrRevoke(sellerId: string, code: Code): Promise<void> {
    const provisioner = this.deps.discountProvisioner;
    if (!provisioner) return;
    try {
      await provisioner.provision({ sellerId, code: code.code, issuedAt: code.issuedAt, expiresAt: code.expiresAt });
    } catch (err) {
      this.deps.log.error({ err, code: code.code, sellerId }, 'discount provisioning failed; revoking code');
      await this.deps.repo.revokeCode(code.id);
      throw new AppError(503, 'DISCOUNT_PROVISIONING_FAILED', 'We could not activate your code with the store. Please try again.', undefined, {
        'Retry-After': '2',
      });
    }
  }

  /** Fire-and-forget: never delays or fails the on-screen code response. */
  private dispatchBackup(phone: string, code: IssuedCodeDto): void {
    setImmediate(() => {
      this.deps.backupDelivery
        .enqueue({
          channel: 'whatsapp',
          to: phone,
          code: code.code,
          autoApplyUrl: code.auto_apply_url,
          expiresAt: new Date(code.expires_at),
        })
        .catch((err: unknown) => this.deps.log.error({ err, code: code.code }, 'backup delivery enqueue failed'));
    });
  }
}
