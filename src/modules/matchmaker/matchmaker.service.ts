import type { Campaign, CampaignInvitation, Creator, InvitationStatus, Product } from '../../db/schema.js';
import { AppError } from '../../lib/errors.js';
import type { CreatorsRepository } from '../creators/creators.repository.js';
import { toCreatorPublicDto, type MatchDto, type MatchesQuery } from '../creators/creators.schemas.js';
import type { MatchingService, MatchResult } from '../creators/matching.service.js';
import type { SellersRepository } from '../sellers/sellers.repository.js';
import type { InvitationsRepository } from './invitations.repository.js';

/** Machine-readable reasons behind a score, for filter chips and analytics. */
export type MatchTag =
  | 'niche_match'
  | 'adjacent_audience'
  | 'generalist'
  | 'high_engagement'
  | 'micro_sweet_spot'
  | 'macro_reach'
  | 'nano_audience'
  | 'verified'
  | 'payout_ready';

export function matchTags(creator: Creator, match: MatchResult): MatchTag[] {
  const tags: MatchTag[] = [];
  if (match.breakdown.niche === 1) tags.push('niche_match');
  else if (creator.niche === 'general') tags.push('generalist');
  else if (match.breakdown.niche >= 0.3) tags.push('adjacent_audience');
  if (match.breakdown.engagement >= 0.75) tags.push('high_engagement');
  if (match.breakdown.reach === 1) tags.push('micro_sweet_spot');
  else if (creator.followersCount > 100_000) tags.push('macro_reach');
  else tags.push('nano_audience');
  if (creator.isVerified) tags.push('verified');
  if (creator.speiClabe) tags.push('payout_ready');
  return tags;
}

/** Short human summary stored on the invitation (fits varchar(255)). */
export function matchReasonText(match: MatchResult): string {
  return match.reasons.join(' · ').slice(0, 255);
}

export interface InvitationSummary {
  id: string;
  status: InvitationStatus;
  expires_at: string;
}

export interface MatchmakerDto extends MatchDto {
  tags: MatchTag[];
  /** Latest invitation to this creator for this campaign, if any. */
  invitation: InvitationSummary | null;
}

/** A pending invitation whose window has passed is reported as expired, even before it is persisted as such. */
export function effectiveStatus(invitation: Pick<CampaignInvitation, 'status' | 'expiresAt'>, now: Date): InvitationStatus {
  return invitation.status === 'pending' && invitation.expiresAt.getTime() <= now.getTime() ? 'expired' : invitation.status;
}

/**
 * Seller-side matchmaker: ranks active creators for one of the seller's campaigns
 * using the platform's single scoring engine (MatchingService: niche affinity,
 * engagement, reach), and annotates each with explainable tags and the
 * relationship so far (already linked, invitation status).
 */
export class MatchmakerService {
  constructor(
    private readonly deps: {
      sellersRepo: SellersRepository;
      creatorsRepo: CreatorsRepository;
      invitationsRepo: InvitationsRepository;
      matching: MatchingService;
      now?: () => Date;
    },
  ) {}

  now(): Date {
    return this.deps.now?.() ?? new Date();
  }

  /** Ownership-checked: another seller's campaign is a 404. */
  async loadOwnedCampaign(sellerId: string, campaignId: string): Promise<{ campaign: Campaign; product: Product }> {
    const campaign = await this.deps.sellersRepo.findCampaign(sellerId, campaignId);
    const product = campaign ? await this.deps.sellersRepo.findProduct(sellerId, campaign.productId) : null;
    if (!campaign || !product) throw new AppError(404, 'CAMPAIGN_NOT_FOUND', 'Campaign not found.');
    return { campaign, product };
  }

  score(product: Product, creator: Creator): MatchResult {
    return this.deps.matching.score(product.category, creator);
  }

  async rankCreators(sellerId: string, campaignId: string, query: MatchesQuery): Promise<{ campaign_id: string; data: MatchmakerDto[] }> {
    const { campaign, product } = await this.loadOwnedCampaign(sellerId, campaignId);
    const [candidates, linked, invitations] = await Promise.all([
      this.deps.creatorsRepo.listMatchCandidates({ niche: query.niche }),
      this.deps.creatorsRepo.linkedCreatorIds(campaign.id),
      this.deps.invitationsRepo.byCreatorForCampaign(campaign.id),
    ]);
    const now = this.now();
    const ranked = this.deps.matching.rank(product.category, candidates).slice(0, query.limit);
    return {
      campaign_id: campaign.id,
      data: ranked.map((c) => {
        const inv = invitations.get(c.id);
        return {
          creator: toCreatorPublicDto(c),
          score: c.match.score,
          breakdown: c.match.breakdown,
          reasons: c.match.reasons,
          tags: matchTags(c, c.match),
          already_linked: linked.has(c.id),
          invitation: inv ? { id: inv.id, status: effectiveStatus(inv, now), expires_at: inv.expiresAt.toISOString() } : null,
        };
      }),
    };
  }
}
