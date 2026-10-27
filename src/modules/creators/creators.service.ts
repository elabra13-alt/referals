import { randomInt } from 'node:crypto';
import { isUniqueViolation, type Database } from '../../db/client.js';
import type { Campaign, Creator, Product } from '../../db/schema.js';
import { AppError } from '../../lib/errors.js';
import { generateCreatorApiKey, hashApiKey } from '../../lib/keys.js';
import { decimalToCents } from '../../lib/money.js';
import { deriveCreatorSlug, ENTROPY_ALPHABET } from '../codes/code-generator.js';
import { LedgerService } from '../ledger/ledger.service.js';
import type { SellersRepository } from '../sellers/sellers.repository.js';
import type { CreatorPatch, CreatorsRepository } from './creators.repository.js';
import {
  toCreatorProfileDto,
  toLinkDto,
  type CreateLinkInput,
  type CreatorBalanceDto,
  type CreatorLinkDto,
  type CreatorMeDto,
  type CreatorProfileDto,
  type LinkDto,
  type LinkIssuedDto,
  type RegisterCreatorInput,
  type UpdateMeInput,
} from './creators.schemas.js';
import type { MatchingService } from './matching.service.js';
import type { ScriptGenerator } from './script-generator.service.js';

export const MAX_LINK_SLUG_ATTEMPTS = 4;
/** Always present in a creator's balance, even before any activity. */
const PRIMARY_CURRENCY = 'MXN';

export interface CreatorProfile {
  creator: CreatorProfileDto;
  balance: {
    /** Released funds (ledger sum); can be negative after clawbacks. */
    available: { currency: string; amount: string; is_negative: boolean }[];
    /** Attributed sales still inside their escrow window. */
    pending_escrow: { currency: string; amount: string; payout_count: number; next_release_at: string | null }[];
  };
  links_count: number;
}

