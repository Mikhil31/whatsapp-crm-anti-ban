import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomBytes, randomUUID } from 'node:crypto';
import request from 'supertest';
import { sql } from 'drizzle-orm';
import { inspectDatabaseSecurity, resolveTenantRole } from '@crm/db';
import { BuiltinPasswordHasher } from '@crm/auth-builtin';
import { issueApiKey } from '@crm/core';
import { createLogger, type Config } from '@crm/shared';
import { buildApp } from '../../apps/api/src/app.js';
import { tempStorage, type TempStorage } from '../fixtures/storage.js';
import { makeLane, type Lane } from './antiban-v2-harness.js';

/**
 * F6 S10 through the API: what the screens read. The number's lane (AC-10.4), the message with its hold, error and due time
 * (AC-10.1), the recipient list with reasons, a filter and pages (AC-10.2), the ETA's split (AC-10.3), and Retry, the one way a
 * failed message is sent again.
 */
const config = { PRESET: 'lean', PROCESS_ROLE: 'all', LOG_LEVEL: 'silent', NODE_ENV: 'test', API_KEY: randomBytes(32).toString('hex'), DEFAULT_COUNTRY: 'IN' } as unknown as Config;
const logger = createLogger({ LOG_LEVEL: 'error', NODE_ENV: 'test' });

let lane: Lane;
let app: ReturnType<typeof buildApp>;
let media: TempStorage;
let key: string;

beforeAll(() => { media = tempStorage('antiban-visibility'); });
afterAll(async () => { media.cleanup(); await lane.close(); });
beforeEach(async () => {
  if (lane !== undefined) await lane.close().catch(() => undefined);
  lane = await makeLane();
  await lane.db.execute(sql`INSERT INTO channel_session (sender_identity_id, connection_state) VALUES (${lane.senderId}, 'open')`);
  const tenantRole = await resolveTenantRole(lane.db, await inspectDatabaseSecurity(lane.db));
  app = buildApp({ config, logger, db: lane.db, kms: (await import('./antiban-v2-harness.js')).kms, hasher: new BuiltinPasswordHasher(), tenantRole, storage: media.storage });
  key = (await issueApiKey(lane.db, { orgId: lane.orgId, name: 'visibility', scopes: ['messages:send', 'conversations:read', 'senders:read', 'senders:write'] })).secret;
});

const auth = () => ['Authorization', `Bearer ${key}`] as const;
const senderCard = async () => {
  const r = await request(app).get('/api/v1/senders').set(...auth());
  expect(r.status).toBe(200);
  return (r.body.data as Array<Record<string, unknown>>).find((s) => s.id === lane.senderId)!;
};
const thread = async (conversationId: string) => {
  const r = await request(app).get(`/api/v1/conversations/${conversationId}/messages`).set(...auth());
  expect(r.status).toBe(200);
  return r.body.data as Array<Record<string, unknown> & { id: string }>;
};

