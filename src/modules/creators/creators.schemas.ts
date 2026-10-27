import { z } from 'zod';
import { CREATOR_NICHES, type Creator, type Link } from '../../db/schema.js';
import { isValidClabe, maskClabe } from '../../lib/clabe.js';
import { isE164, stripPhoneSeparators } from '../../lib/phone.js';
import { zFraction } from '../../lib/validation.js';
import type { MatchResult } from './matching.service.js';
import type { VideoScript } from './script-generator.service.js';

// ---------- Requests ----------

const CreatorName = z.string().trim().min(2).max(120);

/** Stored normalized as "@lowercase". */
const CreatorHandle = z
  .string()
  .trim()
  .regex(/^@?[A-Za-z0-9._]{2,30}$/, 'handle must be 2–30 letters, digits, dots or underscores')
  .transform((h) => `@${h.replace(/^@/, '').toLowerCase()}`);

/** Spaces/dashes are stripped, then the Banxico 3-7-1 check digit is verified. */
const SpeiClabe = z
  .string()
  .transform((v) => v.replace(/[\s-]/g, ''))
  .refine(isValidClabe, 'spei_clabe must be a valid 18-digit CLABE (check digit mismatch)');

export const RegisterCreatorSchema = z
  .object({
    name: CreatorName,
    handle: CreatorHandle,
    email: z.string().trim().toLowerCase().max(255).pipe(z.email()),
    niche: z.enum(CREATOR_NICHES),
    followers_count: z.number().int().min(0).max(1_000_000_000),
    engagement_rate: zFraction,
    /** Optional at signup; required before withdrawals. */
    spei_clabe: SpeiClabe.optional(),
    /** Defaults to one derived from the handle. Uppercase, 3–16 chars. */
    slug: z
      .string()
      .trim()
      .regex(/^[A-Za-z0-9]{3,16}$/, 'slug must be 3–16 letters or digits')
      .transform((s) => s.toUpperCase())
      .optional(),
  })
  .strict();

export const CreatorSlugParamsSchema = z.object({
  slug: z
    .string()
    .regex(/^[A-Za-z0-9]{3,16}$/)
    .transform((s) => s.toUpperCase()),
});

export const MatchesQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(50).default(10),
  niche: z.enum(CREATOR_NICHES).optional(),
});

export const CreateLinkSchema = z
  .object({
    creator_slug: z
      .string()
      .trim()
      .regex(/^[A-Za-z0-9]{3,16}$/)
      .transform((s) => s.toUpperCase()),
    /** Optional vanity slug; generated from creator + product otherwise. */
    link_slug: z
      .string()
      .trim()
      .toLowerCase()
      .regex(/^[a-z0-9][a-z0-9-]{2,63}$/, 'link_slug must be 3–64 lowercase letters, digits or dashes')
      .optional(),
    expires_at: z.iso
      .datetime({ offset: true })
      .transform((v) => new Date(v))
      .optional(),
  })
  .strict();

/** Self-service profile update. The slug is immutable: codes and ledger entries are keyed on it. */
/** Social handle stored as "@lowercase"; null clears it. */
const SocialHandle = z
  .string()
  .trim()
  .regex(/^@?[A-Za-z0-9._]{1,30}$/, 'must be 1–30 letters, digits, dots or underscores')
  .transform((h) => `@${h.replace(/^@/, '').toLowerCase()}`);

export const UpdateMeSchema = z
  .object({
    handle: CreatorHandle.optional(),
    name: CreatorName.optional(),
    spei_clabe: SpeiClabe.optional(),
    // Public storefront profile (/c/:slug). `is_verified` is platform-controlled and not accepted here.
    bio: z.string().trim().max(280).transform((v) => v || null).nullable().optional(),
    avatar_url: z
      .string()
      .trim()
      .max(500)
      .pipe(z.url({ protocol: /^https$/ }))
      .nullable()
      .optional(),
    instagram_handle: SocialHandle.nullable().optional(),
    tiktok_handle: SocialHandle.nullable().optional(),
    /** WhatsApp number in E.164 ("+52 55 1234 5678" is accepted and normalized). null removes it. */
    phone: z
      .string()
      .max(30)
      .transform(stripPhoneSeparators)
      .refine(isE164, 'phone must be in E.164 format, e.g. +525512345678')
      .nullable()
      .optional(),
    /** Consent to receive WhatsApp notifications (required by WhatsApp for business-initiated messages). */
    whatsapp_opt_in: z.boolean().optional(),
  })
  .strict()
  .refine((v) => Object.values(v).some((x) => x !== undefined), 'Provide at least one field to update');

