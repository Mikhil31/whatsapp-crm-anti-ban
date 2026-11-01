import { describe, expect, it } from 'vitest';
import { estimateTimes, reachSummary, rowStatus, statusWord } from './recipient-status';

const NOW = new Date('2026-10-31T10:00:00Z');
const tz = { timeZone: 'UTC' };
const at = (s: number): string => new Date(NOW.getTime() + s * 1000).toISOString();
const p = { total: 0, pending: 0, queued: 0, sent: 0, delivered: 0, read: 0, failed: 0, skipped: 0 };

describe('CW-2.3 "Sent" means sent', () => {
  it('5 sent and 2 failed of 10 is "5 of 10 reached"', () => {
    const s = reachSummary({ ...p, total: 10, sent: 5, failed: 2, queued: 3 });
    expect(s.reached).toBe(5);
    expect(s.headline).toBe('5 of 10 reached · 2 not yet');
  });
  it('212 of 500 reached · 17 not yet; skipped people are not yet too', () => {
    expect(reachSummary({ ...p, total: 500, sent: 212, failed: 10, skipped: 7, queued: 271 }).headline).toBe('212 of 500 reached · 17 not yet');
  });
  it('nobody not yet leaves the tail off', () => {
    expect(reachSummary({ ...p, total: 4, sent: 4 }).headline).toBe('4 of 4 reached');
  });
});

describe('CW-2.1 the count line', () => {
  it('Sent, Delivered, Read, Not yet, each with its filter', () => {
    const s = reachSummary({ ...p, total: 10, sent: 8, delivered: 5, read: 2, failed: 1, skipped: 1 });
    expect(s.counts.map((c) => [c.label, c.value, c.key])).toEqual([
      ['Sent', 8, 'sent'], ['Delivered', 5, 'delivered'], ['Read', 2, 'read'], ['Not yet', 2, 'not_yet']
    ]);
  });
});

describe('CW-2.4 queued and pending both read Waiting', () => {
  it('maps every state to one word', () => {
    expect(statusWord({ status: 'queued', messageStatus: 'queued' })).toBe('Waiting');
    expect(statusWord({ status: 'pending', messageStatus: null })).toBe('Waiting');
    expect(statusWord({ status: 'failed', messageStatus: 'failed' })).toBe('Not yet');
    expect(statusWord({ status: 'skipped', messageStatus: null })).toBe('Not yet');
    expect(statusWord({ status: 'sent', messageStatus: 'sent' })).toBe('Sent');
    expect(statusWord({ status: 'sent', messageStatus: 'delivered' })).toBe('Delivered');
    expect(statusWord({ status: 'sent', messageStatus: 'read' })).toBe('Read');
  });
});

describe('CW-2.2 a row in words', () => {
  const waiting = { status: 'queued', messageStatus: 'queued' };
  it('Waiting with a guessed time', () => {
    const r = rowStatus(waiting, { now: NOW, around: new Date(at(2340)), ...tz });
    expect(r).toEqual({ word: 'Waiting', detail: 'around 10:39', typing: false });
  });
  it('the head of the lane is Sending in 12 s with typing dots', () => {
    expect(rowStatus(waiting, { now: NOW, dueAt: new Date(at(12)), ...tz })).toEqual({ word: 'Sending', detail: 'in 12 s', typing: true });
    expect(rowStatus(waiting, { now: NOW, dueAt: new Date(at(-1)), ...tz }).detail).toBe('now');
  });
  it('a held row says why, in words', () => {
    const r = rowStatus({ ...waiting, holdReason: 'quiet_hours', holdUntil: '2026-10-31T08:00:00Z' }, { now: NOW, dueAt: new Date(at(5)), ...tz });
    expect(r.word).toBe('Waiting');
    expect(r.detail).toBe('Quiet hours · goes 08:00');
    expect(r.typing).toBe(false);
  });
  it('Sent, Delivered and Read each carry their time', () => {
    const f = { sentAt: '2026-10-31T09:50:00Z', deliveredAt: '2026-10-31T09:51:00Z', readAt: '2026-10-31T09:58:00Z' };
    expect(rowStatus({ status: 'sent', messageStatus: 'sent', ...f }, { now: NOW, ...tz })).toMatchObject({ word: 'Sent', detail: '09:50' });
    expect(rowStatus({ status: 'sent', messageStatus: 'delivered', ...f }, { now: NOW, ...tz })).toMatchObject({ word: 'Delivered', detail: '09:51' });
    expect(rowStatus({ status: 'sent', messageStatus: 'read', ...f }, { now: NOW, ...tz })).toMatchObject({ word: 'Read', detail: '09:58' });
  });
});

describe('estimateTimes', () => {
  it('adds one planned gap per waiting row after the head, skipping held rows', () => {
    const rows = [
      { id: 'a', status: 'sent' }, { id: 'b', status: 'queued', plannedGapMs: 9000 },
      { id: 'c', status: 'queued', plannedGapMs: 20_000 }, { id: 'd', status: 'queued', holdReason: 'quiet_hours', plannedGapMs: 5000 },
      { id: 'e', status: 'pending', plannedGapMs: 30_000 }
    ];
    const m = estimateTimes(rows, 'b', new Date(at(10)));
    expect([...m.entries()].map(([k, v]) => [k, v.toISOString()])).toEqual([['c', at(30)], ['e', at(60)]]);
  });
  it('gives nothing without a head', () => {
    expect(estimateTimes([{ id: 'a', status: 'queued' }], null, null).size).toBe(0);
  });
});