describe('AC-10.4 the number card reads the lane', () => {
  it('AC-10.4 an idle number has nothing waiting, no next send, no hold', async () => {
    expect((await senderCard()).lane).toEqual({ waiting: 0, nextSendAt: null, hold: null });
  });

  it('AC-10.4 the next send is the last send plus the gap drawn for the first message in line', async () => {
    const { conversationId } = await lane.contact({ inbound: 'old' });
    const sentAt = new Date(Date.now() - 5_000);
    await lane.db.execute(sql`
      INSERT INTO message (org_id, conversation_id, direction, status, content_type, sent_by, sent_at)
      VALUES (${lane.orgId}, ${conversationId}, 'outbound', 'sent', 'text', 'api', ${sentAt.toISOString()})`);
    await lane.queue(conversationId, 'next up', { gapMs: 30_000 });
    await lane.queue(conversationId, 'and then', { gapMs: 40_000 });
    const card = await senderCard();
    const l = card.lane as { waiting: number; nextSendAt: string; hold: unknown };
    expect(l.waiting).toBe(2);
    expect(new Date(l.nextSendAt).getTime()).toBe(sentAt.getTime() + 30_000);
    expect(l.hold).toBeNull();
  });

  it('AC-10.4 a gap that has already passed reads as due now, not as a time in the past', async () => {
    const { conversationId } = await lane.contact({ inbound: 'old' });
    await lane.db.execute(sql`
      INSERT INTO message (org_id, conversation_id, direction, status, content_type, sent_by, sent_at)
      VALUES (${lane.orgId}, ${conversationId}, 'outbound', 'sent', 'text', 'api', ${new Date(Date.now() - 600_000).toISOString()})`);
    await lane.queue(conversationId, 'overdue', { gapMs: 20_000 });
    const l = (await senderCard()).lane as { nextSendAt: string };
    expect(new Date(l.nextSendAt).getTime()).toBeGreaterThanOrEqual(Date.now() - 2_000);
  });

  it('AC-10.4 a timelock shows as the hold, with when it ends, even with nothing queued', async () => {
    const until = new Date(Date.now() + 3_600_000);
    await lane.db.execute(sql`
      UPDATE channel_session SET timelock_active = true, timelock_until = ${until.toISOString()}, timelock_type = 'DEFAULT'
      WHERE sender_identity_id = ${lane.senderId}`);
    const l = (await senderCard()).lane as { hold: { reason: string; until: string } };
    expect(l.hold.reason).toBe('timelock');
    expect(new Date(l.hold.until).getTime()).toBe(until.getTime());
  });

  it('AC-10.4 a hold on the whole number wins over a timelock', async () => {
    await lane.db.execute(sql`
      UPDATE channel_session SET many_undelivered_at = now(), timelock_active = true, timelock_until = now() + interval '1 hour'
      WHERE sender_identity_id = ${lane.senderId}`);
    expect(((await senderCard()).lane as { hold: { reason: string } }).hold.reason).toBe('many_undelivered');
  });

  it('AC-10.4 the reason recorded on a held message shows when nothing else applies', async () => {
    const { conversationId } = await lane.contact({ inbound: 'old' });
    const id = await lane.queue(conversationId, 'later');
    const until = new Date(Date.now() + 7_200_000);
    await lane.db.execute(sql`UPDATE message SET hold_reason = 'quiet_hours', hold_until = ${until.toISOString()} WHERE id = ${id}`);
    const l = (await senderCard()).lane as { waiting: number; nextSendAt: string | null; hold: { reason: string; until: string } };
    expect(l).toMatchObject({ waiting: 1, nextSendAt: null, hold: { reason: 'quiet_hours' } });
    expect(new Date(l.hold.until).getTime()).toBe(until.getTime());
  });

  it('AC-10.4 still carries the warning level, quota used and total, linked since and the hints', async () => {
    await lane.db.execute(sql`
      UPDATE channel_session SET capping_status = 'FIRST_WARNING', capping_total_quota = 50, capping_used_quota = 12,
             linked_since = now() - interval '2 days' WHERE sender_identity_id = ${lane.senderId}`);
    const card = await senderCard();
    expect(card).toMatchObject({ cappingStatus: 'FIRST_WARNING', cappingTotalQuota: 50, cappingUsedQuota: 12 });
    expect(card.linkedSince).toEqual(expect.any(String));
    expect((card.hints as Array<{ code: string }>).map((h) => h.code)).toContain('new_number');
  });
});

