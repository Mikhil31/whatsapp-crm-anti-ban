import { clockTime, describeReason } from './reasons';

/**
 * Plain words for what the anti-ban engine stores (F6 S10): where a message is on its way out, when a campaign finishes, what a
 * number is doing right now. Pure functions of the stored facts and a clock, so a screen can call them again every second and the
 * countdowns move without a reload (AC-10.5), and so the sentences are tested without a browser.
 */

/** How long a wait is, in the unit a person reads: `12 s`, `3 min 05 s`, `2 h 10 min`. */
export function formatWait(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  if (total < 60) return `${String(total)} s`;
  if (total < 3600) return `${String(Math.floor(total / 60))} min ${String(total % 60).padStart(2, '0')} s`;
  return `${String(Math.floor(total / 3600))} h ${String(Math.floor((total % 3600) / 60)).padStart(2, '0')} min`;
}

interface ZoneOption { readonly timeZone?: string }

/** The calendar day of `at` in the zone, as `YYYY-MM-DD`. */
function dayKey(at: Date, timeZone?: string): string {
  return new Intl.DateTimeFormat('en-CA', { year: 'numeric', month: '2-digit', day: '2-digit', ...(timeZone === undefined ? {} : { timeZone }) }).format(at);
}

/** A time as a person says it: `17:42` today, `09:00 tomorrow`, `09:00 on 3 Nov` any other day. */
export function whenText(at: Date | string, now: Date, zone: ZoneOption = {}): string {
  const d = typeof at === 'string' ? new Date(at) : at;
  const clock = clockTime(d, zone.timeZone);
  const day = dayKey(d, zone.timeZone);
  if (day === dayKey(now, zone.timeZone)) return clock;
  if (day === dayKey(new Date(now.getTime() + 86_400_000), zone.timeZone)) return `${clock} tomorrow`;
  const date = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', ...(zone.timeZone === undefined ? {} : { timeZone: zone.timeZone }) }).format(d);
  return `${clock} on ${date}`;
}

// ── AC-10.1: the message timeline ────────────────────────────────────────────────────────────────────────────────────────────────

/** What the timeline needs of one outbound message. Mirrors the fields of `GET /conversations/:id/messages`. */
export interface MessageFacts {
  readonly status: string;
  readonly holdReason: string | null;
  readonly holdUntil: string | null;
  readonly errorCode: string | null;
  readonly errorDetail: string | null;
  readonly createdAt: string;
  readonly sentAt: string | null;
  readonly deliveredAt: string | null;
  readonly readAt: string | null;
  /** When the lane is due to send it, set only for the message at the head of its number's lane. */
  readonly dueAt: string | null;
}

export type StepKey = 'queued' | 'waiting' | 'typing' | 'sent' | 'delivered' | 'read';

export interface TimelineStep {
  readonly key: StepKey;
  readonly label: string;
  readonly state: 'done' | 'current' | 'todo';
  /** When it happened, when the engine stored that. */
  readonly at: string | null;
}

export interface Timeline {
  readonly steps: TimelineStep[];
  /** `held`: queued with a reason. `failed`: it will not go. `in_flight`: moving along the steps. */
  readonly outcome: 'in_flight' | 'held' | 'failed';
  /** For a held or failed message: the code and what goes into its sentence. */
  readonly reason: { code: string; until: string | null; detail: string | null } | null;
  /** While waiting for the gap to pass: when it ends. */
  readonly waitUntil: Date | null;
}

const STEP_ORDER: StepKey[] = ['queued', 'waiting', 'typing', 'sent', 'delivered', 'read'];

/**
 * Where an outbound message is on its way out (AC-10.1): queued, waiting n s, typing, sent, delivered, read; or held with a
 * reason, or failed with one. "Waiting" and "typing" are inferred from the time the lane is due to send it, which the engine stores
 * only for the message at the head of the lane; any other queued message is just queued.
 */
export function messageTimeline(m: MessageFacts, now: Date): Timeline {
  const due = m.dueAt === null ? null : new Date(m.dueAt);
  let stage: number;
  let outcome: Timeline['outcome'] = 'in_flight';
  let reason: Timeline['reason'] = null;
  let waitUntil: Date | null = null;

  if (m.status === 'failed') {
    stage = 0;
    outcome = 'failed';
    reason = { code: m.errorCode ?? '', until: null, detail: m.errorDetail };
  } else if (m.status === 'queued') {
    if (m.holdReason !== null) {
      stage = 0;
      outcome = 'held';
      reason = { code: m.holdReason, until: m.holdUntil, detail: null };
    } else if (due !== null && due.getTime() > now.getTime()) {
      stage = 1;
      waitUntil = due;
    } else if (due !== null) {
      stage = 2;
    } else {
      stage = 0;
    }
  } else {
    stage = m.status === 'read' ? 5 : m.status === 'delivered' ? 4 : 3;
  }

  const times: Record<StepKey, string | null> = {
    queued: m.createdAt, waiting: null, typing: null, sent: m.sentAt, delivered: m.deliveredAt, read: m.readAt
  };
  const steps = STEP_ORDER.map((key, i): TimelineStep => ({
    key,
    label: key === 'waiting' && waitUntil !== null ? `waiting ${formatWait(waitUntil.getTime() - now.getTime())} (gap between sends)` : key,
    state: outcome === 'failed' ? (i === 0 ? 'done' : 'todo') : i < stage ? 'done' : i === stage ? 'current' : 'todo',
    at: times[key]
  }));
  return { steps, outcome, reason, waitUntil };
}

