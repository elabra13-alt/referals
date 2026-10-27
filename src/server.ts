import { buildApp } from './app.js';
import { loadEnv } from './config/env.js';
import { createDatabase } from './db/client.js';
import { createRedis } from './lib/redis.js';

const env = loadEnv();
const { db, close: closeDb } = createDatabase(env.DATABASE_URL);
const redis = createRedis(env.REDIS_URL);

const app = buildApp({ db, redis, webhookEncryptionKey: env.WEBHOOK_ENCRYPTION_KEY, adminApiToken: env.ADMIN_API_TOKEN, publicLinkBaseUrl: env.PUBLIC_LINK_BASE_URL, shopifyApiVersion: env.SHOPIFY_API_VERSION, publicApiUrl: env.PUBLIC_API_URL, geminiApiKey: env.GEMINI_API_KEY, geminiModel: env.GEMINI_MODEL, whatsapp: env.WHATSAPP_ACCESS_TOKEN && env.WHATSAPP_PHONE_NUMBER_ID ? { accessToken: env.WHATSAPP_ACCESS_TOKEN, phoneNumberId: env.WHATSAPP_PHONE_NUMBER_ID, apiVersion: env.WHATSAPP_API_VERSION } : undefined, creatorAppUrl: env.CREATOR_APP_URL }, { logger: { level: env.LOG_LEVEL }, trustProxy: env.TRUST_PROXY });

app.addHook('onClose', async () => {
  await Promise.allSettled([closeDb(), redis.quit()]);
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    app.log.info({ signal }, 'shutting down');
    void app.close().then(() => process.exit(0));
  });
}

await app.listen({ port: env.PORT, host: env.HOST });
