import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { loadEnv } from '../config/env.js';
import { createDatabase } from './client.js';

const env = loadEnv();
const { db, close } = createDatabase(env.DATABASE_URL);

try {
  await migrate(db as Parameters<typeof migrate>[0], { migrationsFolder: './drizzle' });
  console.log('Migrations applied.');
} finally {
  await close();
}