/** "Sérum Glow 2.0!" -> "serum-glow-2-0" */
export function slugify(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** Default link slug for a creator + product, e.g. "leo-serum-glow" (<= 59 chars, leaving room for a suffix). */
export function linkSlugBase(creatorSlug: string, productName: string): string {
  return `${creatorSlug.toLowerCase()}-${slugify(productName)}`.slice(0, 59).replace(/-+$/, '');
}

export function randomSuffix(length = 4): string {
  let out = '';
  for (let i = 0; i < length; i++) out += ENTROPY_ALPHABET[randomInt(ENTROPY_ALPHABET.length)]!.toLowerCase();
  return out;
}

export class CreatorsService {
  constructor(
    private readonly deps: {
      db: Database;
      repo: CreatorsRepository;
      sellersRepo: SellersRepository;
      matching: MatchingService;
      scripts: ScriptGenerator;
      publicLinkBaseUrl: string;
      now?: () => Date;
    },
  ) {}

  private now(): Date {
    return this.deps.now?.() ?? new Date();
  }

  // ---------- Creators ----------

  /** Returns the profile plus the creator's API key, shown exactly once (only its SHA-256 is stored). */
  async register(input: RegisterCreatorInput): Promise<CreatorProfileDto & { api_key: string }> {
    const apiKey = generateCreatorApiKey();
    const slug = input.slug ?? deriveCreatorSlug(input.handle);
    try {
      const creator = await this.deps.repo.insertCreator({
        slug,
        handle: input.handle,
        name: input.name,
        email: input.email,
        niche: input.niche,
        followersCount: input.followers_count,
        engagementRate: input.engagement_rate,
        speiClabe: input.spei_clabe ?? null,
        apiKeyHash: hashApiKey(apiKey),
      });
      return { ...toCreatorProfileDto(creator), api_key: apiKey };
    } catch (err) {
      if (isUniqueViolation(err, 'creators_slug_unique')) {
        throw new AppError(409, 'SLUG_TAKEN', `Creator slug ${slug} is already taken; pass an explicit "slug".`, { slug });
      }
      if (isUniqueViolation(err, 'creators_email_unique')) {
        throw new AppError(409, 'EMAIL_TAKEN', 'A creator with this email already exists.');
      }
      throw err;
    }
  }

  async getProfile(slug: string): Promise<CreatorProfile> {
    const creator = await this.deps.repo.findCreatorBySlug(slug);
    if (!creator) throw new AppError(404, 'CREATOR_NOT_FOUND', 'Creator not found.');

    const [ledger, pending, linksCount] = await Promise.all([
      new LedgerService(this.deps.db).getBalance(creator.slug),
      this.deps.repo.pendingEscrow(creator.slug),
      this.deps.repo.countLinks(creator.slug),
    ]);

    return {
      creator: toCreatorProfileDto(creator),
      balance: {
        available: ledger.balances.map((b) => ({ currency: b.currency, amount: b.balance, is_negative: b.is_negative })),
        pending_escrow: pending.map((p) => ({
          currency: p.currency,
          amount: p.amount,
          payout_count: p.payoutCount,
          next_release_at: p.nextReleaseAt?.toISOString() ?? null,
        })),
      },
      links_count: linksCount,
    };
  }

  // ---------- Creator self-service (/v1/creators/me*) ----------

  async me(creator: Creator): Promise<CreatorMeDto> {
    const [ledger, pending] = await Promise.all([
      new LedgerService(this.deps.db).getBalance(creator.slug),
      this.deps.repo.pendingEscrow(creator.slug),
    ]);

    const byCurrency = new Map<string, CreatorBalanceDto>();
    const entry = (currency: string): CreatorBalanceDto => {
      let b = byCurrency.get(currency);
      if (!b) {
        b = { currency, available_cents: 0, pending_escrow_cents: 0, is_negative: false, next_release_at: null };
        byCurrency.set(currency, b);
      }
      return b;
    };
    entry(PRIMARY_CURRENCY);
    for (const l of ledger.balances) {
      const b = entry(l.currency);
      b.available_cents = Number(decimalToCents(l.balance));
      b.is_negative = b.available_cents < 0;
    }
    for (const p of pending) {
      const b = entry(p.currency);
      b.pending_escrow_cents = Number(decimalToCents(p.amount));
      b.next_release_at = p.nextReleaseAt?.toISOString() ?? null;
    }

    const balances = [...byCurrency.values()].sort((a, b) => a.currency.localeCompare(b.currency));
    return { creator: toCreatorProfileDto(creator), balance: byCurrency.get(PRIMARY_CURRENCY)!, balances };
  }

  async updateMe(creator: Creator, input: UpdateMeInput): Promise<CreatorProfileDto> {
    const patch: CreatorPatch = {};
    if (input.handle !== undefined) patch.handle = input.handle;
    if (input.name !== undefined) patch.name = input.name;
    if (input.spei_clabe !== undefined) {
      patch.speiClabe = input.spei_clabe;
      // Replacing an existing payout account starts the withdrawal cooling-off (see payouts.service).
      if (creator.speiClabe && input.spei_clabe !== creator.speiClabe) patch.speiClabeChangedAt = this.now();
    }
    if (input.bio !== undefined) patch.bio = input.bio;
    if (input.avatar_url !== undefined) patch.avatarUrl = input.avatar_url;
    if (input.instagram_handle !== undefined) patch.instagramHandle = input.instagram_handle;
    if (input.tiktok_handle !== undefined) patch.tiktokHandle = input.tiktok_handle;

    // WhatsApp consent is tied to a specific number: changing or removing the number
    // withdraws it, unless the same request opts in again for the new number.
    const phone = input.phone !== undefined ? input.phone : creator.phone;
    if (input.phone !== undefined) {
      patch.phone = input.phone;
      if (input.phone !== creator.phone) patch.whatsappOptInAt = null;
    }
    if (input.whatsapp_opt_in === true) {
      if (!phone) {
        throw new AppError(400, 'VALIDATION_ERROR', 'Invalid request.', {
          issues: [{ path: 'whatsapp_opt_in', message: 'Add a phone number before opting in to WhatsApp' }],
        });
      }
      patch.whatsappOptInAt = input.phone !== undefined && input.phone !== creator.phone ? this.now() : (creator.whatsappOptInAt ?? this.now());
    } else if (input.whatsapp_opt_in === false) {
      patch.whatsappOptInAt = null;
    }
    return toCreatorProfileDto(await this.deps.repo.updateCreator(creator.id, patch));
  }

  async myLinks(creator: Creator): Promise<{ data: CreatorLinkDto[] }> {
    const base = this.deps.publicLinkBaseUrl.replace(/\/+$/, '');
    const rows = await this.deps.repo.listCreatorLinks(creator.slug);
    return {
      data: rows.map(({ link, campaignStatus, productName, checkoutBaseUrl }) => ({
        id: link.id,
        campaign_id: link.campaignId,
        campaign_status: campaignStatus,
        link_slug: link.linkSlug,
        referral_url: `${base}/${link.linkSlug}`,
        product_name: productName,
        checkout_url: checkoutBaseUrl,
        custom_script: link.customScript,
        status: link.status,
        expires_at: link.expiresAt?.toISOString() ?? null,
        created_at: link.createdAt.toISOString(),
      })),
    };
  }

  /** The previous key stops working immediately. */
  async rotateMyApiKey(creator: Creator): Promise<{ api_key: string }> {
    const apiKey = generateCreatorApiKey();
    await this.deps.repo.setApiKeyHash(creator.id, hashApiKey(apiKey));
    return { api_key: apiKey };
  }

  // ---------- Seller-facing: links ----------

  /** Ownership-checked: another seller's campaign is a 404. */
  private async loadOwnedCampaign(sellerId: string, campaignId: string): Promise<{ campaign: Campaign; product: Product }> {
    const campaign = await this.deps.sellersRepo.findCampaign(sellerId, campaignId);
    if (!campaign) throw new AppError(404, 'CAMPAIGN_NOT_FOUND', 'Campaign not found.');
    const product = await this.deps.sellersRepo.findProduct(sellerId, campaign.productId);
    if (!product) throw new AppError(404, 'CAMPAIGN_NOT_FOUND', 'Campaign not found.');
    return { campaign, product };
  }

  async listLinks(sellerId: string, campaignId: string): Promise<{ data: LinkDto[] }> {
    const { campaign } = await this.loadOwnedCampaign(sellerId, campaignId);
    const rows = await this.deps.repo.listCampaignLinks(campaign.id);
    return { data: rows.map((l) => toLinkDto(l, this.deps.publicLinkBaseUrl)) };
  }

  async issueLink(sellerId: string, campaignId: string, input: CreateLinkInput): Promise<LinkIssuedDto> {
    const { repo, publicLinkBaseUrl } = this.deps;
    const { campaign, product } = await this.loadOwnedCampaign(sellerId, campaignId);
    if (campaign.status !== 'active') throw new AppError(409, 'CAMPAIGN_NOT_ACTIVE', 'Links can only be issued for active campaigns.');
    if (product.status !== 'active') throw new AppError(409, 'PRODUCT_NOT_ACTIVE', 'Links can only be issued for active products.');
    if (input.expires_at && input.expires_at.getTime() <= this.now().getTime()) {
      throw new AppError(400, 'VALIDATION_ERROR', 'Invalid request.', {
        issues: [{ path: 'expires_at', message: 'expires_at must be in the future' }],
      });
    }

    const creator = await repo.findCreatorBySlug(input.creator_slug);
    if (!creator) throw new AppError(404, 'CREATOR_NOT_FOUND', 'Creator not found.');
    if (creator.status !== 'active') throw new AppError(409, 'CREATOR_SUSPENDED', 'This creator is not accepting campaigns.');

    const existing = await repo.findLinkForCreator(campaign.id, creator.id);
    if (existing) throw this.linkExists(existing, publicLinkBaseUrl);

    if (input.link_slug && (await repo.linkSlugExists(input.link_slug))) {
      throw new AppError(409, 'LINK_SLUG_TAKEN', 'This link_slug is already in use.');
    }

    const base = linkSlugBase(creator.slug, product.name);
    const match = this.deps.matching.score(product.category, creator);

    for (let attempt = 0; attempt < MAX_LINK_SLUG_ATTEMPTS; attempt++) {
      const linkSlug = input.link_slug ?? (attempt === 0 ? base : `${base}-${randomSuffix()}`);
      if (!input.link_slug && attempt === 0 && (await repo.linkSlugExists(linkSlug))) continue;

      const script = await this.deps.scripts.generate({
        creator: { name: creator.name, handle: creator.handle, slug: creator.slug, niche: creator.niche },
        product: { name: product.name, category: product.category, price: product.price, currency: product.currency },
        linkUrl: `${publicLinkBaseUrl.replace(/\/+$/, '')}/${linkSlug}`,
      });

      try {
        const link = await repo.insertLink({
          campaignId: campaign.id,
          creatorId: creator.id,
          influencerSlug: creator.slug,
          linkSlug,
          customScript: script.full_text,
          status: 'active',
          expiresAt: input.expires_at ?? null,
        });
        return {
          link: toLinkDto(link, publicLinkBaseUrl),
          script,
          match: { score: match.score, breakdown: match.breakdown, reasons: match.reasons },
        };
      } catch (err) {
        // Concurrent request for the same creator+campaign won the race.
        if (isUniqueViolation(err, 'links_campaign_creator_unique')) {
          const winner = await repo.findLinkForCreator(campaign.id, creator.id);
          if (winner) throw this.linkExists(winner, publicLinkBaseUrl);
        }
        if (isUniqueViolation(err, 'links_link_slug_unique')) {
          if (input.link_slug) throw new AppError(409, 'LINK_SLUG_TAKEN', 'This link_slug is already in use.');
          continue;
        }
        throw err;
      }
    }
    throw new AppError(503, 'LINK_SLUG_EXHAUSTED', 'Could not allocate a unique link slug. Please retry.', undefined, {
      'Retry-After': '1',
    });
  }

  private linkExists(link: Parameters<typeof toLinkDto>[0], base: string): AppError {
    return new AppError(409, 'LINK_EXISTS', 'This creator already has a link for this campaign.', {
      link: toLinkDto(link, base),
    });
  }
}