// ── AC-10.3: the campaign's ETA ──────────────────────────────────────────────────────────────────────────────────────────────────

/** `GET /campaigns/:id/eta`. */
export interface EtaFacts {
  readonly finishAt: string | null;
  readonly goNow: number;
  readonly afterReset: number;
  readonly resetAt: string | null;
  /** When the last message that goes before the reset is expected to go. Absent from an API that does not send it. */
  readonly goNowEndsAt?: string | null;
  readonly basis: 'quota' | 'time_only';
  readonly delayedBy: ReadonlyArray<{ reason: string; seconds: number }>;
}

const DELAY_WORDS: Record<string, string> = {
  reply_priority: 'replies going first', timelock: "WhatsApp's timelock", new_chat_cap: "WhatsApp's new-chat limit", quiet_hours: 'quiet hours'
};

/** The ETA in the owner's words: `Finishes at 17:42`, or the split around WhatsApp's reset, and what pushed it back. */
export function etaLines(eta: EtaFacts, now: Date, zone: ZoneOption = {}): { headline: string; delay: string | null } {
  const when = (at: string): string => whenText(at, now, zone);
  let headline: string;
  if (eta.finishAt === null) {
    headline = 'Nothing left to send.';
  } else if (eta.afterReset === 0 || eta.resetAt === null) {
    headline = `Finishes at ${when(eta.finishAt)}`;
  } else if (eta.goNow === 0) {
    headline = `None go now; ${String(eta.afterReset)} wait for WhatsApp's reset at ${when(eta.resetAt)}, finishing ${when(eta.finishAt)}`;
  } else {
    const finishing = eta.goNowEndsAt === undefined || eta.goNowEndsAt === null ? '' : `, finishing ${when(eta.goNowEndsAt)}`;
    headline = `${String(eta.goNow)} go now${finishing}; ${String(eta.afterReset)} after WhatsApp's reset at ${when(eta.resetAt)}`;
  }
  const delays = [...eta.delayedBy].filter((d) => d.seconds > 0).sort((a, b) => b.seconds - a.seconds);
  const delay = delays.length === 0 ? null
    : `Pushed back by ${delays.map((d) => `${DELAY_WORDS[d.reason] ?? d.reason} (${formatWait(d.seconds * 1000)})`).join(' and ')}`;
  return { headline, delay };
}

// ── AC-10.4: the number card ─────────────────────────────────────────────────────────────────────────────────────────────────────

/** The lane of one number, as `GET /senders` reports it. */
export interface LaneFacts {
  readonly waiting: number;
  readonly nextSendAt: string | null;
  readonly hold: { readonly reason: string; readonly until: string | null } | null;
}

/** What a number is doing now: when it sends next, and what it is holding back. */
export function laneLines(lane: LaneFacts, now: Date, zone: ZoneOption = {}): { sending: string; holding: string | null } {
  let sending: string;
  if (lane.waiting === 0) sending = 'Nothing waiting to send';
  else if (lane.nextSendAt === null) sending = `${String(lane.waiting)} waiting`;
  else {
    const ms = new Date(lane.nextSendAt).getTime() - now.getTime();
    sending = ms > 0 ? `Sending next in ${formatWait(ms)}` : 'Sending now';
  }

  let holding: string | null = null;
  if (lane.hold !== null) {
    const until = lane.hold.until === null ? '' : ` until ${clockTime(lane.hold.until, zone.timeZone)}`;
    if (lane.hold.reason === 'timelock') holding = `Holding new chats: timelock${until}`;
    else if (lane.hold.reason === 'new_chat_cap') holding = `Holding new chats: new-chat limit used up${until}`;
    else if (lane.hold.reason === 'quiet_hours') holding = `Holding campaign messages: quiet hours${until}`;
    else holding = `Holding: ${describeReason(lane.hold.reason, { until: lane.hold.until, ...zone }).sentence}`;
  }
  return { sending, holding };
}

/** WhatsApp's warning level for a number's new chats, with the quota used out of the total. */
export function quotaLine(
  s: { cappingStatus: string | null; cappingUsedQuota: number | null; cappingTotalQuota: number | null; cappingCycleEnd: string | null },
  now: Date, zone: ZoneOption = {}
): { level: string; tone: 'ok' | 'warn' | 'danger'; used: string | null; resets: string | null } {
  const level = s.cappingStatus === 'NONE' ? { level: 'No warning', tone: 'ok' as const }
    : s.cappingStatus === 'FIRST_WARNING' ? { level: 'First warning', tone: 'warn' as const }
    : s.cappingStatus === 'SECOND_WARNING' ? { level: 'Second warning', tone: 'warn' as const }
    : s.cappingStatus === 'CAPPED' ? { level: 'Capped', tone: 'danger' as const }
    : { level: 'No report from WhatsApp yet', tone: 'ok' as const };
  const used = s.cappingUsedQuota !== null && s.cappingTotalQuota !== null
    ? `${String(s.cappingUsedQuota)} of ${String(s.cappingTotalQuota)} new chats used` : null;
  const resets = s.cappingCycleEnd === null ? null : `resets at ${whenText(s.cappingCycleEnd, now, zone)}`;
  return { ...level, used, resets };
}
