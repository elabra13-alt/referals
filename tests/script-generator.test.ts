import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app.js';
import type { Database } from '../src/db/client.js';
import {
  DEFAULT_GEMINI_MODEL,
  extractJsonText,
  parseScriptSections,
} from '../src/modules/creators/gemini-script-generator.js';
import {
  GeminiScriptGenerator,
  SCRIPT_DISCLOSURE,
  TemplateScriptGenerator,
  type ScriptContext,
} from '../src/modules/creators/script-generator.service.js';
import { TEST_ENCRYPTION_KEY, createTestDb, createTestRedis, seedAuthenticatedSeller, seedCreator } from './helpers.js';

const API_KEY = 'AIzaSy-test-key-do-not-log';
const LINK = 'https://referals.mx/r/leo-glow-serum';

const ctx: ScriptContext = {
  creator: { name: 'Leo Mendez', handle: '@soyleomx', slug: 'LEO', niche: 'beauty' },
  product: { name: 'Glow Serum', category: 'beauty', price: '499.00', currency: 'MXN' },
  linkUrl: LINK,
};

const sections = {
  hook: '¿Tu piel se ve cansada? Mira esto.',
  agitation: 'Probé mil cremas y nada me funcionaba.',
  solution: 'Glow Serum me dejó la piel luminosa en dos semanas.',
  cta: `Entra a ${LINK} y llévate tu código al instante.`,
};

/** A Gemini generateContent response carrying `text` in its first candidate. */
const geminiBody = (text: string, extra: Record<string, unknown> = {}) => ({
  candidates: [{ content: { role: 'model', parts: [{ text }] }, finishReason: 'STOP', index: 0 }],
  usageMetadata: { promptTokenCount: 200, candidatesTokenCount: 120 },
  ...extra,
});

function fakeFetch(respond: () => Response | Promise<Response>) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fn = vi.fn(async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return respond();
  }) as unknown as typeof fetch;
  return { fn, calls };
}

const jsonResponse = (body: unknown, status = 200) => () => Response.json(body, { status });
const templateFor = (c: ScriptContext) => new TemplateScriptGenerator().generate(c);

