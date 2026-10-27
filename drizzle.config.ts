import 'dotenv/config';
import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  dialect: 'postgresql',
  schema: ['./src/db/schema.ts', './src/db/schema/storefront.ts'],
  out: './drizzle',
  dbCredentials: { url: process.env.DATABASE_URL ?? 'postgres://referals:referals@localhost:5432/referals' },
  strict: true,
});
