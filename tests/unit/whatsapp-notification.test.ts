import { describe, expect, it, vi } from 'vitest';
import { loadEnv } from '../../src/config/env.js';
import { isE164, maskPhone, stripPhoneSeparators } from '../../src/lib/phone.js';
import {
  INVITATION_TEMPLATE,
  InMemoryWhatsAppOutbox,
  MetaCloudWhatsAppProvider,
  WhatsAppNotificationService,
  WhatsAppSendError,
  buildInvitationMessage,
  templateParam,
  type InvitationNotice,
} from '../../src/modules/notifications/whatsapp.service.js';

const PHONE = '+525512345678';
const notice: InvitationNotice = {
  invitationId: '0b6c4c1e-5a43-4e8e-9d2f-1a2b3c4d5e6f',
  creatorName: 'Valeria Glow',
  brandName: 'Alice Beauty',
  productName: 'Sérum Facial Iluminador Glow',
  earningsPerSale: '97.35',
  currency: 'MXN',
  expiresAt: new Date('2026-11-02T18:00:00.000Z'),
};
const REVIEW = 'https://referals.mx/creadores/invitaciones';

const quietLog = () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() });

describe('E.164 phone helpers', () => {
  it.each(['+525512345678', '+14155550123', '+5491123456789'])('accepts %s', (p) => expect(isE164(p)).toBe(true));
  it.each(['5512345678', '+05512345678', '+52 55 1234 5678', '+52-55', '525512345678', '+5255123456789012'])('rejects %s', (p) =>
    expect(isE164(p)).toBe(false),
  );
  it('strips the separators people type, without inventing a country code', () => {
    expect(stripPhoneSeparators(' +52 (55) 1234-5678 ')).toBe('+525512345678');
    expect(stripPhoneSeparators('55 1234 5678')).toBe('5512345678');
  });
  it('masks numbers for logs', () => {
    expect(maskPhone(PHONE)).toBe('+52••••••5678');
    expect(maskPhone(PHONE)).not.toContain('551234');
  });
});

describe('invitation template', () => {
  it('compiles the approved es_MX template with 6 ordered parameters and a matching preview', () => {
    const msg = buildInvitationMessage(PHONE, notice, `${REVIEW}/${notice.invitationId}`);
    expect(msg).toEqual({
      to: PHONE,
      template: 'campaign_invitation',
      language: 'es_MX',
      parameters: [
        'Valeria',
        'Alice Beauty',
        'Sérum Facial Iluminador Glow',
        '$97.35 MXN',
        `${REVIEW}/${notice.invitationId}`,
        '2 de noviembre',
      ],
      previewText:
        '¡Hola Valeria! Alice Beauty te invitó a promocionar Sérum Facial Iluminador Glow. Ganas aprox. $97.35 MXN por cada venta. ' +
        `Revisa los hooks y acepta en 1 clic: ${REVIEW}/${notice.invitationId} (vence el 2 de noviembre).`,
    });
    expect(INVITATION_TEMPLATE).toEqual({ name: 'campaign_invitation', language: 'es_MX' });
  });

  it('formats the expiry in Mexico City time (not UTC)', () => {
    // 05:00 UTC on Nov 3 is still Nov 2 in CDMX.
    const msg = buildInvitationMessage(PHONE, { ...notice, expiresAt: new Date('2026-11-03T05:00:00.000Z') }, REVIEW);
    expect(msg.parameters[5]).toBe('2 de noviembre');
  });

  it('flattens newlines/tabs and caps length (WhatsApp rejects multi-line parameters)', () => {
    expect(templateParam('Sérum\nGlow\t\t  Pro')).toBe('Sérum Glow Pro');
    expect(templateParam('x'.repeat(300), 50)).toHaveLength(50);
    const msg = buildInvitationMessage(PHONE, { ...notice, productName: 'Línea\nNueva', brandName: 'A'.repeat(200) }, REVIEW);
    expect(msg.parameters.every((p) => !/[\n\t]/.test(p))).toBe(true);
    expect(msg.parameters[1]!.length).toBeLessThanOrEqual(80);
  });
});