export type RegisterCreatorInput = z.output<typeof RegisterCreatorSchema>;
export type UpdateMeInput = z.output<typeof UpdateMeSchema>;
export type MatchesQuery = z.output<typeof MatchesQuerySchema>;
export type CreateLinkInput = z.output<typeof CreateLinkSchema>;

// ---------- Responses ----------

/** What sellers may see about a creator: no email, no banking data. */
export interface CreatorPublicDto {
  slug: string;
  handle: string;
  name: string;
  niche: string;
  followers_count: number;
  engagement_rate: string;
  payout_ready: boolean;
}

export interface CreatorProfileDto extends CreatorPublicDto {
  id: string;
  email: string;
  spei_clabe_masked: string | null;
  status: string;
  bio: string | null;
  avatar_url: string | null;
  instagram_handle: string | null;
  tiktok_handle: string | null;
  is_verified: boolean;
  phone: string | null;
  whatsapp_opt_in: boolean;
  created_at: string;
}

/** Balance in integer minor units (cents) for one currency. */
export interface CreatorBalanceDto {
  currency: string;
  /** Released funds (ledger sum). Negative after a clawback on already-withdrawn funds. */
  available_cents: number;
  /** Attributed sales still inside their escrow window. */
  pending_escrow_cents: number;
  is_negative: boolean;
  next_release_at: string | null;
}

export interface CreatorMeDto {
  creator: CreatorProfileDto;
  /** Primary-currency (MXN) balance; zeros when there is no activity yet. */
  balance: CreatorBalanceDto;
  /** One entry per currency with activity (always includes MXN). */
  balances: CreatorBalanceDto[];
}

export interface CreatorLinkDto {
  id: string;
  campaign_id: string;
  campaign_status: string;
  link_slug: string;
  referral_url: string;
  product_name: string;
  checkout_url: string;
  custom_script: string | null;
  status: string;
  expires_at: string | null;
  created_at: string;
}

export interface LinkDto {
  id: string;
  campaign_id: string;
  creator_slug: string;
  link_slug: string;
  url: string;
  status: string;
  expires_at: string | null;
  created_at: string;
}

export interface MatchDto {
  creator: CreatorPublicDto;
  score: number;
  breakdown: MatchResult['breakdown'];
  reasons: string[];
  already_linked: boolean;
}

export interface LinkIssuedDto {
  link: LinkDto;
  script: VideoScript;
  match: Pick<MatchResult, 'score' | 'breakdown' | 'reasons'>;
}

export const toCreatorPublicDto = (c: Creator): CreatorPublicDto => ({
  slug: c.slug,
  handle: c.handle,
  name: c.name,
  niche: c.niche,
  followers_count: c.followersCount,
  engagement_rate: c.engagementRate,
  payout_ready: c.speiClabe !== null,
});

export const toCreatorProfileDto = (c: Creator): CreatorProfileDto => ({
  id: c.id,
  ...toCreatorPublicDto(c),
  email: c.email,
  spei_clabe_masked: c.speiClabe ? maskClabe(c.speiClabe) : null,
  status: c.status,
  bio: c.bio,
  avatar_url: c.avatarUrl,
  instagram_handle: c.instagramHandle,
  tiktok_handle: c.tiktokHandle,
  is_verified: c.isVerified,
  phone: c.phone,
  whatsapp_opt_in: c.whatsappOptInAt !== null,
  created_at: c.createdAt.toISOString(),
});

export const toLinkDto = (l: Link, publicLinkBaseUrl: string): LinkDto => ({
  id: l.id,
  campaign_id: l.campaignId,
  creator_slug: l.influencerSlug,
  link_slug: l.linkSlug,
  url: `${publicLinkBaseUrl.replace(/\/+$/, '')}/${l.linkSlug}`,
  status: l.status,
  expires_at: l.expiresAt?.toISOString() ?? null,
  created_at: l.createdAt.toISOString(),
});
