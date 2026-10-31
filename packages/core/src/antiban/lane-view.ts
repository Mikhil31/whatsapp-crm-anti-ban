import { sql } from 'drizzle-orm';
import type { Hold } from '../antiban.js';
import type { Queryable } from './holds.js';
import { laneCandidates, lastSentAtOf, loadNumberState } from './lane-state.js';
import { gapFactorFor } from './policy.js';

/** What the number card shows of one number's lane (F6 AC-10.4). Read-only: it changes nothing. */
export interface LaneView {
  /** Outbound messages of this number still queued, held or not. */
  readonly waiting: number;
  /** The message the lane takes next (the first one in lane order that is not held), or null. */
  readonly headMessageId: string | null;
  /** When that message is due: the last send plus the gap drawn for it. Not later than `now`, so a due message reads as due. Null when nothing can go. */
  readonly nextSendAt: Date | null;
  /** What is holding things back right now, or null. */
  readonly hold: Hold | null;
}

/**
 * The lane of one number as the engine has stored it: how many messages wait, which one is next and when, and the hold that matters
 * most. Computed from the queue, the gaps stored on the messages and what WhatsApp last said about the number; nothing here is
 * remembered between calls, so it is the same answer the gateway would reach.
 *
 * The hold shown is the first that applies, whole number first: a hold on the number, then WhatsApp's timelock and new-chat cap
 * (those stop new chats even while known contacts still go), then the reason recorded on the first held message (quiet hours, a
 * contact's retry or refusal).
 */
export async function laneView(db: Queryable, senderIdentityId: string, now: Date): Promise<LaneView> {
  const count = (await db.execute(sql`
    SELECT count(*)::int AS n FROM message m JOIN conversation v ON v.id = m.conversation_id
    WHERE v.sender_identity_id = ${senderIdentityId} AND m.direction = 'outbound' AND m.status = 'queued'`) as unknown as Array<{ n: number }>)[0]?.n ?? 0;
  const number = await loadNumberState(db, senderIdentityId);

  let headMessageId: string | null = null;
  let nextSendAt: Date | null = null;
  let heldFirst: Hold | null = null;
  if (count > 0) {
    const candidates = await laneCandidates(db, senderIdentityId, now, 100);
    const head = candidates.find((c) => c.holdReason === null);
    const held = candidates.find((c) => c.holdReason !== null);
    if (held !== undefined) heldFirst = { reason: held.holdReason as Hold['reason'], until: held.holdUntil };
    if (head !== undefined) {
      headMessageId = head.messageId;
      const last = await lastSentAtOf(db, senderIdentityId);
      const gap = Math.round((head.plannedGapMs ?? 0) * gapFactorFor(head.newChat, number));
      const due = last === null ? now : new Date(last.getTime() + gap);
      nextSendAt = due.getTime() < now.getTime() ? now : due;
    }
  }

  const lock = number.timelock;
  const lockOn = lock.active && (lock.until === null || lock.until.getTime() > now.getTime());
  const cap = number.capping;
  const cycleOpen = cap.cycleEnd !== null && cap.cycleEnd.getTime() > now.getTime();
  const capOn = (cap.status === 'CAPPED' && (cap.cycleEnd === null || cycleOpen)) || (cap.remaining !== null && cap.remaining <= 0 && cycleOpen);
  const hold: Hold | null = number.hold
    ?? (lockOn ? { reason: 'timelock', until: lock.until } : null)
    ?? (capOn ? { reason: 'new_chat_cap', until: cap.cycleEnd } : null)
    ?? heldFirst;

  return { waiting: count, headMessageId, nextSendAt, hold };
}
