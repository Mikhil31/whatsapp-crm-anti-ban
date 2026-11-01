import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import request from 'supertest';
import { sql } from 'drizzle-orm';
import { createDatabase, inspectDatabaseSecurity, resolveTenantRole, type Database } from '@crm/db';
import { LocalKms } from '@crm/kms-local';
import { BuiltinPasswordHasher } from '@crm/auth-builtin';
import { createOrgWithAdmin, createSession } from '@crm/core';
import { createLogger, type Config } from '@crm/shared';
import { buildApp } from '../../apps/api/src/app.js';
import { tempStorage, type TempStorage } from '../fixtures/storage.js';

/**
 * The campaign page's live data (F13 CW-2.1 to 2.7): the recipients come back in send order from the moment the campaign starts,
 * each with the latest message in its chat (decrypted, cut at 140 characters, media named), and the campaign's progress counts
 * delivered and read as well as sent.
 */
const url = process.env.TEST_DATABASE_URL ?? 'postgresql://dev:dev@localhost:5434/whatsapp_crm_test';
const kms = new LocalKms({ keyHex: randomBytes(32).toString('hex'), indexKeyHex: randomBytes(32).toString('hex') });
const config = { PRESET: 'lean', PROCESS_ROLE: 'all', LOG_LEVEL: 'silent', NODE_ENV: 'test', API_KEY: randomBytes(32).toString('hex'), DEFAULT_COUNTRY: 'IN' } as unknown as Config;
const logger = createLogger({ LOG_LEVEL: 'error', NODE_ENV: 'test' });
const hasher = new BuiltinPasswordHasher();

let db: Database;
let app: ReturnType<typeof buildApp>;
let media: TempStorage;
let orgId: string;
let senderId: string;
let campaignId: string;
let session: Record<string, string>;

beforeAll(async () => {
  db = createDatabase(url, { max: 6 });
  media = tempStorage();
  const tenantRole = await resolveTenantRole(db, await inspectDatabaseSecurity(db));
  app = buildApp({ config, logger, db, kms, hasher, tenantRole, storage: media.storage });
});
afterAll(async () => { await db.$client.end(); media.cleanup(); });

type Rows = Array<{ id: string }>;

/** A contact, a recipient row for it, and optionally a chat with a message in it. */
async function addRecipient(
  name: string, status: string, opts: { message?: { direction: 'inbound' | 'outbound'; kind?: string; body?: string; status?: string }; sentAt?: string } = {}
): Promise<string> {
  const contact = ((await db.execute(sql`INSERT INTO contact(org_id, display_name, source) VALUES (${orgId}, ${name}, 'test') RETURNING id`)) as unknown as Rows)[0]!.id;
  let messageId: string | null = null;
  if (opts.message !== undefined) {
    const conv = ((await db.execute(sql`INSERT INTO conversation(org_id, contact_id, sender_identity_id) VALUES (${orgId}, ${contact}, ${senderId}) RETURNING id`)) as unknown as Rows)[0]!.id;
    const m = opts.message;
    const body = m.body === undefined ? null : Buffer.from(kms.encrypt(new TextEncoder().encode(m.body)));
    messageId = ((await db.execute(sql`
      INSERT INTO message (org_id, conversation_id, direction, status, content_type, body_enc, body_hmac, sent_by, campaign_id, provider_message_id)
      VALUES (${orgId}, ${conv}, ${m.direction}, ${m.status ?? 'sent'}, ${m.kind ?? 'text'}, ${body}, ${m.body === undefined ? null : kms.blindIndex(m.body)},
              'system', ${m.direction === 'outbound' ? campaignId : null}, ${`wa-${randomBytes(6).toString('hex')}`})
      RETURNING id`)) as unknown as Rows)[0]!.id;
  }
  return ((await db.execute(sql`
    INSERT INTO campaign_recipient (org_id, campaign_id, contact_id, status, message_id)
    VALUES (${orgId}, ${campaignId}, ${contact}, ${status}, ${messageId}) RETURNING id`)) as unknown as Rows)[0]!.id;
}

const list = (query = '') => request(app).get(`/api/v1/campaigns/${campaignId}/recipients${query}`).set(session);
type Row = { id: string; displayName: string; lastMessage: { from: string; text: string; kind: string } | null };

beforeEach(async () => {
  await db.execute(sql`DELETE FROM org`);
  await db.execute(sql`DELETE FROM app_user`);
  const org = await createOrgWithAdmin(db, hasher, { orgName: 'Acme', slug: 'acme-live', email: 'a@acme.test', password: 'x', displayName: 'Admin' });
  orgId = org.orgId;
  const token = (await createSession(db, { userId: org.userId, orgId })).token;
  session = { Cookie: `crm_session=${token}; crm_csrf=csrf`, 'x-csrf-token': 'csrf' };
  senderId = ((await db.execute(sql`INSERT INTO sender_identity(org_id, provider, label, status) VALUES (${orgId}, 'baileys', 'n', 'active') RETURNING id`)) as unknown as Rows)[0]!.id;
  campaignId = ((await db.execute(sql`
    INSERT INTO campaign (org_id, name, status, body, sender_identity_id) VALUES (${orgId}, 'Live', 'running', 'Hello', ${senderId}) RETURNING id`)) as unknown as Rows)[0]!.id;
});

