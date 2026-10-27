import type { Creator } from '../../db/schema.js';
import { AppError } from '../../lib/errors.js';
import { centsToDecimal, commissionCents, decimalToCents } from '../../lib/money.js';
import { toLinkDto, type LinkDto } from '../creators/creators.schemas.js';
import { escrowDaysForCategory } from '../webhooks/escrow.js';
import type { CatalogRepository, OpportunityRow, OpportunitySort } from './catalog.repository.js';
import type { CampaignEnrollment } from './enrollment.js';
import { catalogCategoryOf, type CatalogCategory, type HookSet, type HooksGenerator } from './hooks-generator.js';

export interface OpportunityDto {
  campaign_id: string;
  product: { id: string; name: string; price: string; currency: string; category: string };
  brand: { name: string };
  catalog_category: CatalogCategory;
  commission_rate: string;
  /** Creator commission on one sale at list price (actual payouts use the order's net total). */
  estimated_commission_per_sale: string;
  /** Natural days a payout stays in escrow for this product's category. */
  escrow_days: number;
  requires_verified_creator: boolean;
  /** False when the campaign is restricted to verified creators and the caller is not verified. */
  eligible: boolean;
  joined: boolean;
  link_slug: string | null;
}

export interface JoinResultDto {
  status: 'joined' | 'already_joined';
  campaign_id: string;
  link: LinkDto;
  storefront: { item_id: string; url: string };
  hooks: HookSet;
  commission_rate: string;
  estimated_commission_per_sale: string;
  escrow_days: number;
}

const notFound = () => new AppError(404, 'OPPORTUNITY_NOT_FOUND', 'This opportunity does not exist or is no longer open.');

/** Creator commission on one sale at list price (actual payouts use the order's net total). */
export const estimatedCommission = (price: string, rate: string) =>
  centsToDecimal(commissionCents(decimalToCents(price), rate));

/** Public storefront URL on the link domain, e.g. https://referals.mx/c/leo. */
export const storefrontUrl = (publicLinkBaseUrl: string, creatorSlug: string) =>
  `${new URL(publicLinkBaseUrl).origin}/c/${creatorSlug.toLowerCase()}`;

/**
 * Open Catalog: creators discover public campaigns and join them in one click.
 * A join is idempotent and atomic: the creator's referral link and their
 * storefront card are written in one transaction, so a join never leaves a
 * link without a storefront entry (or vice versa).
 */
export class CatalogService {
  constructor(
    private readonly deps: {
      repo: CatalogRepository;
      enrollment: CampaignEnrollment;
      hooks: HooksGenerator;
      publicLinkBaseUrl: string;
    },
  ) {}

  private toOpportunityDto(row: OpportunityRow, creator: Creator): OpportunityDto {
    return {
      campaign_id: row.campaignId,
      product: { id: row.productId, name: row.productName, price: row.price, currency: row.currency, category: row.category },
      brand: { name: row.brandName },
      catalog_category: catalogCategoryOf(row.category),
      commission_rate: row.commissionRate,
      estimated_commission_per_sale: estimatedCommission(row.price, row.commissionRate),
      escrow_days: escrowDaysForCategory(row.category),
      requires_verified_creator: row.requiresVerifiedCreator,
      eligible: !row.requiresVerifiedCreator || creator.isVerified,
      joined: row.joinedLinkSlug !== null,
      link_slug: row.joinedLinkSlug,
    };
  }

  async listOpportunities(
    creator: Creator,
    query: { category?: CatalogCategory | undefined; q?: string | undefined; sort: OpportunitySort; limit: number; offset: number },
  ): Promise<{ data: OpportunityDto[]; limit: number; offset: number }> {
    const rows = await this.deps.repo.listOpportunities({ creatorId: creator.id, ...query });
    return { data: rows.map((r) => this.toOpportunityDto(r, creator)), limit: query.limit, offset: query.offset };
  }

  async join(creator: Creator, campaignId: string): Promise<JoinResultDto> {
    const opp = await this.deps.repo.findOpenOpportunity(campaignId);
    if (!opp) throw notFound();
    if (opp.requiresVerifiedCreator && !creator.isVerified) {
      throw new AppError(403, 'VERIFIED_CREATOR_REQUIRED', 'This brand only works with verified creators.');
    }

    // Idempotent + atomic (link and storefront card in one transaction): see CampaignEnrollment.
    const enrolled = await this.deps.enrollment.enroll(creator, opp);
    return {
      status: enrolled.status,
      campaign_id: opp.campaignId,
      link: toLinkDto(enrolled.link, this.deps.publicLinkBaseUrl),
      storefront: { item_id: enrolled.storefrontItemId, url: storefrontUrl(this.deps.publicLinkBaseUrl, creator.slug) },
      hooks: this.deps.hooks.generate({ creatorSlug: creator.slug, productName: opp.productName, productCategory: opp.category }),
      commission_rate: opp.commissionRate,
      estimated_commission_per_sale: estimatedCommission(opp.price, opp.commissionRate),
      escrow_days: escrowDaysForCategory(opp.category),
    };
  }
}
