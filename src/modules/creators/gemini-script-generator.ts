import type { FastifyBaseLogger } from 'fastify';
import {
  TemplateScriptGenerator,
  assembleScript,
  buildScriptPrompt,
  type ScriptContext,
  type ScriptGenerator,
  type VideoScript,
} from './script-generator.service.js';

/**
 * Gemini 1.5 and 2.0 models are shut down; this is a current stable Flash model.
 * Override with GEMINI_MODEL (e.g. "gemini-flash-latest" to track Google's alias).
 */
export const DEFAULT_GEMINI_MODEL = 'gemini-3.8-flash';
const GEMINI_API_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';
const DEFAULT_TIMEOUT_MS = 10_000;
/** Short-form video sections; anything longer is a malformed or runaway answer. */
const MAX_SECTION_CHARS = 600;

const SECTIONS = ['hook', 'agitation', 'solution', 'cta'] as const;
type Sections = Record<(typeof SECTIONS)[number], string>;

/** Structured output: Gemini must return exactly these four string fields. */
const RESPONSE_SCHEMA = {
  type: 'OBJECT',
  properties: Object.fromEntries(SECTIONS.map((s) => [s, { type: 'STRING' }])),
  required: [...SECTIONS],
  propertyOrdering: [...SECTIONS],
};

export type GeminiFailureReason =
  | 'network'
  | 'http_error'
  | 'blocked'
  | 'empty_response'
  | 'malformed_json'
  | 'invalid_shape';

export class GeminiScriptError extends Error {
  constructor(
    readonly reason: GeminiFailureReason,
    message: string,
  ) {
    super(message);
    this.name = 'GeminiScriptError';
  }
}

/** Strips ```json fences / surrounding prose and returns the outermost JSON object text. */
export function extractJsonText(text: string): string {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  const candidate = (fenced ? fenced[1]! : text).trim();
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  return start !== -1 && end > start ? candidate.slice(start, end + 1) : candidate;
}

/**
 * Validates the model's JSON into script sections. The referral link is
 * mandatory in the CTA, so it is appended if the model dropped it.
 */
export function parseScriptSections(text: string, linkUrl: string): Sections {
  let data: unknown;
  try {
    data = JSON.parse(extractJsonText(text));
  } catch {
    throw new GeminiScriptError('malformed_json', 'Gemini returned text that is not JSON');
  }
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    throw new GeminiScriptError('invalid_shape', 'Gemini JSON is not an object');
  }

  const record = data as Record<string, unknown>;
  const sections = {} as Sections;
  for (const key of SECTIONS) {
    const value = record[key];
    if (typeof value !== 'string' || !value.trim()) {
      throw new GeminiScriptError('invalid_shape', `Gemini JSON is missing "${key}"`);
    }
    const clean = value.replace(/\s+/g, ' ').trim();
    if (clean.length > MAX_SECTION_CHARS) {
      throw new GeminiScriptError('invalid_shape', `Gemini "${key}" exceeds ${MAX_SECTION_CHARS} chars`);
    }
    sections[key] = clean;
  }
  if (!sections.cta.includes(linkUrl)) sections.cta = `${sections.cta} ${linkUrl}`;
  return sections;
}

export interface GeminiScriptGeneratorOptions {
  /** Without a key every call goes straight to the fallback. */
  apiKey?: string | undefined;
  model?: string | undefined;
  timeoutMs?: number;
  temperature?: number;
  fetch?: typeof fetch;
  /** Used whenever Gemini is unavailable or its answer is unusable. Defaults to the template engine. */
  fallback?: ScriptGenerator;
  log?: Pick<FastifyBaseLogger, 'warn'>;
}

/**
 * Live AI scripts via the Gemini REST API (JSON output mode), with a resilient
 * fallback: link issuance never fails because of the LLM. `engine` records
 * which generator actually produced each script ("gemini:<model>" or "template-v1").
 */
export class GeminiScriptGenerator implements ScriptGenerator {
  readonly model: string;
  private readonly fallback: ScriptGenerator;

  constructor(private readonly opts: GeminiScriptGeneratorOptions = {}) {
    this.model = opts.model ?? DEFAULT_GEMINI_MODEL;
    this.fallback = opts.fallback ?? new TemplateScriptGenerator();
  }

  async generate(ctx: ScriptContext): Promise<VideoScript> {
    if (!this.opts.apiKey) return this.fallback.generate(ctx);
    try {
      const sections = parseScriptSections(await this.callGemini(ctx, this.opts.apiKey), ctx.linkUrl);
      return assembleScript(sections, `gemini:${this.model}`);
    } catch (err) {
      const reason = err instanceof GeminiScriptError ? err.reason : 'network';
      // Message only: never log request details (they carry the API key header).
      this.opts.log?.warn(
        { reason, model: this.model, error: (err as Error).message, creator: ctx.creator.slug },
        'gemini script generation failed; using template fallback',
      );
      return this.fallback.generate(ctx);
    }
  }

  private async callGemini(ctx: ScriptContext, apiKey: string): Promise<string> {
    const prompt = buildScriptPrompt(ctx);
    const doFetch = this.opts.fetch ?? fetch;

    let res: Response;
    try {
      res = await doFetch(`${GEMINI_API_BASE}/${encodeURIComponent(this.model)}:generateContent`, {
        method: 'POST',
        // Header rather than ?key=: keeps the key out of URLs, proxies and access logs.
        headers: { 'content-type': 'application/json', 'x-goog-api-key': apiKey },
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [{ text: `${prompt.system}\n\nContext:\n${prompt.user}` }] }],
          generationConfig: {
            responseMimeType: 'application/json',
            responseSchema: RESPONSE_SCHEMA,
            temperature: this.opts.temperature ?? 0.7,
          },
        }),
        signal: AbortSignal.timeout(this.opts.timeoutMs ?? DEFAULT_TIMEOUT_MS),
      });
    } catch (err) {
      throw new GeminiScriptError('network', `Gemini request failed: ${(err as Error).message}`);
    }
    if (!res.ok) throw new GeminiScriptError('http_error', `Gemini responded ${res.status}`);

    let body: {
      candidates?: { content?: { parts?: { text?: string }[] }; finishReason?: string }[];
      promptFeedback?: { blockReason?: string };
    };
    try {
      body = (await res.json()) as typeof body;
    } catch {
      throw new GeminiScriptError('malformed_json', 'Gemini response body is not JSON');
    }

    if (body.promptFeedback?.blockReason) {
      throw new GeminiScriptError('blocked', `Gemini blocked the prompt: ${body.promptFeedback.blockReason}`);
    }
    const candidate = body.candidates?.[0];
    if (candidate?.finishReason && !['STOP', 'FINISH_REASON_UNSPECIFIED'].includes(candidate.finishReason)) {
      // e.g. SAFETY, RECITATION, MAX_TOKENS (truncated JSON).
      throw new GeminiScriptError('blocked', `Gemini stopped generating: ${candidate.finishReason}`);
    }
    const text = (candidate?.content?.parts ?? []).map((p) => p.text ?? '').join('');
    if (!text.trim()) throw new GeminiScriptError('empty_response', 'Gemini returned no text');
    return text;
  }
}
