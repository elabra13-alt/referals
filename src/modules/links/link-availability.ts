import { AppError } from '../../lib/errors.js';

export type LinkAvailability = 'active' | 'link_paused' | 'link_expired' | 'campaign_inactive' | 'product_inactive';

export interface LinkStateInput {
  linkStatus: string;
  linkExpiresAt: Date | null;
  campaignStatus: string;
  productStatus: string;
}

/**
 * Single source of truth for "can buyers use this link right now?", shared by
 * the landing page, the preview API and code issuance.
 */
export function assessLinkAvailability(link: LinkStateInput, now: Date): LinkAvailability {
  if (link.productStatus !== 'active') return 'product_inactive';
  if (link.campaignStatus !== 'active') return 'campaign_inactive';
  if (link.linkStatus !== 'active') return 'link_paused';
  if (link.linkExpiresAt !== null && link.linkExpiresAt.getTime() <= now.getTime()) return 'link_expired';
  return 'active';
}

/** 410 Gone carrying the specific reason in `details.status`. */
export function linkInactiveError(status: Exclude<LinkAvailability, 'active'>): AppError {
  return new AppError(410, 'LINK_INACTIVE', 'This promotion is no longer available.', { status });
}

export const linkNotFoundError = () => new AppError(404, 'LINK_NOT_FOUND', 'This referral link does not exist.');
