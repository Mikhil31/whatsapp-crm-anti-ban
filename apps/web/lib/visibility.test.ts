import { describe, expect, it } from 'vitest';
import { etaLines, formatWait, waitPhrase, hasVariation, laneLines, messageTimeline, quotaLine, type MessageFacts } from './visibility';

const NOW = new Date('2026-10-31T10:00:00Z');
const at = (s: number): string => new Date(NOW.getTime() + s * 1000).toISOString();
const tz = { timeZone: 'UTC' };

const base: MessageFacts = {
  status: 'queued', holdReason: null, holdUntil: null, errorCode: null, errorDetail: null,
  createdAt: at(-60), sentAt: null, deliveredAt: null, readAt: null, dueAt: null
};
const stateOf = (t: ReturnType<typeof messageTimeline>): Record<string, string> =>
  Object.fromEntries(t.steps.map((s) => [s.key, s.state]));

describe('AC-10.1 the message timeline', () => {
  it('queued with nothing yet known is at the first step', () => {
    const t = messageTimeline(base, NOW);
    expect(t.outcome).toBe('in_flight');
    expect(stateOf(t)).toEqual({ queued: 'current', waiting: 'todo', typing: 'todo', sent: 'todo', delivered: 'todo', read: 'todo' });
  });

  it('a message due in 12 s is waiting 12 s, and says why', () => {
    const t = messageTimeline({ ...base, dueAt: at(12) }, NOW);
    expect(stateOf(t).waiting).toBe('current');
    expect(stateOf(t).queued).toBe('done');
    expect(t.waitUntil?.toISOString()).toBe(at(12));
    expect(t.steps.find((s) => s.key === 'waiting')?.label).toBe('waiting 12 s (gap between sends)');
  });

  it('a message whose time has come is typing', () => {
    const t = messageTimeline({ ...base, dueAt: at(-1) }, NOW);
    expect(stateOf(t).typing).toBe('current');
    expect(stateOf(t).waiting).toBe('done');
  });

  it('sent, delivered and read walk along the steps, with their times', () => {
    const sent = messageTimeline({ ...base, status: 'sent', sentAt: at(-30) }, NOW);
    expect(stateOf(sent)).toMatchObject({ typing: 'done', sent: 'current', delivered: 'todo' });
    const read = messageTimeline({ ...base, status: 'read', sentAt: at(-30), deliveredAt: at(-20), readAt: at(-5) }, NOW);
    expect(stateOf(read)).toMatchObject({ sent: 'done', delivered: 'done', read: 'current' });
    expect(read.steps.find((s) => s.key === 'delivered')?.at).toBe(at(-20));
    expect(read.outcome).toBe('in_flight');
  });

  it('a held message shows the hold, not a countdown', () => {
    const t = messageTimeline({ ...base, holdReason: 'timelock', holdUntil: at(600), dueAt: at(5) }, NOW);
    expect(t.outcome).toBe('held');
    expect(t.reason).toEqual({ code: 'timelock', until: at(600), detail: null });
    expect(t.waitUntil).toBeNull();
  });

  it('a failed message shows the failure with its code and the provider text', () => {
    const t = messageTimeline({ ...base, status: 'failed', errorCode: 'send_error', errorDetail: 'Connection Closed' }, NOW);
    expect(t.outcome).toBe('failed');
    expect(t.reason).toEqual({ code: 'send_error', until: null, detail: 'Connection Closed' });
    expect(stateOf(t).sent).toBe('todo');
  });

  it('a failed message with no recorded code still has a reason to show', () => {
    expect(messageTimeline({ ...base, status: 'failed' }, NOW).reason?.code).toBe('');
  });
});

