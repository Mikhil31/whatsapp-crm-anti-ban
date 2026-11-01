import { describe, expect, it } from 'vitest';
import { describeReason, clockTime, reasonLabel } from './reasons';

const UNTIL = new Date('2026-10-31T14:20:00Z');
const tz = { timeZone: 'UTC' };

describe('reason codes (F6 S10)', () => {
  it('AC-10.1 timelock names the time and has no action', () => {
    const r = describeReason('timelock', { until: UNTIL, ...tz });
    expect(r.sentence).toBe('WhatsApp is not letting this number start new chats until 14:20.');
    expect(r.action).toBeNull();
  });

  it('AC-10.1 new_chat_cap names the time and has no action', () => {
    const r = describeReason('new_chat_cap', { until: UNTIL, ...tz });
    expect(r.sentence).toBe("WhatsApp's new-chat limit for this number is used up until 14:20.");
    expect(r.action).toBeNull();
  });

  it('AC-10.1 both spellings of the 463 refusal give Retry', () => {
    for (const code of ['refused_463', 'whatsapp_refused_463']) {
      const r = describeReason(code);
      expect(r.sentence).toBe('WhatsApp refused messages to this contact.');
      expect(r.action).toBe('retry');
      expect(r.actionLabel).toBe('Try again');
    }
  });

  it('AC-10.1 unlinked gives Relink', () => {
    const r = describeReason('unlinked');
    expect(r.sentence).toBe('The number was unlinked from the phone.');
    expect(r.action).toBe('relink');
    expect(r.actionLabel).toBe('Link the number again');
  });

  it('AC-10.1 many_undelivered gives Resume', () => {
    const r = describeReason('many_undelivered');
    expect(r.sentence).toBe('Many recent messages are not reaching people. WhatsApp may be limiting this number.');
    expect(r.action).toBe('resume');
  });

  it('AC-10.1 decrypt_retry waits with no action, decrypt_wave gives Relink', () => {
    expect(describeReason('decrypt_retry')).toMatchObject({
      sentence: "This contact's phone could not read our last message yet. Waiting until it can.", action: null
    });
    expect(describeReason('decrypt_wave')).toMatchObject({
      sentence: 'Several contacts could not read our messages. Sending is paused.', action: 'relink'
    });
  });

  it('AC-10.1 likely_blocked gives Send by hand', () => {
    const r = describeReason('likely_blocked');
    expect(r.sentence).toBe('This contact has probably blocked the number.');
    expect(r.action).toBe('send_by_hand');
    expect(r.actionLabel).toBe('Open chat');
  });

  it('AC-10.1 dnc and do_not_contact both give Lift', () => {
    for (const code of ['dnc', 'do_not_contact']) {
      const r = describeReason(code);
      expect(r.sentence).toBe('This contact asked not to be messaged.');
      expect(r.action).toBe('lift');
      expect(r.actionLabel).toBe('Allow messages again');
    }
  });

  it('AC-10.1 not_on_whatsapp has no action', () => {
    expect(describeReason('not_on_whatsapp')).toMatchObject({ sentence: 'This number is not on WhatsApp.', action: null });
  });

  it('AC-10.1 quiet_hours names the time and gives Send now', () => {
    const r = describeReason('quiet_hours', { until: UNTIL, ...tz });
    expect(r.sentence).toBe('Waiting for quiet hours to end at 14:20.');
    expect(r.action).toBe('send_now');
  });

  it('AC-10.1 send_error shows the provider message and gives Retry', () => {
    const r = describeReason('send_error', { detail: 'Connection Closed' });
    expect(r.sentence).toBe('The send failed: Connection Closed');
    expect(r.action).toBe('retry');
  });

  it('AC-10.1 send_error without a provider message still reads as a sentence', () => {
    expect(describeReason('send_error').sentence).toBe('The send failed.');
  });

  it('AC-10.1 a hold with no expected time says so without a made-up time', () => {
    expect(describeReason('timelock', { until: null }).sentence).toBe('WhatsApp is not letting this number start new chats right now.');
    expect(describeReason('quiet_hours', { until: null }).sentence).toBe('Waiting for quiet hours to end.');
    expect(describeReason('new_chat_cap').sentence).not.toMatch(/HH:MM|undefined|null/);
  });

  it('AC-10.1 an unknown code is never blank: a generic sentence and the raw code', () => {
    const r = describeReason('something_new');
    expect(r.known).toBe(false);
    expect(r.sentence).toContain('something_new');
    expect(r.sentence.length).toBeGreaterThan(10);
    expect(r.action).toBeNull();
  });

  it('AC-10.1 no code at all is also not blank', () => {
    expect(describeReason(null).sentence).not.toBe('');
    expect(describeReason('').sentence).not.toBe('');
  });

  it('AC-10.1 codes the lane writes that are not in the S10 table still read as plain words', () => {
    expect(describeReason('sender_not_connected').action).toBe('relink');
    expect(describeReason('own_number').known).toBe(true);
    expect(describeReason('no_whatsapp_number').known).toBe(true);
  });

  it('AC-10.2 the reasons a campaign skips a recipient read as sentences too', () => {
    for (const code of ['no_phone', 'cancelled', 'engaged', 'cooldown', 'in_other_campaign']) {
      expect(describeReason(code).known).toBe(true);
    }
  });

  it('clockTime gives HH:MM in the zone asked for', () => {
    expect(clockTime(UNTIL, 'UTC')).toBe('14:20');
    expect(clockTime('2026-10-31T09:05:00Z', 'Asia/Kolkata')).toBe('14:35');
  });
});

describe('CW-8.3 and CW-2.4 plain wording', () => {
  it('CW-8.3 Resume keeps its name until the engine stops pausing numbers', () => {
    expect(describeReason('many_undelivered').actionLabel).toBe('Resume');
  });

  it('CW-2.4 reasons read as words, never as codes', () => {
    expect(reasonLabel('refused_463')).toBe('WhatsApp refused');
    expect(reasonLabel('whatsapp_refused_463')).toBe('WhatsApp refused');
    expect(reasonLabel('quiet_hours')).toBe('Quiet hours');
    expect(reasonLabel('something_new_999')).toBe('Other reason');
    expect(reasonLabel(null)).toBe('Other reason');
  });
});
