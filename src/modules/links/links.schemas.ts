import { z } from 'zod';

/** Link slugs are stored lowercase; accept any case from shared URLs. Invalid shapes are treated as unknown. */
export const LinkSlugParamsSchema = z.object({
  link_slug: z
    .string()
    .regex(/^[A-Za-z0-9][A-Za-z0-9-]{0,63}$/)
    .transform((s) => s.toLowerCase()),
});

/**
 * Public, buyer-facing view of a link. Contains nothing about the seller,
 * commissions, payouts or creator PII.
 */
export interface LinkPreviewDto {
  link_slug: string;
  creator: {
    name: string;
    /** Null for legacy links created before creator profiles existed. */
    handle: string | null;
  };
  product: {
    name: string;
    price: string;
    currency: string;
    category: string;
  };
  status: 'active';
}