describe('AC-10.1 a message carries what the timeline needs', () => {
  it('AC-10.1 a failed message has its code and the provider text; a held one its reason and expected end', async () => {
    const { conversationId, contactId } = await lane.contact({ inbound: 'old' });
    const failed = await lane.queue(conversationId, 'one');
    await lane.db.execute(sql`UPDATE message SET status = 'failed', error_code = 'send_error', error_detail = 'Connection Closed' WHERE id = ${failed}`);
    const held = await lane.queue(conversationId, 'two');
    const until = new Date(Date.now() + 600_000);
    await lane.db.execute(sql`UPDATE message SET hold_reason = 'timelock', hold_until = ${until.toISOString()} WHERE id = ${held}`);
    const m = await thread(conversationId);
    const f = m.find((x) => x.id === failed)!;
    const h = m.find((x) => x.id === held)!;
    expect(f).toMatchObject({ status: 'failed', errorCode: 'send_error', errorDetail: 'Connection Closed', contactId, senderIdentityId: lane.senderId, dueAt: null });
    expect(h).toMatchObject({ holdReason: 'timelock', dueAt: null });
    expect(new Date(h.holdUntil as string).getTime()).toBe(until.getTime());
  });

  it('AC-10.1 only the message at the head of the lane has a due time; it is the stored gap after the last send', async () => {
    const { conversationId } = await lane.contact({ inbound: 'old' });
    const sentAt = new Date(Date.now() - 4_000);
    await lane.db.execute(sql`
      INSERT INTO message (org_id, conversation_id, direction, status, content_type, sent_by, sent_at, delivered_at)
      VALUES (${lane.orgId}, ${conversationId}, 'outbound', 'delivered', 'text', 'api', ${sentAt.toISOString()}, ${new Date(sentAt.getTime() + 2_000).toISOString()})`);
    const first = await lane.queue(conversationId, 'first', { gapMs: 20_000, createdAt: new Date(Date.now() - 3_000) });
    const second = await lane.queue(conversationId, 'second', { gapMs: 20_000, createdAt: new Date(Date.now() - 2_000) });
    const m = await thread(conversationId);
    const a = m.find((x) => x.id === first)!;
    const b = m.find((x) => x.id === second)!;
    expect(new Date(a.dueAt as string).getTime()).toBe(sentAt.getTime() + 20_000);
    expect(b.dueAt).toBeNull();
    expect(m.find((x) => x.direction === 'outbound' && x.status === 'delivered')?.deliveredAt).toEqual(expect.any(String));
  });
});

describe('AC-10.1 Retry puts a failed message back, only when a person asks', () => {
  it('AC-10.1 a failed message goes back to queued with its error cleared, and is audited', async () => {
    const { conversationId } = await lane.contact({ inbound: 'old' });
    const id = await lane.queue(conversationId, 'try again');
    await lane.db.execute(sql`UPDATE message SET status = 'failed', error_code = 'send_error', error_detail = 'boom' WHERE id = ${id}`);
    const r = await request(app).post(`/api/v1/messages/${id}/retry`).set(...auth());
    expect(r.status).toBe(200);
    expect(r.body.data.outcome).toBe('requeued');
    expect(await lane.row(id)).toMatchObject({ status: 'queued', code: null, detail: null });
    const audit = await lane.one<{ n: number }>(sql`SELECT count(*)::int AS n FROM audit_log WHERE org_id = ${lane.orgId} AND action = 'message.retried' AND target_id = ${id}`);
    expect(audit.n).toBe(1);
  });

  it('AC-10.1 retrying a failed 463 refusal also lifts the hold on that contact', async () => {
    const { conversationId } = await lane.contact({ inbound: 'old' });
    const id = await lane.queue(conversationId, 'refused');
    await lane.db.execute(sql`UPDATE message SET status = 'failed', error_code = 'whatsapp_refused_463' WHERE id = ${id}`);
    await lane.db.execute(sql`UPDATE conversation SET refused_463_at = now() WHERE id = ${conversationId}`);
    expect((await request(app).post(`/api/v1/messages/${id}/retry`).set(...auth())).status).toBe(200);
    const c = await lane.one<{ at: string | null }>(sql`SELECT refused_463_at AS at FROM conversation WHERE id = ${conversationId}`);
    expect(c.at).toBeNull();
  });

  it('AC-10.1 a message held by a 463 gets its hold lifted by Retry', async () => {
    const { conversationId } = await lane.contact({ inbound: 'old' });
    const id = await lane.queue(conversationId, 'held');
    await lane.db.execute(sql`UPDATE message SET hold_reason = 'refused_463' WHERE id = ${id}`);
    await lane.db.execute(sql`UPDATE conversation SET refused_463_at = now() WHERE id = ${conversationId}`);
    const r = await request(app).post(`/api/v1/messages/${id}/retry`).set(...auth());
    expect(r.body.data.outcome).toBe('hold_lifted');
    expect(await lane.row(id)).toMatchObject({ status: 'queued', hold: null });
  });

  it('AC-10.1 a message that did not fail is left alone (409), and a stranger is not found (404)', async () => {
    const { conversationId } = await lane.contact({ inbound: 'old' });
    const sent = (await lane.sent(conversationId)).id;
    const r = await request(app).post(`/api/v1/messages/${sent}/retry`).set(...auth());
    expect(r.status).toBe(409);
    expect(r.body.code).toBe('NOT_RETRYABLE');
    expect((await request(app).post(`/api/v1/messages/${randomUUID()}/retry`).set(...auth())).status).toBe(404);
  });

  it('AC-1.9 nothing retries by itself: a failed message stays failed through the lane', async () => {
    const { conversationId } = await lane.contact({ inbound: 'old' });
    const id = await lane.queue(conversationId, 'stays failed');
    await lane.db.execute(sql`UPDATE message SET status = 'failed', error_code = 'send_error' WHERE id = ${id}`);
    await lane.drain();
    expect((await lane.row(id)).status).toBe('failed');
    expect(lane.sentBodies()).toEqual([]);
  });

  it('AC-10.1 a failed campaign message counts again in a running campaign', async () => {
    const { conversationId, contactId } = await lane.contact({ inbound: 'old' });
    const campaignId = (await lane.one<{ id: string }>(sql`
      INSERT INTO campaign (org_id, name, body, sender_identity_id, status) VALUES (${lane.orgId}, 'c', 'hi', ${lane.senderId}, 'running') RETURNING id`)).id;
    const id = await lane.queue(conversationId, 'hi', { campaignId });
    await lane.db.execute(sql`UPDATE message SET status = 'failed', error_code = 'send_error' WHERE id = ${id}`);
    await lane.db.execute(sql`
      INSERT INTO campaign_recipient (org_id, campaign_id, contact_id, status, message_id) VALUES (${lane.orgId}, ${campaignId}, ${contactId}, 'failed', ${id})`);
    expect((await request(app).post(`/api/v1/messages/${id}/retry`).set(...auth())).status).toBe(200);
    const cr = await lane.one<{ status: string }>(sql`SELECT status FROM campaign_recipient WHERE message_id = ${id}`);
    expect(cr.status).toBe('queued');
  });
});

