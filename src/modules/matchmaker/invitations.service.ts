import { isUniqueViolation, type Database } from '../../db/client.js';
import type { CampaignInvitation, Creator, InvitationStatus } from '../../db/schema.js';
import { AppError } from '../../lib/errors.js';
import { estimatedCommission, storefrontUrl } from '../catalog/catalog.service.js';
import type { CampaignEnrollment } from '../catalog/enrollment.js';
import type { HookSet, HooksGenerator } from '../catalog/hooks-generator.js';
import type { CreatorsRepository } from '../creators/creators.repository.js';
import { generateMagicToken, magicTokenMatches } from '../creators/magic-link.js';
import { toLinkDto, type LinkDto } from '../creators/creators.schemas.js';
import type { WhatsAppNotificationService } from '../notifications/whatsapp.service.js';
import { escrowDaysForCategory } from '../webhooks/escrow.js';
import { InvitationsRepository, type InvitationDetailRow } from './invitations.repository.js';
import { effectiveStatus, matchReasonText, matchTags, type MatchTag, type MatchmakerService } from './matchmaker.service.js';

export const INVITATION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** Anti-spam limits for seller → creator invitations (protects creators and the WhatsApp sender's quality rating). */
export const INVITATION_QUOTA_CONFIG = {
  MAX_PENDING_PER_CAMPAIGN: 25,
  MAX_DAILY_PER_SELLER: 50,
} as const;
/** The daily quota is a sliding window, not a calendar day. */
export const INVITATION_QUOTA_WINDOW_MS = 24 * 60 * 60 * 1000;

export interface InvitationQuotaDto {
  /** Pending, unexpired invitations on this campaign. */
  active_pending: number;
  max_pending: number;
  /** Invitations this seller sent or re-sent in the last 24h, across all campaigns. */
  sent_last_24h: number;
  daily_limit: number;
  can_invite: boolean;
  /** When the daily quota is exhausted: seconds until the next send is allowed. */
  retry_after_seconds: number | null;
}

const notFound = () => new AppError(404, 'INVITATION_NOT_FOUND', 'Invitation not found.');

/** Seller-facing view. */
export interface SellerInvitationDto {
  id: string;
  campaign_id: string;
  creator: { slug: string; name: string; handle: string };
  status: InvitationStatus;
  match_score: number;
  match_reason: string;
  tags?: MatchTag[];
  /** Seller's quota after this send (on invite responses). */
  quota?: InvitationQuotaDto;
  custom_note: string | null;
  expires_at: string;
  responded_at: string | null;
  created_at: string;
}

/** Creator inbox view: what they'd earn, from whom, and how to pitch it. */
export interface CreatorInvitationDto {
  id: string;
  status: InvitationStatus;
  /** False when the campaign, product or brand is no longer active. */
  can_accept: boolean;
  brand: { name: string };
  product: { id: string; name: string; image_url: string | null; price: string; currency: string; category: string };
  commission_rate: string;
  /** Creator commission on one sale at list price ($ MXN for MXN products). */
  estimated_earnings_per_sale: string;
  escrow_days: number;
  match_score: number;
  match_reason: string;
  custom_note: string | null;
  hooks: HookSet;
  expires_at: string;
  created_at: string;
}

/** A creator authenticated for one invitation through its magic link or session. */
export interface MagicAccess {
  row: InvitationDetailRow;
  creator: Creator;
}

/** Everything the mobile invitation page renders. */
export interface InvitationPageView {
  invitation: CreatorInvitationDto;
  /** Set once accepted: where the creator's link and storefront live. */
  accepted: { link_url: string; storefront_url: string } | null;
}

const invalidMagicLink = () => new AppError(401, 'MAGIC_LINK_INVALID', 'This invitation link is not valid.');

export interface AcceptResultDto {
  status: 'accepted' | 'already_accepted';
  invitation: CreatorInvitationDto;
  link: LinkDto;
  storefront: { item_id: string; url: string };
}

/**
 * Direct campaign invitations: seller → creator, 7-day window, one per
 * (campaign, creator). Acceptance enrolls the creator through the same
 * CampaignEnrollment as the Open Catalog (link + storefront card in one
 * transaction) and marks the invitation accepted inside that transaction.
 */
export class InvitationsService {
  constructor(
    private readonly deps: {
      db: Database;
      repo: InvitationsRepository;
      matchmaker: MatchmakerService;
      creatorsRepo: CreatorsRepository;
      enrollment: CampaignEnrollment;
      hooks: HooksGenerator;
      publicLinkBaseUrl: string;
      /** Out-of-band creator notifications; absent = no WhatsApp. */
      whatsapp?: WhatsAppNotificationService;
    },
  ) {}

  /**
   * Tells the creator about a new (or re-sent) invitation over WhatsApp, in the
   * background: the invite request never waits on, or fails because of, WhatsApp.
   */
  private notifyCreator(invitation: CampaignInvitation, creator: Creator, magicToken: string): void {
    const whatsapp = this.deps.whatsapp;
    if (!whatsapp) return;
    whatsapp.dispatchInBackground(async () => {
      const row = await this.deps.repo.findForCreator(invitation.id, creator.id);
      if (!row) return null;
      return {
        contact: { phone: creator.phone, whatsappOptInAt: creator.whatsappOptInAt },
        notice: {
          invitationId: invitation.id,
          magicToken,
          creatorName: creator.name,
          brandName: row.brandName,
          productName: row.productName,
          earningsPerSale: estimatedCommission(row.price, row.commissionRate),
          currency: row.currency,
          expiresAt: invitation.expiresAt,
        },
      };
    });
  }

  private now(): Date {
    return this.deps.matchmaker.now();
  }

  // ---------- Seller ----------

  async invite(sellerId: string, campaignId: string, input: { creator_slug: string; custom_note: string | null }): Promise<SellerInvitationDto> {
    const { campaign, product } = await this.deps.matchmaker.loadOwnedCampaign(sellerId, campaignId);
    if (campaign.status !== 'active' || product.status !== 'active') {
      throw new AppError(409, 'CAMPAIGN_NOT_ACTIVE', 'Invitations can only be sent for active campaigns and products.');
    }

    const creator = await this.deps.creatorsRepo.findCreatorBySlug(input.creator_slug);
    if (!creator) throw new AppError(404, 'CREATOR_NOT_FOUND', 'Creator not found.');
    if (creator.status !== 'active') throw new AppError(409, 'CREATOR_SUSPENDED', 'This creator is not accepting campaigns.');
    if (await this.deps.creatorsRepo.findLinkForCreator(campaign.id, creator.id)) {
      throw new AppError(409, 'ALREADY_JOINED', 'This creator already promotes this campaign.');
    }

    const now = this.now();
    const match = this.deps.matchmaker.score(product, creator);
    // Fresh per send: a re-send rotates the token, killing older links and sessions.
    const magic = generateMagicToken();
    const values = {
      magicTokenHash: magic.hash,
      matchScore: match.score,
      matchReason: matchReasonText(match),
      customNote: input.custom_note,
      expiresAt: new Date(now.getTime() + INVITATION_TTL_MS),
      sentAt: now,
    };

    let sent: { invitation: CampaignInvitation; quota: InvitationQuotaDto };
    try {
      // One transaction per send, holding the seller's row lock: the existing-invitation
      // check, both quota checks and the insert/re-send can't interleave with a
      // concurrent invite from the same seller (no 26th pending, no 51st send).
      sent = await this.deps.db.transaction(async (rawTx) => {
        const repo = new InvitationsRepository(rawTx as unknown as Database);
        await repo.lockSeller(sellerId);

        const existing = await repo.findByCampaignAndCreator(campaign.id, creator.id);
        if (existing) {
          const status = effectiveStatus(existing, now);
          if (status === 'pending') {
            throw new AppError(409, 'INVITATION_PENDING', 'This creator already has a pending invitation.', {
              invitation: this.toSellerDto(existing, creator),
            });
          }
          // Respect the creator's choice: no re-inviting after a decline.
          if (status === 'declined') throw new AppError(409, 'INVITATION_DECLINED', 'This creator declined this campaign.');
          if (status === 'accepted') throw new AppError(409, 'ALREADY_JOINED', 'This creator already promotes this campaign.');
        }

        await this.assertQuota(repo, sellerId, campaign.id, now);
        const invitation = existing
          ? await repo.reopen(existing.id, values) // expired → re-send (counts as a send)
          : await repo.insert({ campaignId: campaign.id, sellerId, creatorId: creator.id, ...values });
        return { invitation, quota: (await this.quotaWith(repo, sellerId, campaign.id, now)).dto };
      });
    } catch (err) {
      if (isUniqueViolation(err, 'invitation_campaign_creator_idx')) {
        throw new AppError(409, 'INVITATION_PENDING', 'This creator already has a pending invitation.');
      }
      throw err;
    }

    this.notifyCreator(sent.invitation, creator, magic.token); // after commit: never for a rolled-back send
    return { ...this.toSellerDto(sent.invitation, creator), tags: matchTags(creator, match), quota: sent.quota };
  }

  // ---------- Quotas ----------

  private async quotaWith(
    repo: InvitationsRepository,
    sellerId: string,
    campaignId: string,
    now: Date,
  ): Promise<{ dto: InvitationQuotaDto; oldestSend: Date | null }> {
    const [activePending, sends] = await Promise.all([
      repo.countActivePending(campaignId, now),
      repo.sendsSince(sellerId, new Date(now.getTime() - INVITATION_QUOTA_WINDOW_MS)),
    ]);
    const { MAX_PENDING_PER_CAMPAIGN, MAX_DAILY_PER_SELLER } = INVITATION_QUOTA_CONFIG;
    const dailyExhausted = sends.count >= MAX_DAILY_PER_SELLER;
    // The window frees its next slot when the oldest counted send turns 24h old.
    const retryAfterSeconds =
      dailyExhausted && sends.oldest
        ? Math.max(1, Math.ceil((sends.oldest.getTime() + INVITATION_QUOTA_WINDOW_MS - now.getTime()) / 1000))
        : null;
    return {
      dto: {
        active_pending: activePending,
        max_pending: MAX_PENDING_PER_CAMPAIGN,
        sent_last_24h: sends.count,
        daily_limit: MAX_DAILY_PER_SELLER,
        can_invite: activePending < MAX_PENDING_PER_CAMPAIGN && !dailyExhausted,
        retry_after_seconds: retryAfterSeconds,
      },
      oldestSend: sends.oldest,
    };
  }

  /** Campaign slots first (a persistent state the seller can fix by waiting for responses), then the 24h quota. */
  private async assertQuota(repo: InvitationsRepository, sellerId: string, campaignId: string, now: Date): Promise<void> {
    const { dto } = await this.quotaWith(repo, sellerId, campaignId, now);
    if (dto.active_pending >= dto.max_pending) {
      throw new AppError(
        422,
        'INVITATION_PENDING_LIMIT_REACHED',
        `This campaign already has ${dto.max_pending} pending invitations. Slots free up as creators accept, decline or invitations expire.`,
        { current_pending: dto.active_pending, max_pending: dto.max_pending, quota: dto },
      );
    }
    if (dto.sent_last_24h >= dto.daily_limit) {
      const retryAfter = dto.retry_after_seconds ?? 1;
      throw new AppError(
        429,
        'DAILY_INVITATION_QUOTA_EXCEEDED',
        `You can send up to ${dto.daily_limit} invitations per 24 hours.`,
        { sent_last_24h: dto.sent_last_24h, daily_limit: dto.daily_limit, retry_after_seconds: retryAfter, quota: dto },
        { 'Retry-After': String(retryAfter) },
      );
    }
  }

  /** Current quota for one of the seller's campaigns (ownership-checked). */
  async quotaFor(sellerId: string, campaignId: string): Promise<InvitationQuotaDto> {
    const { campaign } = await this.deps.matchmaker.loadOwnedCampaign(sellerId, campaignId);
    return (await this.quotaWith(this.deps.repo, sellerId, campaign.id, this.now())).dto;
  }

  async listForCampaign(sellerId: string, campaignId: string): Promise<{ data: SellerInvitationDto[] }> {
    const { campaign } = await this.deps.matchmaker.loadOwnedCampaign(sellerId, campaignId);
    const rows = await this.deps.repo.listForCampaign(campaign.id);
    return {
      data: rows.map((r) =>
        this.toSellerDto(r.invitation, { slug: r.creatorSlug, name: r.creatorName, handle: r.creatorHandle }),
      ),
    };
  }

  private toSellerDto(inv: CampaignInvitation, creator: Pick<Creator, 'slug' | 'name' | 'handle'>): SellerInvitationDto {
    return {
      id: inv.id,
      campaign_id: inv.campaignId,
      creator: { slug: creator.slug, name: creator.name, handle: creator.handle },
      status: effectiveStatus(inv, this.now()),
      match_score: inv.matchScore,
      match_reason: inv.matchReason,
      custom_note: inv.customNote,
      expires_at: inv.expiresAt.toISOString(),
      responded_at: inv.respondedAt?.toISOString() ?? null,
      created_at: inv.createdAt.toISOString(),
    };
  }

  // ---------- Creator ----------

  private isOpen(row: InvitationDetailRow): boolean {
    return row.campaignStatus === 'active' && row.productStatus === 'active' && row.sellerStatus === 'active';
  }

  private toCreatorDto(row: InvitationDetailRow, creator: Creator): CreatorInvitationDto {
    const inv = row.invitation;
    const status = effectiveStatus(inv, this.now());
    return {
      id: inv.id,
      status,
      can_accept: status === 'pending' && this.isOpen(row),
      brand: { name: row.brandName },
      product: { id: row.productId, name: row.productName, image_url: row.productImageUrl, price: row.price, currency: row.currency, category: row.category },
      commission_rate: row.commissionRate,
      estimated_earnings_per_sale: estimatedCommission(row.price, row.commissionRate),
      escrow_days: escrowDaysForCategory(row.category),
      match_score: inv.matchScore,
      match_reason: inv.matchReason,
      custom_note: inv.customNote,
      hooks: this.deps.hooks.generate({ creatorSlug: creator.slug, productName: row.productName, productCategory: row.category }),
      expires_at: inv.expiresAt.toISOString(),
      created_at: inv.createdAt.toISOString(),
    };
  }

  /** Default view: actionable invitations (pending, not expired). `status=all` returns history too. */
  async inbox(creator: Creator, filter: InvitationStatus | 'all'): Promise<{ data: CreatorInvitationDto[] }> {
    const rows = await this.deps.repo.listForCreator(creator.id);
    const items = rows.map((r) => this.toCreatorDto(r, creator));
    return { data: filter === 'all' ? items : items.filter((i) => i.status === filter) };
  }

  async accept(creator: Creator, invitationId: string): Promise<AcceptResultDto> {
    const row = await this.deps.repo.findForCreator(invitationId, creator.id);
    if (!row) throw notFound();
    const status = effectiveStatus(row.invitation, this.now());

    if (status === 'declined') throw new AppError(409, 'INVITATION_DECLINED', 'You declined this invitation.');
    if (status === 'expired') {
      await this.deps.repo.respond(row.invitation.id, 'expired', this.now());
      throw new AppError(410, 'INVITATION_EXPIRED', 'This invitation has expired.');
    }
    if (status === 'pending' && !this.isOpen(row)) {
      throw new AppError(410, 'CAMPAIGN_NOT_ACTIVE', 'This campaign is no longer active.');
    }

    const now = this.now();
    // Whether *this* request moved the invitation pending → accepted. Decided inside the
    // transaction (the update only matches a pending row), so concurrent accepts report
    // exactly one "accepted" — a status read before enrolling would be stale.
    let transitioned = false;
    const enrolled = await this.deps.enrollment.enroll(
      creator,
      {
        campaignId: row.invitation.campaignId,
        productId: row.productId,
        productName: row.productName,
        category: row.category,
        price: row.price,
        currency: row.currency,
      },
      // Accepting and enrolling commit together (no-op if it was already accepted).
      {
        inTx: async (tx) => {
          transitioned = (await new InvitationsRepository(tx).respond(row.invitation.id, 'accepted', now)) !== null;
        },
      },
    );

    const fresh = (await this.deps.repo.findForCreator(invitationId, creator.id))!;
    return {
      status: transitioned ? 'accepted' : 'already_accepted',
      invitation: this.toCreatorDto(fresh, creator),
      link: toLinkDto(enrolled.link, this.deps.publicLinkBaseUrl),
      storefront: { item_id: enrolled.storefrontItemId, url: storefrontUrl(this.deps.publicLinkBaseUrl, creator.slug) },
    };
  }

  // ---------- Magic link (mobile page) ----------

  /**
   * Verifies a magic-link token. Unknown invitation, wrong token and inactive
   * creator are indistinguishable (401); a valid token past the invitation's
   * window is 410.
   */
  async openMagicLink(invitationId: string, token: string): Promise<MagicAccess> {
    const row = await this.deps.repo.findDetail(invitationId);
    if (!row || !magicTokenMatches(token, row.invitation.magicTokenHash)) throw invalidMagicLink();
    const access = await this.withActiveCreator(row);
    if (!access) throw invalidMagicLink();
    if (row.invitation.expiresAt.getTime() <= this.now().getTime()) {
      throw new AppError(410, 'MAGIC_LINK_EXPIRED', 'This invitation link has expired.');
    }
    return access;
  }

  /** The invitation and its (active) creator, for checking a session cookie against. */
  async sessionSubject(invitationId: string): Promise<MagicAccess | null> {
    const row = await this.deps.repo.findDetail(invitationId);
    return row ? this.withActiveCreator(row) : null;
  }

  private async withActiveCreator(row: InvitationDetailRow): Promise<MagicAccess | null> {
    const creator = await this.deps.creatorsRepo.findCreatorById(row.invitation.creatorId);
    return creator && creator.status === 'active' ? { row, creator } : null;
  }

  async pageView(creator: Creator, invitationId: string): Promise<InvitationPageView> {
    const row = await this.deps.repo.findForCreator(invitationId, creator.id);
    if (!row) throw notFound();
    const invitation = this.toCreatorDto(row, creator);
    let accepted: InvitationPageView['accepted'] = null;
    if (invitation.status === 'accepted') {
      const link = await this.deps.creatorsRepo.findLinkForCreator(row.invitation.campaignId, creator.id);
      if (link) {
        accepted = {
          link_url: toLinkDto(link, this.deps.publicLinkBaseUrl).url,
          storefront_url: storefrontUrl(this.deps.publicLinkBaseUrl, creator.slug),
        };
      }
    }
    return { invitation, accepted };
  }

  async decline(creator: Creator, invitationId: string): Promise<CreatorInvitationDto> {
    const row = await this.deps.repo.findForCreator(invitationId, creator.id);
    if (!row) throw notFound();
    const status = effectiveStatus(row.invitation, this.now());
    if (status === 'accepted') throw new AppError(409, 'INVITATION_ALREADY_ACCEPTED', 'You already accepted this invitation.');
    if (status === 'expired') throw new AppError(410, 'INVITATION_EXPIRED', 'This invitation has expired.');
    if (status === 'pending') await this.deps.repo.respond(row.invitation.id, 'declined', this.now());
    return this.toCreatorDto((await this.deps.repo.findForCreator(invitationId, creator.id))!, creator);
  }
}
