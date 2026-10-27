import type { CodeStatus } from '../../db/schema.js';

export const ATTRIBUTION_GRACE_MS = 14 * 24 * 60 * 60 * 1000;

export interface AttributableCode {
  codeId: string;
  code: string;
  status: CodeStatus;
  expiresAt: Date;
  linkId: string;
  sellerId: string;
}

export type AttributionReason =
  | 'valid_code'
  | 'grace_window'
  | 'no_code'
  | 'code_not_found'
  | 'code_seller_mismatch'
  | 'code_already_used'
  | 'code_revoked'
  | 'code_expired';

export type AttributionDecision =
  | { attributed: true; reason: 'valid_code' | 'grace_window' }
  | { attributed: false; reason: Exclude<AttributionReason, 'valid_code' | 'grace_window'> };

/**
 * Deterministic attribution: the single-use code is the proof. A code past
 * `expires_at` still attributes while `orderedAt - expires_at <= 14 days`.
 */
export function decideAttribution(params: {
  submittedCode: string | null;
  code: AttributableCode | null;
  sellerId: string;
  orderedAt: Date;
}): AttributionDecision {
  const { submittedCode, code, sellerId, orderedAt } = params;
  if (!submittedCode) return { attributed: false, reason: 'no_code' };
  if (!code) return { attributed: false, reason: 'code_not_found' };
  // A seller must never be able to trigger payouts on another seller's codes.
  if (code.sellerId !== sellerId) return { attributed: false, reason: 'code_seller_mismatch' };
  if (code.status === 'applied') return { attributed: false, reason: 'code_already_used' };
  if (code.status === 'revoked') return { attributed: false, reason: 'code_revoked' };

  const msPastExpiry = orderedAt.getTime() - code.expiresAt.getTime();
  if (msPastExpiry <= 0) return { attributed: true, reason: 'valid_code' };
  if (msPastExpiry <= ATTRIBUTION_GRACE_MS) return { attributed: true, reason: 'grace_window' };
  return { attributed: false, reason: 'code_expired' };
}
