import { drizzle } from 'drizzle-orm/node-postgres';
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import pg from 'pg';
import * as schema from './schema.js';

/** Driver-agnostic Drizzle handle (node-postgres in prod, PGlite in tests). */
export type Database = PgDatabase<PgQueryResultHKT, typeof schema>;

export function createDatabase(databaseUrl: string): { db: Database; close: () => Promise<void> } {
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 20 });
  const db = drizzle(pool, { schema });
  return { db, close: () => pool.end() };
}

const PG_UNIQUE_VIOLATION = '23505';

/** Drizzle may wrap driver errors (`cause`), so walk the chain looking for a SQLSTATE. */
export function isUniqueViolation(err: unknown, constraint?: string): boolean {
  let current: unknown = err;
  for (let depth = 0; current && depth < 5; depth++) {
    const e = current as { code?: unknown; constraint?: unknown; message?: unknown; cause?: unknown };
    if (e.code === PG_UNIQUE_VIOLATION) {
      if (!constraint) return true;
      return e.constraint === constraint || (typeof e.message === 'string' && e.message.includes(constraint));
    }
    current = e.cause;
  }
  return false;
}