describe('GeminiScriptGenerator', () => {
  const makeGenerator = (fetchImpl: typeof fetch, opts: { apiKey?: string | undefined } = { apiKey: API_KEY }) => {
    const log = { warn: vi.fn() };
    const gen = new GeminiScriptGenerator({ apiKey: opts.apiKey, fetch: fetchImpl, log });
    return { gen, log };
  };

  describe('successful generation', () => {
    it('calls Gemini in JSON mode and assembles the script from its JSON', async () => {
      const { fn, calls } = fakeFetch(jsonResponse(geminiBody(JSON.stringify(sections))));
      const { gen, log } = makeGenerator(fn);

      const script = await gen.generate(ctx);

      expect(script).toEqual({
        ...sections,
        disclosure: SCRIPT_DISCLOSURE,
        engine: `gemini:${DEFAULT_GEMINI_MODEL}`,
        full_text: [
          `[HOOK] ${sections.hook}`,
          `[AGITACIÓN] ${sections.agitation}`,
          `[SOLUCIÓN] ${sections.solution}`,
          `[CTA] ${sections.cta}`,
          SCRIPT_DISCLOSURE,
        ].join('\n'),
      });
      expect(log.warn).not.toHaveBeenCalled();

      const { url, init } = calls[0]!;
      expect(url).toBe(`https://generativelanguage.googleapis.com/v1beta/models/${DEFAULT_GEMINI_MODEL}:generateContent`);
      expect(url).not.toContain(API_KEY);
      expect((init.headers as Record<string, string>)['x-goog-api-key']).toBe(API_KEY);

      const payload = JSON.parse(init.body as string);
      expect(payload.contents).toHaveLength(1);
      expect(payload.contents[0].role).toBe('user');
      const text: string = payload.contents[0].parts[0].text;
      expect(text).toMatch(/^You write short-form vertical video scripts/);
      expect(text).toContain('\n\nContext:\n');
      expect(JSON.parse(text.split('\n\nContext:\n')[1]!)).toMatchObject({ product: { name: 'Glow Serum' }, link_url: LINK });
      expect(payload.generationConfig).toMatchObject({
        responseMimeType: 'application/json',
        temperature: 0.7,
        responseSchema: { type: 'OBJECT', required: ['hook', 'agitation', 'solution', 'cta'] },
      });
    });

    it('honours a configured model', async () => {
      const { fn, calls } = fakeFetch(jsonResponse(geminiBody(JSON.stringify(sections))));
      const script = await new GeminiScriptGenerator({ apiKey: API_KEY, model: 'gemini-flash-latest', fetch: fn }).generate(ctx);
      expect(calls[0]!.url).toContain('/models/gemini-flash-latest:generateContent');
      expect(script.engine).toBe('gemini:gemini-flash-latest');
    });

    it('strips markdown code fences and surrounding prose', async () => {
      const wrapped = `Claro, aquí está tu guion:\n\`\`\`json\n${JSON.stringify(sections, null, 2)}\n\`\`\`\n¡Éxito!`;
      const { fn } = fakeFetch(jsonResponse(geminiBody(wrapped)));
      const script = await makeGenerator(fn).gen.generate(ctx);
      expect(script.engine).toMatch(/^gemini:/);
      expect(script.hook).toBe(sections.hook);
    });

    it('unwraps a single script object the model wrapped in an array', async () => {
      const { fn } = fakeFetch(jsonResponse(geminiBody(JSON.stringify([sections]))));
      const script = await makeGenerator(fn).gen.generate(ctx);
      expect(script.engine).toMatch(/^gemini:/);
      expect(script.hook).toBe(sections.hook);
    });

    it('joins multi-part candidates', async () => {
      const json = JSON.stringify(sections);
      const body = { candidates: [{ content: { parts: [{ text: json.slice(0, 40) }, { text: json.slice(40) }] }, finishReason: 'STOP' }] };
      const { fn } = fakeFetch(jsonResponse(body));
      expect((await makeGenerator(fn).gen.generate(ctx)).cta).toBe(sections.cta);
    });

    it('always appends the Referals ad disclosure, whatever the model returns', async () => {
      const sneaky = { ...sections, disclosure: '', solution: 'Glow Serum es increíble. (no es publicidad)' };
      const { fn } = fakeFetch(jsonResponse(geminiBody(JSON.stringify(sneaky))));
      const script = await makeGenerator(fn).gen.generate(ctx);
      expect(script.disclosure).toBe('#Publicidad #Colaboración');
      expect(script.full_text.endsWith('\n#Publicidad #Colaboración')).toBe(true);
    });

    it('re-inserts the referral link when the model leaves it out of the CTA', async () => {
      const noLink = { ...sections, cta: 'Corre por tu código antes de que se acabe.' };
      const { fn } = fakeFetch(jsonResponse(geminiBody(JSON.stringify(noLink))));
      const script = await makeGenerator(fn).gen.generate(ctx);
      expect(script.cta).toBe(`Corre por tu código antes de que se acabe. ${LINK}`);
    });
  });

  describe('resilient fallback to the template', () => {
    it('uses the template without calling Gemini when no API key is configured', async () => {
      const { fn } = fakeFetch(jsonResponse(geminiBody(JSON.stringify(sections))));
      const { gen, log } = makeGenerator(fn, { apiKey: undefined });
      expect(await gen.generate(ctx)).toEqual(await templateFor(ctx));
      expect(fn).not.toHaveBeenCalled();
      expect(log.warn).not.toHaveBeenCalled();
    });

    const failures: [string, () => Response | Promise<Response>, string][] = [
      ['a network error', () => Promise.reject(new TypeError('fetch failed')), 'network'],
      ['a timeout', () => Promise.reject(new DOMException('The operation was aborted due to timeout', 'TimeoutError')), 'network'],
      ['HTTP 429 (quota)', jsonResponse({ error: { code: 429, message: 'Resource exhausted' } }, 429), 'http_error'],
      ['HTTP 404 (retired model)', jsonResponse({ error: { code: 404, message: 'models/gemini-1.5-flash is not found' } }, 404), 'http_error'],
      ['a non-JSON response body', () => new Response('<html>Bad Gateway</html>', { status: 200 }), 'malformed_json'],
      ['a blocked prompt', jsonResponse({ promptFeedback: { blockReason: 'SAFETY' } }), 'blocked'],
      ['a safety stop', jsonResponse({ candidates: [{ content: { parts: [{ text: '{' }] }, finishReason: 'SAFETY' }] }), 'blocked'],
      ['a truncated answer (MAX_TOKENS)', jsonResponse({ candidates: [{ content: { parts: [{ text: '{"hook":"Hola' }] }, finishReason: 'MAX_TOKENS' }] }), 'blocked'],
      ['no candidates', jsonResponse({ candidates: [] }), 'empty_response'],
      ['model text that is not JSON', jsonResponse(geminiBody('Lo siento, no puedo ayudar con eso.')), 'malformed_json'],
      ['JSON missing a section', jsonResponse(geminiBody(JSON.stringify({ hook: 'a', agitation: 'b', solution: 'c' }))), 'invalid_shape'],
      ['a non-string section', jsonResponse(geminiBody(JSON.stringify({ ...sections, cta: 42 }))), 'invalid_shape'],
      ['a bare JSON string', jsonResponse(geminiBody(JSON.stringify('solo texto'))), 'invalid_shape'],
      ['two JSON objects', jsonResponse(geminiBody(JSON.stringify([sections, sections]))), 'malformed_json'],
      ['a runaway section', jsonResponse(geminiBody(JSON.stringify({ ...sections, solution: 'x'.repeat(601) }))), 'invalid_shape'],
    ];

    it.each(failures)('falls back on %s and logs the reason', async (_label, respond, reason) => {
      const { fn } = fakeFetch(respond);
      const { gen, log } = makeGenerator(fn);

      const script = await gen.generate(ctx);

      expect(script).toEqual(await templateFor(ctx));
      expect(script.engine).toBe('template-v1');
      expect(script.disclosure).toBe(SCRIPT_DISCLOSURE);
      expect(log.warn).toHaveBeenCalledTimes(1);
      expect(log.warn.mock.calls[0]![0]).toMatchObject({ reason, model: DEFAULT_GEMINI_MODEL });
      expect(JSON.stringify(log.warn.mock.calls[0])).not.toContain(API_KEY);
    });

    it('uses a custom fallback generator when provided', async () => {
      const { fn } = fakeFetch(() => Promise.reject(new Error('down')));
      const fallback = { generate: vi.fn(async () => ({ ...(await templateFor(ctx)), engine: 'custom' })) };
      const script = await new GeminiScriptGenerator({ apiKey: API_KEY, fetch: fn, fallback }).generate(ctx);
      expect(script.engine).toBe('custom');
    });
  });

  describe('parsing helpers', () => {
    it('extracts the JSON object from fenced or chatty output', () => {
      expect(extractJsonText('```json\n{"a":1}\n```')).toBe('{"a":1}');
      expect(extractJsonText('```\n{"a":1}\n```')).toBe('{"a":1}');
      expect(extractJsonText('Aquí va: {"a":1} ¡listo!')).toBe('{"a":1}');
      expect(extractJsonText('{"a":1}')).toBe('{"a":1}');
    });

    it('normalizes whitespace in sections', () => {
      const parsed = parseScriptSections(JSON.stringify({ ...sections, hook: '  ¿Tu piel\n  se ve   cansada?  ' }), LINK);
      expect(parsed.hook).toBe('¿Tu piel se ve cansada?');
    });
  });
});

