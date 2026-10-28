import type { FastifyBaseLogger } from 'fastify';
import { isE164, maskPhone } from '../../lib/phone.js';
import { formatPrice } from '../links/landing-template.js';

/**
 * Out-of-band WhatsApp notifications for creators (LATAM's primary channel).
 *
 * Business-initiated WhatsApp messages must use a template pre-approved by
 * Meta and may only go to users who opted in. So every message here is a
 * named template + ordered body parameters; `previewText` is the rendered
 * Spanish copy (what the approved template must read) for logs, the test
 * outbox and the template-approval submission.
 */

// ---------- Messages & providers ----------

export interface WhatsAppTemplateMessage {
  /** E.164, e.g. "+525512345678". */
  to: string;
  template: string;
  /** WhatsApp template language code, e.g. "es_MX". */
  language: string;
  /** Positional body parameters {{1}}, {{2}}, … in template order. */
  parameters: string[];
  previewText: string;
}

export interface WhatsAppProvider {
  send(message: WhatsAppTemplateMessage): Promise<{ id: string }>;
}

export class WhatsAppSendError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'WhatsAppSendError';
  }
}

/** Test/dev provider: records messages instead of sending them. Set `failWith` to simulate an outage. */
export class InMemoryWhatsAppOutbox implements WhatsAppProvider {
  readonly messages: (WhatsAppTemplateMessage & { id: string })[] = [];
  failWith: Error | null = null;

  async send(message: WhatsAppTemplateMessage): Promise<{ id: string }> {
    if (this.failWith) throw this.failWith;
    const id = `wamid.test.${this.messages.length + 1}`;
    this.messages.push({ ...message, id });
    return { id };
  }
}

/** Default when no WhatsApp credentials are configured: nothing leaves the server. */
export class LoggingWhatsAppProvider implements WhatsAppProvider {
  constructor(private readonly log: Pick<FastifyBaseLogger, 'info'>) {}

  async send(message: WhatsAppTemplateMessage): Promise<{ id: string }> {
    this.log.info({ to: maskPhone(message.to), template: message.template }, 'whatsapp not configured; message not sent');
    return { id: 'not-sent' };
  }
}

/** WhatsApp Business Cloud API (Meta Graph API) template sender. */
export class MetaCloudWhatsAppProvider implements WhatsAppProvider {
  constructor(
    private readonly opts: {
      accessToken: string;
      phoneNumberId: string;
      apiVersion?: string;
      timeoutMs?: number;
      fetch?: typeof fetch;
    },
  ) {}

  async send(message: WhatsAppTemplateMessage): Promise<{ id: string }> {
    const version = this.opts.apiVersion ?? 'v23.0';
    const doFetch = this.opts.fetch ?? fetch;
    let res: Response;
    try {
      res = await doFetch(`https://graph.facebook.com/${version}/${encodeURIComponent(this.opts.phoneNumberId)}/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${this.opts.accessToken}` },
        body: JSON.stringify({
          messaging_product: 'whatsapp',
          recipient_type: 'individual',
          to: message.to,
          type: 'template',
          template: {
            name: message.template,
            language: { code: message.language },
            components: [{ type: 'body', parameters: message.parameters.map((text) => ({ type: 'text', text })) }],
          },
        }),
        signal: AbortSignal.timeout(this.opts.timeoutMs ?? 5_000),
      });
    } catch (err) {
      throw new WhatsAppSendError(`WhatsApp request failed: ${(err as Error).message}`);
    }
    const body = (await res.json().catch(() => ({}))) as { messages?: { id: string }[]; error?: { message?: string } };
    if (!res.ok) throw new WhatsAppSendError(`WhatsApp responded ${res.status}: ${body.error?.message ?? 'unknown error'}`, res.status);
    const id = body.messages?.[0]?.id;
    if (!id) throw new WhatsAppSendError('WhatsApp response contained no message id');
    return { id };
  }
}

// ---------- Templates ----------

export const INVITATION_TEMPLATE = { name: 'campaign_invitation', language: 'es_MX' } as const;

/**
 * Template parameters can't contain newlines/tabs or long runs of spaces, and are
 * capped in length, so every value is flattened and trimmed.
 */
