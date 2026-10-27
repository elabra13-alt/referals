/**
 * One-off backfill: encrypts any seller webhook secrets still stored in plaintext.
 * Idempotent — already-encrypted rows are skipped. Run: npm run db:encrypt-secrets
 */
import { eq } from 'drizzle-orm';
import { loadEnv } from '../config/env.js';
import { encryptSecret, isEncryptedSecret } from '../lib/crypto.js';
import { createDatabase } from './client.js';
import { sellers } from './schema.js';

const env = loadEnv();
const { db, close } = createDatabase(env.DATABASE_URL);

try {
  const rows = await db.select({ id: sellers.id, webhookSecret: sellers.webhookSecret }).from(sellers);
  let encrypted = 0;
  for (const row of rows) {
    if (isEncryptedSecret(row.webhookSecret)) continue;
    await db
      .update(sellers)
      .set({ webhookSecret: encryptSecret(row.webhookSecret, env.WEBHOOK_ENCRYPTION_KEY) })
      .where(eq(sellers.id, row.id));
    encrypted++;
  }
  console.log(`Encrypted ${encrypted} of ${rows.length} seller webhook secrets.`);
} finally {
  await close();
}