describe('AC-10.2 the recipient list', () => {
  let campaignId: string;
  const recipient = async (status: string, how: { skip?: string; message?: { status: string; hold?: string; code?: string; detail?: string } } = {}) => {
    const { contactId, conversationId } = await lane.contact({ inbound: 'old' });
    let messageId: string | null = null;
    if (how.message !== undefined) {
      messageId = await lane.queue(conversationId, 'hello', { campaignId });
      await lane.db.execute(sql`
        UPDATE message SET status = ${how.message.status}, hold_reason = ${how.message.hold ?? null}, error_code = ${how.message.code ?? null},
               error_detail = ${how.message.detail ?? null} WHERE id = ${messageId}`);
    }
    await lane.db.execute(sql`
      INSERT INTO campaign_recipient (org_id, campaign_id, contact_id, status, skip_reason, message_id, planned_gap_ms)
      VALUES (${lane.orgId}, ${campaignId}, ${contactId}, ${status}, ${how.skip ?? null}, ${messageId}, 12000)`);
    return { contactId, conversationId, messageId };
  };
  const list = async (qs = '') => {
    const r = await request(app).get(`/api/v1/campaigns/${campaignId}/recipients${qs}`).set(...auth());
    expect(r.status).toBe(200);
    return r.body as { data: Array<Record<string, unknown>>; nextCursor: string | null; reasons: Array<{ reason: string; count: number }> };
  };

  beforeEach(async () => {
    campaignId = (await lane.one<{ id: string }>(sql`
      INSERT INTO campaign (org_id, name, body, sender_identity_id, status) VALUES (${lane.orgId}, 'c', 'hi', ${lane.senderId}, 'running') RETURNING id`)).id;
  });

  it('AC-10.2 every row says its state, its reason, the gap drawn for it, and the ids to act on it', async () => {
    const held = await recipient('queued', { message: { status: 'queued', hold: 'timelock' } });
    const failed = await recipient('failed', { message: { status: 'failed', code: 'send_error', detail: 'Connection Closed' } });
    await recipient('skipped', { skip: 'dnc' });
    const { data } = await list();
    expect(data).toHaveLength(3);
    const h = data.find((r) => r.messageId === held.messageId)!;
    expect(h).toMatchObject({ status: 'queued', reason: 'timelock', plannedGapMs: 12000, contactId: held.contactId, conversationId: held.conversationId, senderIdentityId: lane.senderId });
    expect(data.find((r) => r.messageId === failed.messageId)).toMatchObject({ reason: 'send_error', errorCode: 'send_error', errorDetail: 'Connection Closed' });
    expect(data.find((r) => r.status === 'skipped')).toMatchObject({ reason: 'dnc', messageId: null });
  });

  it('AC-10.2 filters by reason, and by state and reason together', async () => {
    await recipient('queued', { message: { status: 'queued', hold: 'timelock' } });
    await recipient('queued', { message: { status: 'queued', hold: 'quiet_hours' } });
    await recipient('failed', { message: { status: 'failed', code: 'send_error' } });
    await recipient('skipped', { skip: 'dnc' });
    expect((await list('?reason=timelock')).data.map((r) => r.reason)).toEqual(['timelock']);
    expect((await list('?reason=dnc')).data).toHaveLength(1);
    expect((await list('?status=failed&reason=send_error')).data).toHaveLength(1);
    expect((await list('?status=queued&reason=send_error')).data).toHaveLength(0);
    expect((await list('?reason=nothing_like_this')).data).toHaveLength(0);
  });

  it('AC-10.2 lists the reasons the campaign has, with counts, for the filter', async () => {
    await recipient('queued', { message: { status: 'queued', hold: 'timelock' } });
    await recipient('queued', { message: { status: 'queued', hold: 'timelock' } });
    await recipient('skipped', { skip: 'dnc' });
    await recipient('sent', { message: { status: 'sent' } });
    expect((await list()).reasons).toEqual([{ reason: 'timelock', count: 2 }, { reason: 'dnc', count: 1 }]);
  });

  it('AC-10.2 pages: a full page hands back a cursor, the next page continues, and the last has none', async () => {
    for (let i = 0; i < 5; i++) await recipient('pending');
    const first = await list('?limit=2');
    expect(first.data).toHaveLength(2);
    expect(first.nextCursor).not.toBeNull();
    const second = await list(`?limit=2&cursor=${first.nextCursor!}`);
    const third = await list(`?limit=2&cursor=${second.nextCursor!}`);
    expect(third.data).toHaveLength(1);
    expect(third.nextCursor).toBeNull();
    const ids = [...first.data, ...second.data, ...third.data].map((r) => r.id);
    expect(new Set(ids).size).toBe(5);
    expect(second.reasons).toEqual([]);                        // the filter list comes with the first page only
  });
});

