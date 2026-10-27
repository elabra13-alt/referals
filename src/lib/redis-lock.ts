import { randomUUID } from 'node:crypto';
import type { RedisClient } from './redis.js';

/** All-or-nothing SET NX across every key. */
const ACQUIRE_LOCKS_LUA = `
for _, k in ipairs(KEYS) do
  if redis.call('EXISTS', k) == 1 then return 0 end
end
for _, k in ipairs(KEYS) do
  redis.call('SET', k, ARGV[1], 'PX', ARGV[2])
end
return 1
`;

/** Only release keys we still own (token match). */
const RELEASE_LOCKS_LUA = `
local released = 0
for _, k in ipairs(KEYS) do
  if redis.call('GET', k) == ARGV[1] then
    redis.call('DEL', k)
    released = released + 1
  end
end
return released
`;

export class LockNotAcquiredError extends Error {
  constructor(readonly keys: string[]) {
    super(`Could not acquire lock: ${keys.join(', ')}`);
    this.name = 'LockNotAcquiredError';
  }
}

export interface LockOptions {
  ttlMs: number;
  /** How long to keep polling for a held lock before giving up. */
  maxWaitMs: number;
  waitStepMs?: number;
}

/**
 * Redis mutex over one or more keys (multi-key callers must share a cluster
 * hash tag). Runs `fn` while holding all keys; throws LockNotAcquiredError if
 * they stay held for longer than `maxWaitMs`.
 */
export async function withRedisLock<T>(
  redis: RedisClient,
  keys: string[],
  opts: LockOptions,
  fn: () => Promise<T>,
): Promise<T> {
  const token = randomUUID();
  const step = opts.waitStepMs ?? 25;

  let waited = 0;
  while (!(await redis.eval(ACQUIRE_LOCKS_LUA, keys.length, ...keys, token, opts.ttlMs))) {
    if (waited >= opts.maxWaitMs) throw new LockNotAcquiredError(keys);
    await new Promise((r) => setTimeout(r, step));
    waited += step;
  }

  try {
    return await fn();
  } finally {
    await redis.eval(RELEASE_LOCKS_LUA, keys.length, ...keys, token).catch(() => undefined);
  }
}