describe('CW-2.2 everyone, in send order', () => {
  it('lists people who have no message yet, in id order, before and after paging', async () => {
    const ids = [] as string[];
    for (let i = 0; i < 5; i++) ids.push(await addRecipient(`P${String(i)}`, i < 2 ? 'queued' : 'pending'));
    const all = (await list()).body.data as Row[];
    expect(all.map((r) => r.id)).toEqual([...ids].sort());
    const first = await list('?limit=2');
    const second = await list(`?limit=2&cursor=${first.body.nextCursor as string}`);
    expect([...first.body.data, ...second.body.data].map((r: Row) => r.id)).toEqual([...ids].sort().slice(0, 4));
  });

  it('show=waiting, reached and not_yet pick the plain-words groups', async () => {
    await addRecipient('Wait', 'queued');
    await addRecipient('Pend', 'pending');
    await addRecipient('Done', 'sent', { message: { direction: 'outbound', body: 'Hi' } });
    await addRecipient('Bad', 'failed');
    await addRecipient('Skip', 'skipped');
    const names = async (show: string): Promise<string[]> => ((await list(`?show=${show}`)).body.data as Row[]).map((r) => r.displayName).sort();
    expect(await names('waiting')).toEqual(['Pend', 'Wait']);
    expect(await names('reached')).toEqual(['Done']);
    expect(await names('not_yet')).toEqual(['Bad', 'Skip']);
    expect((await list('?show=nonsense')).status).toBe(422);
  });
});

describe('CW-2.7 the latest message in the chat', () => {
  it('returns who said it and the decrypted text, newest message first', async () => {
    const id = await addRecipient('Asha', 'sent', { message: { direction: 'outbound', body: 'Hello Asha' } });
    const row = ((await list()).body.data as Row[]).find((r) => r.id === id)!;
    expect(row.lastMessage).toEqual({ from: 'us', text: 'Hello Asha', kind: 'text' });

    // A reply arrives: the next read shows it, from them.
    const conv = ((await db.execute(sql`SELECT conversation_id AS id FROM message WHERE campaign_id = ${campaignId} LIMIT 1`)) as unknown as Rows)[0]!.id;
    await db.execute(sql`
      INSERT INTO message (org_id, conversation_id, direction, status, content_type, body_enc, body_hmac, provider_message_id)
      VALUES (${orgId}, ${conv}, 'inbound', 'received', 'text', ${Buffer.from(kms.encrypt(new TextEncoder().encode('Yes please')))}, ${kms.blindIndex('Yes please')}, 'wa-reply-1')`);
    const after = ((await list()).body.data as Row[]).find((r) => r.id === id)!;
    expect(after.lastMessage).toEqual({ from: 'them', text: 'Yes please', kind: 'text' });
  });

  it('cuts the text at 140 characters', async () => {
    const id = await addRecipient('Long', 'sent', { message: { direction: 'outbound', body: 'x'.repeat(500) } });
    const row = ((await list()).body.data as Row[]).find((r) => r.id === id)!;
    expect(row.lastMessage?.text).toHaveLength(140);
  });

  it('names media: Photo, Voice note, Document', async () => {
    const photo = await addRecipient('Pic', 'sent', { message: { direction: 'inbound', kind: 'image' } });
    const voice = await addRecipient('Voice', 'sent', { message: { direction: 'inbound', kind: 'audio' } });
    const doc = await addRecipient('Doc', 'sent', { message: { direction: 'inbound', kind: 'document' } });
    const video = await addRecipient('Clip', 'sent', { message: { direction: 'inbound', kind: 'video' } });
    const rows = (await list()).body.data as Row[];
    const text = (id: string): string | undefined => rows.find((r) => r.id === id)?.lastMessage?.text;
    expect([text(photo), text(voice), text(doc), text(video)]).toEqual(['Photo', 'Voice note', 'Document', 'Video']);
  });

  it('is null for someone with no chat yet', async () => {
    const id = await addRecipient('New', 'pending');
    expect(((await list()).body.data as Row[]).find((r) => r.id === id)?.lastMessage).toBeNull();
  });
});

describe('CW-2.1 progress counts delivered and read', () => {
  it('GET /campaigns/:id reports sent, delivered (read included) and read', async () => {
    await addRecipient('A', 'sent', { message: { direction: 'outbound', body: 'a', status: 'sent' } });
    await addRecipient('B', 'sent', { message: { direction: 'outbound', body: 'b', status: 'delivered' } });
    await addRecipient('C', 'sent', { message: { direction: 'outbound', body: 'c', status: 'read' } });
    await addRecipient('D', 'failed');
    const r = await request(app).get(`/api/v1/campaigns/${campaignId}`).set(session);
    expect(r.body.data.progress).toMatchObject({ total: 4, sent: 3, delivered: 2, read: 1, failed: 1 });
  });
});
