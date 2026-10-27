import type { FastifyBaseLogger } from 'fastify';

export interface BackupDeliveryJob {
  channel: 'whatsapp';
  to: string;
  code: string;
  autoApplyUrl: string;
  expiresAt: Date;
}

/**
 * Asynchronous fallback delivery (AGENTS.md §4). The on-screen code is the
 * primary channel; this must never block or fail the HTTP response.
 */
export interface BackupDelivery {
  enqueue(job: BackupDeliveryJob): Promise<void>;
}

/** Placeholder until the WhatsApp provider integration lands. */
export class LoggingBackupDelivery implements BackupDelivery {
  constructor(private readonly log: FastifyBaseLogger) {}

  async enqueue(job: BackupDeliveryJob): Promise<void> {
    this.log.info({ channel: job.channel, code: job.code }, 'backup delivery enqueued (stub)');
  }
}
