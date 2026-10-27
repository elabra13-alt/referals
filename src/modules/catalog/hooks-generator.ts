import { createHash } from 'node:crypto';
import { SCRIPT_DISCLOSURE } from '../creators/script-generator.service.js';

/**
 * Structured TikTok/Reels opening hooks for a product the creator just joined:
 * always three, one per proven angle, so creators can test which one their
 * audience responds to.
 *
 *   problema    — name the pain point the viewer already feels
 *   prueba      — personal before/after, in the creator's own voice
 *   oferta      — exclusive, time-boxed code (the 48h single-use coupon)
 *
 * Deterministic and offline (no LLM call on the join path): the same creator +
 * product always gets the same hooks. Copy is Mexican Spanish, avoids
 * medical/absolute claims, and never states a discount percentage, which
 * Referrals doesn't know for every store.
 */

export const CATALOG_CATEGORIES = ['beauty_skincare', 'fashion', 'electronics', 'general'] as const;
export type CatalogCategory = (typeof CATALOG_CATEGORIES)[number];

export type HookAngle = 'problema' | 'prueba' | 'oferta';

export interface StructuredHook {
  angle: HookAngle;
  /** What the creator says in the first ~3 seconds. */
  hook: string;
  /** Short on-screen caption to overlay while saying it. */
  on_screen_text: string;
}

export interface HookSet {
  category: CatalogCategory;
  hooks: [StructuredHook, StructuredHook, StructuredHook];
  /** Paid-partnership disclosure the creator must include. */
  disclosure: string;
  /** Delivery guidance shown with the hooks. */
  tip: string;
}

/** Product categories (escrow vocabulary) → catalog buckets. Unknown categories fall into `general`. */
const CATEGORY_TO_BUCKET: Readonly<Record<string, CatalogCategory>> = {
  beauty: 'beauty_skincare',
  skincare: 'beauty_skincare',
  consumables: 'beauty_skincare',
  fashion: 'fashion',
  footwear: 'fashion',
  apparel: 'fashion',
  electronics: 'electronics',
  audio: 'electronics',
};

export function catalogCategoryOf(productCategory: string): CatalogCategory {
  return CATEGORY_TO_BUCKET[productCategory.trim().toLowerCase()] ?? 'general';
}

/** Product categories that belong to a bucket (`general` = anything not mapped elsewhere). */
export function productCategoriesFor(bucket: Exclude<CatalogCategory, 'general'>): string[] {
  return Object.entries(CATEGORY_TO_BUCKET)
    .filter(([, b]) => b === bucket)
    .map(([c]) => c);
}
export const MAPPED_PRODUCT_CATEGORIES = Object.keys(CATEGORY_TO_BUCKET);

type Variant = { hook: string; on_screen_text: string };
type AngleCopy = Record<HookAngle, Variant[]>;

const COPY: Record<CatalogCategory, AngleCopy> = {
  beauty_skincare: {
    problema: [
      { hook: '¿Tu piel se ve cansada aunque duermas bien? No eres la única.', on_screen_text: 'Piel apagada = esto 👇' },
      { hook: 'Si tu rutina tiene diez pasos y aun así no ves cambios, esto es para ti.', on_screen_text: 'Menos pasos, más resultado' },
    ],
    prueba: [
      { hook: 'Llevo semanas usando {product} y esto es lo que noté en mi piel.', on_screen_text: 'Mi experiencia real con {product}' },
      { hook: 'Te enseño cómo uso {product} en mi rutina de la mañana.', on_screen_text: 'Rutina AM con {product}' },
    ],
    oferta: [
      { hook: 'Conseguí un código exclusivo para {product}, pero solo dura 48 horas.', on_screen_text: 'Código exclusivo · 48 h' },
      { hook: 'Antes de comprar {product} en otro lado, usa mi link: tu código sale al instante.', on_screen_text: 'Tu código al instante 🔗' },
    ],
  },
  fashion: {
    problema: [
      { hook: '¿Clóset lleno y nada que ponerte? Te entiendo perfecto.', on_screen_text: '“No tengo qué ponerme”' },
      { hook: 'Si compras ropa que luego nunca combinas, mira esto antes.', on_screen_text: 'Compra que sí combina' },
    ],
    prueba: [
      { hook: 'Armé tres outfits distintos con {product}. Mira cómo quedó.', on_screen_text: '3 looks · 1 prenda' },
      { hook: 'Me puse {product} toda la semana y esto pasó.', on_screen_text: '7 días con {product}' },
    ],
    oferta: [
      { hook: 'Tengo un código exclusivo para {product} que vence en 48 horas.', on_screen_text: 'Código exclusivo · 48 h' },
      { hook: 'Si te gustó {product}, en mi link te sale tu código al instante.', on_screen_text: 'Link en mi perfil 🔗' },
    ],
  },
  electronics: {
    problema: [
      { hook: 'Si tu gadget te falla justo cuando más lo necesitas, sigue viendo.', on_screen_text: '¿Te ha pasado?' },
      { hook: 'Gasté de más en cosas que no duraban. Esto sí lo uso diario.', on_screen_text: 'Lo que sí vale la pena' },
    ],
    prueba: [
      { hook: 'Probé {product} una semana completa: lo bueno y lo no tan bueno.', on_screen_text: 'Review honesto: {product}' },
      { hook: 'Así se ve {product} en mi día a día, sin filtros.', on_screen_text: '{product} en uso real' },
    ],
    oferta: [
      { hook: 'Antes de comprar {product}, usa mi código: solo dura 48 horas.', on_screen_text: 'Código exclusivo · 48 h' },
      { hook: 'Desbloqueé un código para {product}; lo obtienes al instante en mi link.', on_screen_text: 'Tu código al instante 🔗' },
    ],
  },
  general: {
    problema: [
      { hook: 'Si esto te pasa seguido, te va a servir lo que te voy a enseñar.', on_screen_text: '¿Te suena?' },
      { hook: 'Esto me hizo la vida más fácil y casi nadie lo conoce.', on_screen_text: 'Mi descubrimiento' },
    ],
    prueba: [
      { hook: 'Llevo semanas usando {product} y te cuento si vale la pena.', on_screen_text: '¿Vale la pena {product}?' },
      { hook: 'Te muestro cómo uso {product} todos los días.', on_screen_text: 'Mi día con {product}' },
    ],
    oferta: [
      { hook: 'Tengo un código exclusivo para {product}, pero vence en 48 horas.', on_screen_text: 'Código exclusivo · 48 h' },
      { hook: 'En mi link te sale tu código para {product} al instante.', on_screen_text: 'Tu código al instante 🔗' },
    ],
  },
};

const ANGLES: HookAngle[] = ['problema', 'prueba', 'oferta'];

function pick<T>(options: T[], seed: string): T {
  return options[createHash('sha256').update(seed).digest()[0]! % options.length]!;
}

export class HooksGenerator {
  generate(input: { creatorSlug: string; productName: string; productCategory: string }): HookSet {
    const category = catalogCategoryOf(input.productCategory);
    const fill = (s: string) => s.replaceAll('{product}', input.productName);
    const hooks = ANGLES.map((angle) => {
      const v = pick(COPY[category][angle], `${input.creatorSlug}:${input.productName}:${angle}`);
      return { angle, hook: fill(v.hook), on_screen_text: fill(v.on_screen_text) };
    }) as HookSet['hooks'];
    return {
      category,
      hooks,
      disclosure: SCRIPT_DISCLOSURE,
      tip: 'Di el hook en los primeros 3 segundos, mirando a cámara, antes de mostrar el producto.',
    };
  }
}