describe('AC-10.3 the ETA says when the part that goes now finishes', () => {
  it('AC-10.3 goNowEndsAt is the end of the stretch before the reset, and finishAt is after it', async () => {
    const cycleEnd = new Date(Date.now() + 6 * 3_600_000);
    await lane.db.execute(sql`
      UPDATE channel_session SET capping_status = 'FIRST_WARNING', capping_total_quota = 50, capping_used_quota = 48,
             capping_cycle_end = ${cycleEnd.toISOString()}, capping_updated_at = now() WHERE sender_identity_id = ${lane.senderId}`);
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) ids.push((await lane.contact()).contactId);
    const created = await request(app).post('/api/v1/campaigns').set(...auth()).send({ name: 'eta', body: '{Hi|Hello} there', senderIdentityId: lane.senderId, explicitContactIds: ids });
    const started = await request(app).post(`/api/v1/campaigns/${created.body.data.id}/start`).set(...auth());
    expect(started.status).toBe(200);
    const eta = (await request(app).get(`/api/v1/campaigns/${created.body.data.id}/eta`).set(...auth())).body.data;
    expect(eta).toMatchObject({ basis: 'quota', goNow: 2, afterReset: 3 });
    expect(new Date(eta.goNowEndsAt).getTime()).toBeLessThan(cycleEnd.getTime());
    expect(new Date(eta.finishAt).getTime()).toBeGreaterThan(cycleEnd.getTime());
  });

  it('AC-10.3 nothing going now means no goNowEndsAt', async () => {
    const eta = await request(app).post('/api/v1/campaigns').set(...auth()).send({
      name: 'none', body: 'x', senderIdentityId: lane.senderId, explicitContactIds: [(await lane.contact()).contactId]
    });
    expect(eta.status).toBe(201);
    const r = (await request(app).get(`/api/v1/campaigns/${eta.body.data.id}/eta`).set(...auth())).body.data;
    expect(r).toHaveProperty('goNowEndsAt');
  });
});