describe('WhatsAppNotificationService', () => {
  const service = (outbox = new InMemoryWhatsAppOutbox(), log = quietLog()) => ({
    outbox,
    log,
    svc: new WhatsAppNotificationService({ provider: outbox, log, invitationReviewBaseUrl: `${REVIEW}/` }),
  });

  it('sends to opted-in creators with a review link for the invitation', async () => {
    const { svc, outbox } = service();
    const result = await svc.notifyInvitation({ phone: PHONE, whatsappOptInAt: new Date() }, notice);
    expect(result).toEqual({ status: 'sent', messageId: 'wamid.test.1' });
    expect(outbox.messages).toHaveLength(1);
    expect(outbox.messages[0]!.parameters[4]).toBe(`${REVIEW}/${notice.invitationId}`);
  });

  it.each([
    ['no phone', { phone: null, whatsappOptInAt: null }, 'no_phone'],
    ['an invalid stored phone', { phone: '5512345678', whatsappOptInAt: new Date() }, 'invalid_phone'],
    ['no WhatsApp opt-in', { phone: PHONE, whatsappOptInAt: null }, 'not_opted_in'],
  ] as const)('skips creators with %s', async (_label, contact, reason) => {
    const { svc, outbox } = service();
    expect(await svc.notifyInvitation(contact, notice)).toEqual({ status: 'skipped', reason });
    expect(outbox.messages).toHaveLength(0);
  });

  it('never throws on provider failure, and never logs the full phone number', async () => {
    const outbox = new InMemoryWhatsAppOutbox();
    outbox.failWith = new WhatsAppSendError('WhatsApp responded 503: Service unavailable', 503);
    const { svc, log } = service(outbox);
    const result = await svc.notifyInvitation({ phone: PHONE, whatsappOptInAt: new Date() }, notice);
    expect(result).toEqual({ status: 'failed', error: 'WhatsApp responded 503: Service unavailable' });
    expect(log.error).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(log.error.mock.calls)).not.toContain(PHONE);
  });

  it('dispatches in the background: returns immediately, sends afterwards, swallows loader errors', async () => {
    const { svc, outbox, log } = service();
    svc.dispatchInBackground(async () => ({ contact: { phone: PHONE, whatsappOptInAt: new Date() }, notice }));
    expect(outbox.messages).toHaveLength(0); // nothing synchronous
    await vi.waitFor(() => expect(outbox.messages).toHaveLength(1));

    svc.dispatchInBackground(async () => {
      throw new Error('db down');
    });
    await vi.waitFor(() => expect(log.error).toHaveBeenCalledWith({ error: 'db down' }, 'invitation whatsapp dispatch failed'));

    svc.dispatchInBackground(async () => null);
    await new Promise((r) => setTimeout(r, 10));
    expect(outbox.messages).toHaveLength(1);
  });
});

describe('MetaCloudWhatsAppProvider', () => {
  const message = buildInvitationMessage(PHONE, notice, `${REVIEW}/abc`);

  const fakeFetch = (status: number, body: unknown) => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fn = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return Response.json(body, { status });
    }) as unknown as typeof fetch;
    return { fn, calls };
  };

  it('posts a Cloud API template message with positional body parameters', async () => {
    const { fn, calls } = fakeFetch(200, { messaging_product: 'whatsapp', messages: [{ id: 'wamid.HBg' }] });
    const provider = new MetaCloudWhatsAppProvider({ accessToken: 'EAAtoken', phoneNumberId: '1029384756', fetch: fn });
    expect(await provider.send(message)).toEqual({ id: 'wamid.HBg' });

    expect(calls[0]!.url).toBe('https://graph.facebook.com/v23.0/1029384756/messages');
    expect((calls[0]!.init.headers as Record<string, string>).authorization).toBe('Bearer EAAtoken');
    expect(JSON.parse(calls[0]!.init.body as string)).toEqual({
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: PHONE,
      type: 'template',
      template: {
        name: 'campaign_invitation',
        language: { code: 'es_MX' },
        components: [{ type: 'body', parameters: message.parameters.map((text) => ({ type: 'text', text })) }],
      },
    });
  });

  it('honours a configured Graph API version', async () => {
    const { fn, calls } = fakeFetch(200, { messages: [{ id: 'x' }] });
    await new MetaCloudWhatsAppProvider({ accessToken: 't', phoneNumberId: '1', apiVersion: 'v24.0', fetch: fn }).send(message);
    expect(calls[0]!.url).toContain('/v24.0/');
  });

  it.each([
    ['an API error', 400, { error: { message: '(#132001) Template name does not exist in the translation' } }],
    ['a response without a message id', 200, { messages: [] }],
  ])('throws WhatsAppSendError on %s', async (_label, status, body) => {
    const { fn } = fakeFetch(status, body);
    await expect(new MetaCloudWhatsAppProvider({ accessToken: 't', phoneNumberId: '1', fetch: fn }).send(message)).rejects.toBeInstanceOf(
      WhatsAppSendError,
    );
  });
});

describe('WhatsApp configuration', () => {
  const base = { DATABASE_URL: 'postgres://u:p@localhost/db', REDIS_URL: 'redis://localhost:6379' };
  it('requires the access token and phone number id together', () => {
    expect(() => loadEnv({ ...base, WHATSAPP_ACCESS_TOKEN: 'EAA' })).toThrow(/must be set together/);
    expect(loadEnv({ ...base, WHATSAPP_ACCESS_TOKEN: 'EAA', WHATSAPP_PHONE_NUMBER_ID: '123' }).WHATSAPP_API_VERSION).toBe('v23.0');
    expect(loadEnv({ ...base, WHATSAPP_ACCESS_TOKEN: '', WHATSAPP_PHONE_NUMBER_ID: '' }).WHATSAPP_ACCESS_TOKEN).toBeUndefined();
  });
});