describe('AC-10.5 waiting counts down from the clock it is given', () => {
  it('the same message reads 12 s, then 7 s, as the clock moves', () => {
    const m = { ...base, dueAt: at(12) };
    expect(messageTimeline(m, NOW).steps.find((s) => s.key === 'waiting')?.label).toContain('12 s');
    expect(messageTimeline(m, new Date(NOW.getTime() + 5000)).steps.find((s) => s.key === 'waiting')?.label).toContain('7 s');
  });

  it('formats waits in the unit a person reads', () => {
    expect(formatWait(12_000)).toBe('12 s');
    expect(formatWait(185_000)).toBe('3 min 05 s');
    expect(formatWait(2 * 3_600_000 + 10 * 60_000)).toBe('2 h 10 min');
    expect(formatWait(-4)).toBe('0 s');
  });

  describe('CW-2.5 countdowns only for short waits', () => {
    const w = (s: number): string => formatWait(s * 1000, { now: NOW, ...tz });
    it('under a minute: seconds, ticking', () => {
      expect(w(59)).toBe('59 s');
      expect(w(12)).toBe('12 s');
    });
    it('1 to 10 minutes: in about N min', () => {
      expect(w(61)).toBe('in about 1 min');
      expect(w(240)).toBe('in about 4 min');
      expect(w(9 * 60 + 59)).toBe('in about 10 min');
    });
    it('longer: a clock time, and "tomorrow" for the next day', () => {
      expect(w(10 * 60 + 1)).toBe('at 10:10');
      expect(w(23 * 3600)).toBe('at 09:00 tomorrow');
    });
    it('waitPhrase reads inside a sentence', () => {
      const p = (s: number): string => waitPhrase(s * 1000, { now: NOW, ...tz });
      expect([p(12), p(240), p(3600)]).toEqual(['in 12 s', 'in about 4 min', 'at 11:00']);
    });
    it('the number card uses it', () => {
      const lane = { waiting: 3, nextSendAt: at(240), hold: null };
      expect(laneLines(lane, NOW, tz).sending).toBe('Sending next in about 4 min');
      expect(laneLines({ ...lane, nextSendAt: at(7200) }, NOW, tz).sending).toBe('Sending next at 12:00');
    });
  });
});

describe('AC-10.3 the ETA sentence', () => {
  const none = { goNow: 0, afterReset: 0, resetAt: null, goNowEndsAt: null, basis: 'time_only' as const, delayedBy: [] };

  it('Done by about 17:42 when everything goes in one stretch', () => {
    const l = etaLines({ ...none, finishAt: '2026-10-31T17:42:00Z', goNow: 500 }, NOW, tz);
    expect(l.headline).toBe('Done by about 17:42');
    expect(l.delay).toBeNull();
  });

  it('says tomorrow for a finish on the next day', () => {
    expect(etaLines({ ...none, finishAt: '2026-11-01T02:10:00Z', goNow: 5 }, NOW, tz).headline).toBe('Done by about 02:10 tomorrow');
  });

  it('370 go now, finishing 15:10; 130 after the reset at 09:00 tomorrow', () => {
    const l = etaLines({
      finishAt: '2026-11-01T11:00:00Z', goNow: 370, afterReset: 130, resetAt: '2026-11-01T09:00:00Z',
      goNowEndsAt: '2026-10-31T15:10:00Z', basis: 'quota', delayedBy: []
    }, NOW, tz);
    expect(l.headline).toBe("370 go now, finishing 15:10; 130 after WhatsApp's reset at 09:00 tomorrow");
  });

  it('with nothing going now it says so instead of "0 go now"', () => {
    const l = etaLines({
      finishAt: '2026-11-01T10:00:00Z', goNow: 0, afterReset: 40, resetAt: '2026-11-01T09:00:00Z',
      goNowEndsAt: null, basis: 'quota', delayedBy: []
    }, NOW, tz);
    expect(l.headline).toBe("None go now; 40 wait for WhatsApp's reset at 09:00 tomorrow, finishing 10:00 tomorrow");
  });

  it('nothing left to send says so', () => {
    expect(etaLines({ ...none, finishAt: null }, NOW, tz).headline).toBe('Nothing left to send.');
  });

  it('CW-3.9 says why it takes this long, and how much is left', () => {
    const l = etaLines({ ...none, finishAt: at(38 * 60), goNow: 5 }, NOW, tz);
    expect(l.why).toBe("We send one message every 1 to 50 seconds, like a person would, so WhatsApp doesn't flag your number.");
    expect(l.left).toBe('38 min left');
    expect(etaLines({ ...none, finishAt: null }, NOW, tz).why).toBeNull();
  });

  it('CW-3.9 says what moved the finish: 40 min later, replies first, new-chat limit resets at 09:00', () => {
    const l = etaLines({
      finishAt: '2026-11-01T11:00:00Z', goNow: 5, afterReset: 0, resetAt: '2026-11-01T09:00:00Z', goNowEndsAt: null, basis: 'quota',
      delayedBy: [{ reason: 'reply_priority', seconds: 600 }, { reason: 'new_chat_cap', seconds: 1800 }, { reason: 'timelock', seconds: 0 }]
    }, NOW, tz);
    expect(l.delay).toBe("40 min later than planned: replies go first, and WhatsApp's new-chat limit resets at 09:00 tomorrow.");
  });

  it('CW-3.9 a single reason has no "and"', () => {
    const l = etaLines({ ...none, finishAt: at(3600), goNow: 5, delayedBy: [{ reason: 'quiet_hours', seconds: 3900 }] }, NOW, tz);
    expect(l.delay).toBe('1 h 05 min later than planned: quiet hours are on.');
  });
});

