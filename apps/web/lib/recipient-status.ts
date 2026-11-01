import { reasonLabel } from './reasons';
import { waitPhrase, whenText } from './visibility';

/**
 * The words the campaign page uses for where each person is (CW-2.2 to 2.4). One place, so the count line, the Show menu, the
 * headline and every row say the same thing. Pure functions of the stored facts and a clock, tested without a browser.
 */

/** The state of one person on the list, in a word. */
export type StatusWord = 'Waiting' | 'Sending' | 'Sent' | 'Delivered' | 'Read' | 'Not yet';

/** What the Show menu and the counts can narrow the list to. `reached` = sent; `not_yet` = failed or skipped. */
export type Show = 'waiting' | 'reached' | 'not_yet' | 'sent' | 'delivered' | 'read';

/** The Show menu, in order. `Everyone` is the empty value. */
export const SHOW_OPTIONS: ReadonlyArray<{ value: '' | 'waiting' | 'reached' | 'not_yet'; label: string }> = [
  { value: '', label: 'Everyone' }, { value: 'waiting', label: 'Waiting' }, { value: 'reached', label: 'Reached' },
  { value: 'not_yet', label: 'Not yet' }
];

/** Whether a value from the address is one the list understands. */
export function isShow(value: string): value is Show {
  return value === 'waiting' || value === 'reached' || value === 'not_yet' || value === 'sent' || value === 'delivered' || value === 'read';
}

/** How many recipients are in each state. Mirrors the `progress` of `GET /campaigns/:id`. */
export interface ProgressFacts {
  readonly total: number;
  readonly pending: number;
  readonly queued: number;
  readonly sent: number;
  readonly delivered: number;
  readonly read: number;
  readonly failed: number;
  readonly skipped: number;
}

/** The count line and the headline, from the stored counts. */
export interface ReachSummary {
  /** People the message went to. A failed send is never counted as reached (CW-2.3). */
  readonly reached: number;
  /** People it has not reached and is not about to: failed or skipped. */
  readonly notYet: number;
  /** People still to be sent to: pending or queued. */
  readonly waiting: number;
  /** "212 of 500 reached · 17 not yet". */
  readonly headline: string;
  /** Sent · Delivered · Read · Not yet, each filtering the list to those people. Delivered includes read, as in WhatsApp. */
  readonly counts: ReadonlyArray<{ key: Show; label: string; value: number }>;
}

/** The headline and counts for a campaign. */
export function reachSummary(p: ProgressFacts): ReachSummary {
  const reached = p.sent;
  const notYet = p.failed + p.skipped;
  const headline = `${String(reached)} of ${String(p.total)} reached${notYet > 0 ? ` · ${String(notYet)} not yet` : ''}`;
  return {
    reached, notYet, waiting: p.pending + p.queued, headline,
    counts: [
      { key: 'sent', label: 'Sent', value: p.sent },
      { key: 'delivered', label: 'Delivered', value: p.delivered },
      { key: 'read', label: 'Read', value: p.read },
      { key: 'not_yet', label: 'Not yet', value: notYet }
    ]
  };
}

/** What a row needs of one recipient. Mirrors a row of `GET /campaigns/:id/recipients`. */
export interface RowFacts {
  /** The recipient's own state: `pending` · `queued` · `sent` · `failed` · `skipped`. */
  readonly status: string;
  /** The message's own state: `queued` · `sent` · `delivered` · `read` · `failed`. */
  readonly messageStatus: string | null;
  readonly holdReason?: string | null;
  readonly holdUntil?: string | null;
  readonly sentAt?: string | null;
  readonly deliveredAt?: string | null;
  readonly readAt?: string | null;
}

/** A row's state in words. */
export interface RowStatus {
  readonly word: StatusWord;
  /** What follows the word: "around 14:39", "in 12 s", "Quiet hours · goes 08:00", a time. */
  readonly detail: string | null;
  /** True for the row being sent now, which shows typing dots. */
  readonly typing: boolean;
}

