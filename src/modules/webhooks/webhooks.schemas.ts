import { z } from 'zod';
import { zMoneyCents } from '../../lib/validation.js';


const SellerOrderId = z.string().trim().min(1).max(128);
const Timestamp = z.iso.datetime({ offset: true }).transform((v) => new Date(v));

export const OrderPaidSchema = z
  .object({
    event: z.literal('order.paid'),
    seller_order_id: SellerOrderId,
    applied_discount_code: z
      .string()
      .trim()
      .toUpperCase()
      .max(64)
      .nullish()
      .transform((v) => v || null),
    currency: z.string().regex(/^[A-Z]{3}$/, 'currency must be an ISO 4217 code'),
    financials: z.object({
      gross_total: zMoneyCents,
      discount_total: zMoneyCents,
      net_total: zMoneyCents,
    }),
    customer: z
      .object({ email: z.string().trim().toLowerCase().max(255).pipe(z.email()).nullish() })
      .nullish(),
    timestamp: Timestamp,
  })
  .superRefine((p, ctx) => {
    if (p.financials.discount_total > p.financials.gross_total) {
      ctx.addIssue({ code: 'custom', path: ['financials', 'discount_total'], message: 'cannot exceed gross_total' });
    }
    if (p.financials.net_total > p.financials.gross_total) {
      ctx.addIssue({ code: 'custom', path: ['financials', 'net_total'], message: 'cannot exceed gross_total' });
    }
  });

export type OrderPaidPayload = z.infer<typeof OrderPaidSchema>;

export const OrderRefundedSchema = z.object({
  event: z.enum(['order.refunded', 'order.chargeback']),
  seller_order_id: SellerOrderId,
  reason: z.string().trim().max(500).nullish(),
  timestamp: Timestamp,
});

export type OrderRefundedPayload = z.infer<typeof OrderRefundedSchema>;