describe('AC-10.4 the number card', () => {
  const lane = { waiting: 3, nextSendAt: at(12), hold: null };

  it('Sending next in 12 s, counting down', () => {
    expect(laneLines(lane, NOW, tz).sending).toBe('Sending next in 12 s');
    expect(laneLines(lane, new Date(NOW.getTime() + 9000), tz).sending).toBe('Sending next in 3 s');
  });

  it('Sending now when the gap has passed', () => {
    expect(laneLines({ ...lane, nextSendAt: at(-2) }, NOW, tz).sending).toBe('Sending now');
  });

  it('nothing waiting says nothing is waiting', () => {
    expect(laneLines({ waiting: 0, nextSendAt: null, hold: null }, NOW, tz).sending).toBe('Nothing waiting to send');
  });

  it('Holding new chats: timelock until 14:20', () => {
    const l = laneLines({ waiting: 0, nextSendAt: null, hold: { reason: 'timelock', until: '2026-10-31T14:20:00Z' } }, NOW, tz);
    expect(l.holding).toBe('Holding new chats: timelock until 14:20');
  });

  it('a hold with no end time does not invent one', () => {
    const l = laneLines({ waiting: 2, nextSendAt: null, hold: { reason: 'timelock', until: null } }, NOW, tz);
    expect(l.holding).toBe('Holding new chats: timelock');
  });

  it('other holds read in the sentence of the reason code', () => {
    const l = laneLines({ waiting: 2, nextSendAt: null, hold: { reason: 'decrypt_wave', until: null } }, NOW, tz);
    expect(l.holding).toBe('Holding: Several contacts could not read our messages. Sending is paused.');
  });

  it('shows the warning level with quota used out of total', () => {
    expect(quotaLine({ cappingStatus: 'FIRST_WARNING', cappingUsedQuota: 12, cappingTotalQuota: 50, cappingCycleEnd: '2026-11-01T09:00:00Z' }, NOW, tz))
      .toEqual({ level: 'First warning', tone: 'warn', used: '12 of 50 new chats used', resets: 'resets at 09:00 tomorrow' });
    expect(quotaLine({ cappingStatus: 'CAPPED', cappingUsedQuota: 50, cappingTotalQuota: 50, cappingCycleEnd: null }, NOW, tz))
      .toMatchObject({ level: 'Capped', tone: 'danger', used: '50 of 50 new chats used', resets: null });
    expect(quotaLine({ cappingStatus: null, cappingUsedQuota: null, cappingTotalQuota: null, cappingCycleEnd: null }, NOW, tz))
      .toEqual({ level: 'No report from WhatsApp yet', tone: 'ok', used: null, resets: null });
  });
});

describe('AC-7.2 the new-campaign form warns about text with no variation', () => {
  it('knows a {a|b} choice from plain text and from a {{name}} placeholder', () => {
    expect(hasVariation('{Hi|Hello} {{name}}')).toBe(true);
    expect(hasVariation('Hi {{name}}, a message')).toBe(false);
    expect(hasVariation('Hi there')).toBe(false);
    expect(hasVariation('a | b')).toBe(false);
  });
});