/** Where the engine says a row is in the queue. */
export interface RowTiming {
  readonly now: Date;
  readonly timeZone?: string;
  /** The row at the head of the lane: when it goes. */
  readonly dueAt?: Date | null;
  /** A guess for a row further back: when it goes. */
  readonly around?: Date | null;
}

/** The status word of a row, with `queued` and `pending` both reading "Waiting" (CW-2.4 AC3). */
export function statusWord(r: Pick<RowFacts, 'status' | 'messageStatus'>): StatusWord {
  if (r.status === 'failed' || r.status === 'skipped') return 'Not yet';
  if (r.status === 'sent') return r.messageStatus === 'read' ? 'Read' : r.messageStatus === 'delivered' ? 'Delivered' : 'Sent';
  return 'Waiting';
}

/** The row in words (CW-2.2): "Waiting · around 14:39", "Sending in 12 s", "Read · 14:02", "Waiting · Quiet hours · goes 08:00". */
export function rowStatus(r: RowFacts, t: RowTiming): RowStatus {
  const zone = t.timeZone === undefined ? {} : { timeZone: t.timeZone };
  const word = statusWord(r);
  const clock = (iso: string | null | undefined): string | null => iso === null || iso === undefined ? null : whenText(iso, t.now, zone);
  if (word === 'Read') return { word, detail: clock(r.readAt ?? r.deliveredAt ?? r.sentAt), typing: false };
  if (word === 'Delivered') return { word, detail: clock(r.deliveredAt ?? r.sentAt), typing: false };
  if (word === 'Sent') return { word, detail: clock(r.sentAt), typing: false };
  if (word === 'Not yet') return { word, detail: null, typing: false };

  // Waiting. A hold says why in words, and when it lets go.
  const held = r.holdReason ?? null;
  if (held !== null) {
    const goes = r.holdUntil === null || r.holdUntil === undefined ? '' : ` · goes ${whenText(r.holdUntil, t.now, zone)}`;
    return { word, detail: `${reasonLabel(held)}${goes}`, typing: false };
  }
  // The head of the lane is the one being sent: a countdown, or "now" once its gap has passed.
  if (t.dueAt !== undefined && t.dueAt !== null) {
    const ms = t.dueAt.getTime() - t.now.getTime();
    return ms > 0
      ? { word: 'Sending', detail: waitPhrase(ms, { now: t.now, ...zone }), typing: true }
      : { word: 'Sending', detail: 'now', typing: true };
  }
  if (t.around !== undefined && t.around !== null) return { word, detail: `around ${whenText(t.around, t.now, zone)}`, typing: false };
  return { word, detail: null, typing: false };
}

/**
 * When each still-waiting row on a page is expected to go: the head's time, then each row after it one planned gap later. Rows
 * are in send order. Only right for a page that starts at the head of the queue, so a caller with a filter or a later page asks
 * for no estimate. Held rows get none (they say why instead).
 */
export function estimateTimes(
  rows: ReadonlyArray<{ id: string; status: string; holdReason?: string | null; plannedGapMs?: number | null }>,
  headId: string | null, headDueAt: Date | null
): Map<string, Date> {
  const out = new Map<string, Date>();
  if (headId === null || headDueAt === null) return out;
  let at = headDueAt.getTime();
  let seenHead = false;
  for (const r of rows) {
    if (r.status !== 'queued' && r.status !== 'pending') continue;
    if (r.id === headId) { seenHead = true; continue; }
    if (!seenHead) continue;
    if ((r.holdReason ?? null) !== null) continue;
    at += r.plannedGapMs ?? 0;
    out.set(r.id, new Date(at));
  }
  return out;
}

/** A reason filter in the address, `reason:refused_463`, the way the Show menu writes it. */
export const REASON_SHOW_PREFIX = 'reason:';
