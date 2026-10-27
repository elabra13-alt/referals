import { createHash } from 'node:crypto';
import type { CreatorNiche } from '../../db/schema.js';
import { productNiche } from './matching.service.js';

/** Hook → Agitation → Solution → CTA (the "body" is agitation + solution). */
export interface VideoScript {
  hook: string;
  agitation: string;
  solution: string;
  cta: string;
  /** Ad disclosure; required for paid endorsements. */
  disclosure: string;
  full_text: string;
  /** Which generator produced it, e.g. "template-v1". */
  engine: string;
}

export interface ScriptContext {
  creator: { name: string; handle: string; slug: string; niche: CreatorNiche };
  product: { name: string; category: string; price: string; currency: string };
  linkUrl: string;
}

/** Port for script engines; the template engine is the default and an LLM engine can plug in later. */
export interface ScriptGenerator {
  generate(ctx: ScriptContext): Promise<VideoScript>;
}

/**
 * Structured prompt for an LLM-backed generator. Kept here so the contract
 * (sections, tone, constraints) lives next to the template engine it mirrors.
 */
export function buildScriptPrompt(ctx: ScriptContext): { system: string; user: string } {
  return {
    system: [
      'You write short-form vertical video scripts (TikTok/Reels, 30–45 seconds) for Mexican microinfluencers.',
      'Write in natural Mexican Spanish, first person, in the creator’s voice. No exaggerated or medical claims.',
      'Return JSON with keys: hook, agitation, solution, cta. Each 1–3 sentences.',
      'hook: stop the scroll in the first 3 seconds. agitation: the relatable problem.',
      'solution: how the product helps, from personal experience. cta: send viewers to the link, where an',
      'instant single-use discount code appears and auto-applies at checkout; it expires in 48 hours.',
    ].join(' '),
    user: JSON.stringify({
      creator: { name: ctx.creator.name, handle: ctx.creator.handle, niche: ctx.creator.niche },
      product: ctx.product,
      link_url: ctx.linkUrl,
    }),
  };
}

type Copy = { hooks: string[]; agitation: string; solution: string };

const COPY: Record<CreatorNiche, Copy> = {
  beauty: {
    hooks: [
      '¿Tu piel se ve apagada aunque ya probaste de todo? Espérame tantito.',
      'Esto cambió mi rutina de skincare y no me lo esperaba.',
      'Si tu rutina tiene 10 pasos y aun así no ves resultados, mira esto.',
    ],
    agitation: 'Yo gastaba un montón en productos que prometían milagros y al final terminaban olvidados en el cajón.',
    solution: 'Llevo unas semanas usando {product} y se nota: lo uso diario, es fácil de integrar y mi piel lo agradece.',
  },
  fashion: {
    hooks: [
      'El básico que me salvó todos los outfits de esta semana.',
      '¿Te pasa que tienes el clóset lleno y “nada que ponerte”?',
      'Pruébatelo conmigo: esto combina con literal todo.',
    ],
    agitation: 'Compraba prendas por impulso que no combinaban con nada y terminaba usando lo mismo de siempre.',
    solution: 'Con {product} armo looks distintos en minutos; se ve bien, es cómodo y lo uso un montón.',
  },
  electronics: {
    hooks: [
      'El gadget que no sabía que necesitaba hasta que lo probé.',
      'Deja de batallar con esto: te enseño lo que uso yo.',
      'Lo probé una semana completa y esto es lo que pienso.',
    ],
    agitation: 'Me desesperaba lidiar con cosas que fallan justo cuando más las necesitas.',
    solution: 'Desde que uso {product} todo es más simple: funciona bien, es práctico y lo traigo conmigo diario.',
  },
  home: {
    hooks: [
      'El cambio más fácil que hice en mi casa este mes.',
      'Si odias perder tiempo en el quehacer, esto es para ti.',
      'Mi casa se siente distinta desde que tengo esto.',
    ],
    agitation: 'Siempre sentía que el día no me alcanzaba y que la casa nunca se veía como yo quería.',
    solution: 'Con {product} me ahorro tiempo y mi espacio se ve y se siente mucho mejor.',
  },
  general: {
    hooks: [
      'Te tengo que contar de algo que estoy usando diario.',
      'No pensé recomendar esto, pero aquí estamos.',
      'Mi descubrimiento favorito de las últimas semanas.',
    ],
    agitation: 'Ya estaba cansado de probar cosas que no cumplían lo que prometían.',
    solution: '{product} sí me convenció: lo uso a diario y vale cada peso.',
  },
};

const CTA =
  'Entra a mi link {url} y te sale tu código de descuento al instante; se aplica solito al pagar. ' +
  'Ojo: solo dura 48 horas.';
/** Ad disclosure appended by Referals to every script, whatever engine wrote it. */
export const SCRIPT_DISCLOSURE = '#Publicidad #Colaboración';

/** Shared final layout, so every engine yields the same `full_text` structure and disclosure. */
export function assembleScript(
  parts: { hook: string; agitation: string; solution: string; cta: string },
  engine: string,
): VideoScript {
  const full_text = [
    `[HOOK] ${parts.hook}`,
    `[AGITACIÓN] ${parts.agitation}`,
    `[SOLUCIÓN] ${parts.solution}`,
    `[CTA] ${parts.cta}`,
    SCRIPT_DISCLOSURE,
  ].join('\n');
  return { ...parts, disclosure: SCRIPT_DISCLOSURE, full_text, engine };
}

function pickVariant(seed: string, count: number): number {
  return createHash('sha256').update(seed).digest()[0]! % count;
}

/** Deterministic, offline template engine in Mexican Spanish. */
export class TemplateScriptGenerator implements ScriptGenerator {
  async generate(ctx: ScriptContext): Promise<VideoScript> {
    // Copy follows the product's audience, not the creator's own niche.
    const copy = COPY[productNiche(ctx.product.category)];
    // Seeded per creator+product so two creators on one campaign get different hooks.
    const hook = copy.hooks[pickVariant(`${ctx.creator.slug}:${ctx.product.name}`, copy.hooks.length)]!;
    const agitation = copy.agitation;
    const solution = copy.solution.replaceAll('{product}', ctx.product.name);
    const cta = CTA.replaceAll('{url}', ctx.linkUrl);

    return assembleScript({ hook, agitation, solution, cta }, 'template-v1');
  }
}

export { GeminiScriptGenerator, type GeminiScriptGeneratorOptions } from './gemini-script-generator.js';