export function templateParam(value: string, max = 200): string {
  const flat = value.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

export function formatExpiry(date: Date): string {
  return new Intl.DateTimeFormat('es-MX', { day: 'numeric', month: 'long', timeZone: 'America/Mexico_City' }).format(date);
}

export interface InvitationNotice {
  invitationId: string;
  /** Raw magic-link token (only ever in the message itself, never logged). */
  magicToken?: string;
  creatorName: string;
  brandName: string;
  productName: string;
  /** Creator commission on one sale, decimal string (e.g. "97.35"). */
  earningsPerSale: string;
  currency: string;
  expiresAt: Date;
}

/**
 * Template `campaign_invitation` (es_MX), body:
 *   ¡Hola {{1}}! {{2}} te invitó a promocionar {{3}}. Ganas aprox. {{4}} por cada venta.
 *   Revisa los hooks y acepta en 1 clic: {{5}} (vence el {{6}}).
 */
export function buildInvitationMessage(to: string, notice: InvitationNotice, reviewUrl: string): WhatsAppTemplateMessage {
  const parameters = [
    templateParam(notice.creatorName.split(/\s+/)[0] ?? notice.creatorName, 60),
    templateParam(notice.brandName, 80),
    templateParam(notice.productName, 120),
    templateParam(formatPrice(notice.earningsPerSale, notice.currency), 40),
    templateParam(reviewUrl, 300),
    templateParam(formatExpiry(notice.expiresAt), 40),
  ];
  const [name, brand, product, earnings, url, expiry] = parameters;
  return {
    to,
    template: INVITATION_TEMPLATE.name,
    language: INVITATION_TEMPLATE.language,
    parameters,
    previewText:
      `¡Hola ${name}! ${brand} te invitó a promocionar ${product}. Ganas aprox. ${earnings} por cada venta. ` +
      `Revisa los hooks y acepta en 1 clic: ${url} (vence el ${expiry}).`,
  };
}

export const LOGIN_TEMPLATE = { name: 'portal_login', language: 'es_MX' } as const;

/**
 * Template `portal_login` (es_MX), body:
 *   Tu enlace de acceso seguro a Referals: {{1}} (válido por 15 minutos).
 *   Si no lo solicitaste, puedes ignorar este mensaje.
 */
export function buildLoginMessage(to: string, loginUrl: string): WhatsAppTemplateMessage {
  const parameters = [templateParam(loginUrl, 300)];
  return {
    to,
    template: LOGIN_TEMPLATE.name,
    language: LOGIN_TEMPLATE.language,
    parameters,
    previewText:
      `Tu enlace de acceso seguro a Referals: ${parameters[0]} (válido por 15 minutos). ` +
      'Si no lo solicitaste, puedes ignorar este mensaje.',
  };
}

// ---------- Dispatcher ----------

export type NotifyResult =
  | { status: 'sent'; messageId: string }
  | { status: 'skipped'; reason: 'no_phone' | 'invalid_phone' | 'not_opted_in' }
  | { status: 'failed'; error: string };

export interface CreatorContact {
  phone: string | null;
  whatsappOptInAt: Date | null;
}

export class WhatsAppNotificationService {
  constructor(
    private readonly deps: {
      provider: WhatsAppProvider;
      log: Pick<FastifyBaseLogger, 'info' | 'warn' | 'error'>;
      /** Base for the creator's "review & accept" page; the invitation id (and magic token) is appended. */
      invitationReviewBaseUrl: string;
    },
  ) {}

  reviewUrl(invitationId: string, magicToken?: string): string {
    const url = `${this.deps.invitationReviewBaseUrl.replace(/\/+$/, '')}/${encodeURIComponent(invitationId)}`;
    return magicToken ? `${url}?token=${encodeURIComponent(magicToken)}` : url;
  }

  /** Sends (or skips) the invitation notice. Never throws: failures are returned and logged. */
  async notifyInvitation(contact: CreatorContact, notice: InvitationNotice): Promise<NotifyResult> {
    if (!contact.phone) return { status: 'skipped', reason: 'no_phone' };
    if (!isE164(contact.phone)) return { status: 'skipped', reason: 'invalid_phone' };
    if (!contact.whatsappOptInAt) return { status: 'skipped', reason: 'not_opted_in' };

    const message = buildInvitationMessage(contact.phone, notice, this.reviewUrl(notice.invitationId, notice.magicToken));
    try {
      const { id } = await this.deps.provider.send(message);
      this.deps.log.info({ invitationId: notice.invitationId, to: maskPhone(contact.phone), messageId: id }, 'invitation whatsapp sent');
      return { status: 'sent', messageId: id };
    } catch (err) {
      this.deps.log.error({ invitationId: notice.invitationId, to: maskPhone(contact.phone), error: (err as Error).message }, 'invitation whatsapp failed');
      return { status: 'failed', error: (err as Error).message };
    }
  }

  /** Sends (or skips) a portal login link. Never throws; the URL (a live credential) is never logged. */
  async sendLoginNotification(contact: CreatorContact, loginUrl: string): Promise<NotifyResult> {
    if (!contact.phone) return { status: 'skipped', reason: 'no_phone' };
    if (!isE164(contact.phone)) return { status: 'skipped', reason: 'invalid_phone' };
    if (!contact.whatsappOptInAt) return { status: 'skipped', reason: 'not_opted_in' };

    try {
      const { id } = await this.deps.provider.send(buildLoginMessage(contact.phone, loginUrl));
      this.deps.log.info({ to: maskPhone(contact.phone), messageId: id }, 'portal login whatsapp sent');
      return { status: 'sent', messageId: id };
    } catch (err) {
      this.deps.log.error({ to: maskPhone(contact.phone), error: (err as Error).message }, 'portal login whatsapp failed');
      return { status: 'failed', error: (err as Error).message };
    }
  }

  /**
   * Fire-and-forget: resolves the notice lazily and sends after the current request
   * has been answered, so a slow or failing WhatsApp API can never delay or fail it.
   */
  dispatchInBackground(load: () => Promise<{ contact: CreatorContact; notice: InvitationNotice } | null>): void {
    setImmediate(() => {
      load()
        .then((data) => (data ? this.notifyInvitation(data.contact, data.notice) : undefined))
        .catch((err: unknown) => this.deps.log.error({ error: (err as Error).message }, 'invitation whatsapp dispatch failed'));
    });
  }
}
