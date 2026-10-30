import { describe, expect, it } from 'vitest';
import { basicPolicy, makeBasicPolicy, BASIC_GAP_MIN_MS, BASIC_GAP_MAX_MS, BASIC_BATCH } from './antiban.js';

const sender = 'sender-1';
const at = (ms: number) => new Date(1_700_000_000_000 + ms);

describe('basicPolicy.beforeSend', () => {
  it('sends straight away when this sender has never sent', async () => {
    const d = await basicPolicy.beforeSend({ senderIdentityId: sender, now: at(0), lastSentAt: null });
    expect(d).toEqual({ action: 'send' });
  });

  it('sends when the last send was longer ago than the longest gap', async () => {
    const d = await basicPolicy.beforeSend({
      senderIdentityId: sender, now: at(BASIC_GAP_MAX_MS), lastSentAt: at(-1)
    });
    expect(d).toEqual({ action: 'send' });
  });

  it('waits when the last send was under the shortest gap ago, for the rest of a 3-8 s gap', async () => {
    for (let i = 0; i < 200; i++) {
      const d = await basicPolicy.beforeSend({ senderIdentityId: sender, now: at(1_000), lastSentAt: at(0) });
      expect(d.action).toBe('wait');
      if (d.action !== 'wait') return;
      // The gap drawn is 3-8 s; 1 s of it has gone.
      expect(d.ms).toBeGreaterThanOrEqual(BASIC_GAP_MIN_MS - 1_000);
      expect(d.ms).toBeLessThanOrEqual(BASIC_GAP_MAX_MS - 1_000);
    }
  });

  it('draws the gap uniformly from 3 to 8 seconds', async () => {
    const low = makeBasicPolicy(() => 0);
    const high = makeBasicPolicy(() => 0.999999);
    const a = await low.beforeSend({ senderIdentityId: sender, now: at(0), lastSentAt: at(0) });
    const b = await high.beforeSend({ senderIdentityId: sender, now: at(0), lastSentAt: at(0) });
    expect(a).toEqual({ action: 'wait', ms: 3_000 });
    expect(b.action === 'wait' && b.ms).toBeGreaterThan(7_990);
    expect(b.action === 'wait' && b.ms).toBeLessThanOrEqual(8_000);
  });

  it('sends once the drawn gap has passed, and waits while it has not', async () => {
    const p = makeBasicPolicy(() => 0.5);          // a 5.5 s gap
    expect(await p.beforeSend({ senderIdentityId: sender, now: at(5_000), lastSentAt: at(0) }))
      .toEqual({ action: 'wait', ms: 500 });
    expect(await p.beforeSend({ senderIdentityId: sender, now: at(5_500), lastSentAt: at(0) }))
      .toEqual({ action: 'send' });
  });

  it('never holds: it only ever spaces sends out', async () => {
    const d = await basicPolicy.beforeSend({ senderIdentityId: sender, now: at(0), lastSentAt: at(0) });
    expect(d.action).not.toBe('hold');
  });
});

describe('basicPolicy.campaignBatch', () => {
  it('queues up to twenty waiting messages per sender at a time', () => {
    expect(BASIC_BATCH).toBe(20);
    expect(basicPolicy.campaignBatch({ senderIdentityId: sender, waiting: 0 })).toBe(20);
    expect(basicPolicy.campaignBatch({ senderIdentityId: sender, waiting: 5 })).toBe(15);
  });

  it('queues nothing more while twenty or more are already waiting', () => {
    expect(basicPolicy.campaignBatch({ senderIdentityId: sender, waiting: 20 })).toBe(0);
    expect(basicPolicy.campaignBatch({ senderIdentityId: sender, waiting: 400 })).toBe(0);
  });
});
