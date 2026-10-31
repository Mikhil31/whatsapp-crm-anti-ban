import { sql } from 'drizzle-orm';
import { AUDIT, writeAudit, type AuditActor } from './audit.js';
import type { Queryable } from './antiban/holds.js';

/** What a person's Retry did. */
export type MessageRetryOutcome =
  | { readonly found: false }
  | { readonly found: true; readonly outcome: 'requeued' | 'hold_lifted' | 'not_retryable' };

/**
 * Puts a message back in the lane because a person pressed Retry (F6 S10). This is the only way a failed message is sent again:
 * nothing in the engine retries by itself (AC-1.9). It does not skip any check; the message goes through the do-not-contact gate,
 * the policy and the lane exactly as it did the first time, and may fail again.
 *
 * - A failed message is queued again, its error cleared. Its place in the lane is its original one.
 * - A failed 463 refusal also lifts the hold on that contact, which waits for exactly this (AC-2.6).
 * - A message held because of a 463 only has the hold lifted.
 * - Anything else (sent, delivered, read, inbound, held for another reason) is left alone: `not_retryable`.
 */
export async function retryMessage(
  db: Queryable, orgId: string, messageId: string, actor: AuditActor, ctx: { ip?: string | null; requestId?: string | null } = {}
): Promise<MessageRetryOutcome> {
  const m = (await db.execute(sql`
    SELECT m.status, m.error_code AS "errorCode", m.hold_reason AS "holdReason", m.campaign_id AS "campaignId", m.conversation_id AS "conversationId"
    FROM message m WHERE m.id = ${messageId} AND m.org_id = ${orgId} AND m.direction = 'outbound'`) as unknown as Array<{
      status: string; errorCode: string | null; holdReason: string | null; campaignId: string | null; conversationId: string }>)[0];
  if (m === undefined) return { found: false };

  let outcome: 'requeued' | 'hold_lifted' | 'not_retryable' = 'not_retryable';
  if (m.status === 'failed') {
    await db.execute(sql`
      UPDATE message SET status = 'queued', error_code = NULL, error_detail = NULL, hold_reason = NULL, hold_until = NULL
      WHERE id = ${messageId} AND status = 'failed'`);
    if (m.errorCode === 'whatsapp_refused_463') {
      await db.execute(sql`UPDATE conversation SET refused_463_at = NULL WHERE id = ${m.conversationId}`);
    }
    // A running campaign counts the message again; the sweep that follows brings the recipient up to date. A campaign that is no
    // longer running is not swept, so its recipient row keeps what it said.
    if (m.campaignId !== null) {
      await db.execute(sql`
        UPDATE campaign_recipient cr SET status = 'queued'
        FROM campaign c
        WHERE cr.message_id = ${messageId} AND cr.status = 'failed' AND c.id = cr.campaign_id AND c.status = 'running'`);
    }
    outcome = 'requeued';
  } else if (m.status === 'queued' && m.holdReason === 'refused_463') {
    await db.execute(sql`UPDATE conversation SET refused_463_at = NULL WHERE id = ${m.conversationId}`);
    await db.execute(sql`UPDATE message SET hold_reason = NULL, hold_until = NULL WHERE id = ${messageId}`);
    outcome = 'hold_lifted';
  }

  if (outcome !== 'not_retryable') {
    await writeAudit(db, {
      orgId, actor, action: AUDIT.messageRetried, targetType: 'message', targetId: messageId,
      before: { status: m.status, errorCode: m.errorCode, holdReason: m.holdReason }, after: { outcome },
      ip: ctx.ip ?? null, requestId: ctx.requestId ?? null
    });
  }
  return { found: true, outcome };
}
