import { Redis } from 'ioredis';

export type RedisClient = Redis;

export function createRedis(redisUrl: string): RedisClient {
  return new Redis(redisUrl, { maxRetriesPerRequest: 2, enableAutoPipelining: true });
}
