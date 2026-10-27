import { z } from 'zod';

const E164 = /^\+[1-9]\d{7,14}$/;

export const CodeRequestBodySchema = z
  .object({
    link_slug: z
      .string()
      .trim()
      .min(1)
      .max(64)
      .regex(/^[a-z0-9][a-z0-9-]*$/i, 'link_slug must be alphanumeric with dashes')
      // Link slugs are stored lowercase; shared/typed URLs may not be.
      .toLowerCase(),
    buyer: z.object({
      email: z
        .string()
        .trim()
        .toLowerCase()
        .max(255)
        .pipe(z.email())
        .nullish()
        .transform((v) => v ?? null),
      phone: z
        .string()
        .transform((v) => v.replace(/[\s\-().]/g, ''))
        .pipe(z.string().regex(E164, 'phone must be in E.164 format, e.g. +5215512345678'))
        .nullish()
        .transform((v) => v ?? null),
      send_whatsapp_backup: z.boolean().default(false),
    }),
    client_context: z
      .object({
        fingerprint: z.string().max(128).optional(),
        user_agent: z.string().max(512).optional(),
        ip_address: z.union([z.ipv4(), z.ipv6()]).optional(),
      })
      .optional(),
  })
  .superRefine((body, ctx) => {
    if (!body.buyer.email && !body.buyer.phone) {
      ctx.addIssue({ code: 'custom', path: ['buyer'], message: 'Provide at least one of buyer.email or buyer.phone' });
    }
    if (body.buyer.send_whatsapp_backup && !body.buyer.phone) {
      ctx.addIssue({
        code: 'custom',
        path: ['buyer', 'phone'],
        message: 'buyer.phone is required when send_whatsapp_backup is true',
      });
    }
  });

export type CodeRequestBody = z.infer<typeof CodeRequestBodySchema>;

/** Shape returned for both a freshly issued code (201) and an existing one (409). */
export interface IssuedCodeDto {
  code: string;
  status: string;
  issued_at: string;
  expires_at: string;
  auto_apply_url: string;
}