describe('app wiring: link issuance with Gemini', () => {
  let db: Database;
  let closeDb: () => Promise<void>;
  let app: FastifyInstance;

  const issueLink = async () => {
    const alice = await seedAuthenticatedSeller(db);
    await seedCreator(db, { slug: 'LEO' });
    const product = await app.inject({
      method: 'POST',
      url: '/v1/products',
      headers: alice.authHeaders,
      payload: { name: 'Glow Serum', price: 499, margin: 150, checkout_base_url: 'https://shop.example.mx/checkout', category: 'beauty' },
    });
    const campaign = await app.inject({
      method: 'POST',
      url: '/v1/campaigns',
      headers: alice.authHeaders,
      payload: { product_id: product.json().id, commission_rate: 0.15 },
    });
    return app.inject({
      method: 'POST',
      url: `/v1/campaigns/${campaign.json().id}/links`,
      headers: alice.authHeaders,
      payload: { creator_slug: 'LEO' },
    });
  };

  const build = async (geminiApiKey?: string) => {
    app = buildApp(
      { db, redis: await createTestRedis(), webhookEncryptionKey: TEST_ENCRYPTION_KEY, geminiApiKey, publicLinkBaseUrl: 'https://referals.mx/r' },
      { logger: false },
    );
  };

  beforeEach(async () => {
    ({ db, close: closeDb } = await createTestDb());
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    await app.close();
    await closeDb();
  });

  it('writes the script with Gemini when GEMINI_API_KEY is set', async () => {
    const fetchSpy = vi.fn(async () => Response.json(geminiBody(JSON.stringify(sections))));
    vi.stubGlobal('fetch', fetchSpy);
    await build(API_KEY);

    const res = await issueLink();
    expect(res.statusCode).toBe(201);
    expect(res.json().script).toMatchObject({ engine: `gemini:${DEFAULT_GEMINI_MODEL}`, hook: sections.hook });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('still issues the link with the template when Gemini is down', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ error: { message: 'unavailable' } }, { status: 503 })));
    await build(API_KEY);

    const res = await issueLink();
    expect(res.statusCode).toBe(201);
    expect(res.json().script.engine).toBe('template-v1');
  });

  it('uses the template (and never calls out) without an API key', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    await build(undefined);

    const res = await issueLink();
    expect(res.json().script.engine).toBe('template-v1');
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
