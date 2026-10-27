import type { FastifyReply, FastifyRequest, preHandlerAsyncHookHandler } from 'fastify';
import { AppError } from '../../lib/errors.js';
import { hashApiKey, isWellFormedApiKey, safeEqual } from '../../lib/keys.js';
import type { AuthSeller, SellersRepository } from './sellers.repository.js';

declare module 'fastify' {
  interface FastifyRequest {
    /** Set by the seller auth preHandler on authenticated routes. */
    seller: AuthSeller | null;
  }
}

export const API_KEY_HEADER = 'x-referals-api-key';
export const ADMIN_TOKEN_HEADER = 'x-referals-admin-token';

const unauthorized = () =>
  new AppError(401, 'UNAUTHORIZED', 'Missing or invalid API key.', undefined, {
    'WWW-Authenticate': 'Bearer realm="referals"',
  });

/** Reads the key from `Authorization: Bearer <key>` (preferred) or `X-Referals-Api-Key`. */
export function extractApiKey(request: FastifyRequest): string | null {
  const authorization = request.headers.authorization;
  if (typeof authorization === 'string') {
    const match = /^Bearer\s+(\S+)\s*$/i.exec(authorization);
    return match ? match[1]! : null;
  }
  const header = request.headers[API_KEY_HEADER];
  return typeof header === 'string' && header.trim() ? header.trim() : null;
}

export function createSellerAuth(repo: SellersRepository): preHandlerAsyncHookHandler {
  return async function authenticateSeller(request: FastifyRequest, _reply: FastifyReply) {
    const apiKey = extractApiKey(request);
    // Shape check first: malformed keys never reach the database.
    if (!apiKey || !isWellFormedApiKey(apiKey)) throw unauthorized();

    const seller = await repo.findSellerByApiKeyHash(hashApiKey(apiKey));
    if (!seller) throw unauthorized();
    if (seller.status !== 'active') {
      throw new AppError(403, 'SELLER_SUSPENDED', 'This seller account is suspended.');
    }
    request.seller = seller;
  };
}

/** Narrows `request.seller` on routes behind the auth preHandler. */
export function requireSeller(request: FastifyRequest): AuthSeller {
  if (!request.seller) throw unauthorized();
  return request.seller;
}

/**
 * Seller onboarding is a platform-operator action: it needs the admin token.
 * When no token is configured, onboarding is disabled entirely.
 */
export function createAdminAuth(adminToken: string | undefined): preHandlerAsyncHookHandler {
  return async function authenticateAdmin(request: FastifyRequest) {
    if (!adminToken) {
      throw new AppError(503, 'ONBOARDING_DISABLED', 'Seller onboarding is not configured on this server.');
    }
    const provided = request.headers[ADMIN_TOKEN_HEADER];
    if (typeof provided !== 'string' || !safeEqual(provided, adminToken)) {
      throw new AppError(401, 'UNAUTHORIZED', 'Missing or invalid admin token.');
    }
  };
}
