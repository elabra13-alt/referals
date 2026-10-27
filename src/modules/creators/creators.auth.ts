import type { FastifyReply, FastifyRequest, preHandlerAsyncHookHandler } from 'fastify';
import type { Creator } from '../../db/schema.js';
import { AppError } from '../../lib/errors.js';
import { hashApiKey, isWellFormedCreatorApiKey } from '../../lib/keys.js';
import type { CreatorsRepository } from './creators.repository.js';

declare module 'fastify' {
  interface FastifyRequest {
    /** Set by the creator auth preHandler on `/v1/creators/me*` routes. */
    creator: Creator | null;
  }
}

export const CREATOR_KEY_HEADER = 'x-referals-creator-key';

const unauthorized = () =>
  new AppError(401, 'UNAUTHORIZED', 'Missing or invalid creator API key.', undefined, {
    'WWW-Authenticate': 'Bearer realm="referals-creators"',
  });

/** Reads the key from `Authorization: Bearer <key>` (preferred) or `X-Referals-Creator-Key`. */
export function extractCreatorApiKey(request: FastifyRequest): string | null {
  const authorization = request.headers.authorization;
  if (typeof authorization === 'string') {
    const match = /^Bearer\s+(\S+)\s*$/i.exec(authorization);
    return match ? match[1]! : null;
  }
  const header = request.headers[CREATOR_KEY_HEADER];
  return typeof header === 'string' && header.trim() ? header.trim() : null;
}

export function createCreatorAuth(repo: CreatorsRepository): preHandlerAsyncHookHandler {
  return async function authenticateCreator(request: FastifyRequest, _reply: FastifyReply) {
    const apiKey = extractCreatorApiKey(request);
    // Shape check first: malformed keys (including seller `ref_live_` keys) never reach the database.
    if (!apiKey || !isWellFormedCreatorApiKey(apiKey)) throw unauthorized();

    const creator = await repo.findCreatorByApiKeyHash(hashApiKey(apiKey));
    if (!creator) throw unauthorized();
    if (creator.status !== 'active') {
      throw new AppError(403, 'CREATOR_SUSPENDED', 'This creator account is suspended.');
    }
    request.creator = creator;
  };
}

/** Narrows `request.creator` on routes behind the creator auth preHandler. */
export function requireCreator(request: FastifyRequest): Creator {
  if (!request.creator) throw unauthorized();
  return request.creator;
}
