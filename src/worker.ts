import pino from 'pino';
import { loadEnv } from './config/env.js';
import { createDatabase } from './db/client.js';
import { EscrowWorkerService } from './modules/escrow/escrow-worker.service.js';

const env = loadEnv();
const log = pino({ level: env.LOG_LEVEL, name: 'escrow-worker' });
const { db, close } = createDatabase(env.DATABASE_URL);

const worker = new EscrowWorkerService({ db, log, batchSize: env.ESCROW_WORKER_BATCH_SIZE });

if (process.argv.includes('--once')) {
  const result = await worker.runOnce();
  log.info(result, 'escrow worker run complete');
  await close();
} else {
  worker.start(env.ESCROW_WORKER_INTERVAL_MS);
  log.info({ intervalMs: env.ESCROW_WORKER_INTERVAL_MS }, 'escrow worker started');
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => {
      log.info({ signal }, 'escrow worker stopping');
      void worker
        .stop()
        .then(close)
        .then(() => process.exit(0));
    });
  }
}
