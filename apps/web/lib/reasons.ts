/**
 * The one place that turns a reason code into words (F6 S10). A message that is held or failed, a campaign recipient and a number
 * all carry a short code from the engine; every screen shows it through here, so the same code reads the same everywhere and the
 * action beside it is the same too.
 */

/** What a person can do about a reason. The screen decides how to do it; this only names it. */
export type ReasonAction = 'retry' | 'relink' | 'resume' | 'lift' | 'send_by_hand' | 'send_now';

/** A code made readable. */
export interface Reason {
  /** The code as the engine stored it. */
  readonly code: string;
  /** False for a code this module has no sentence for. */
  readonly known: boolean;
  readonly sentence: string;
  readonly action: ReasonAction | null;
  /** The button text for `action`, or null. */
  readonly actionLabel: string | null;
}

/** What a sentence can be filled in with. */
export interface ReasonContext {
  /** When the hold is expected to lift, or null/absent when it waits for something. */
  readonly until?: Date | string | null;
  /** The provider's own words, for `send_error`. */
  readonly detail?: string | null;
  /** An IANA zone for the clock time. Absent means the viewer's own. */
  readonly timeZone?: string;
}

const LABEL: Record<ReasonAction, string> = {
  retry: 'Retry', relink: 'Relink', resume: 'Resume', lift: 'Lift', send_by_hand: 'Send by hand', send_now: 'Send now'
};

/** `HH:MM`, 24 hours, in `timeZone` (the viewer's own when absent). */
export function clockTime(at: Date | string, timeZone?: string): string {
  return new Intl.DateTimeFormat('en-GB', {
    hour: '2-digit', minute: '2-digit', hour12: false, ...(timeZone === undefined ? {} : { timeZone })
  }).format(typeof at === 'string' ? new Date(at) : at);
}

type Make = (time: string | null, detail: string | null) => string;
interface Entry { readonly say: Make; readonly action: ReasonAction | null }

const BY_CODE: Record<string, Entry> = {
  timelock: {
    say: (t) => t === null ? 'WhatsApp is not letting this number start new chats right now.'
      : `WhatsApp is not letting this number start new chats until ${t}.`,
    action: null
  },
  new_chat_cap: {
    say: (t) => t === null ? "WhatsApp's new-chat limit for this number is used up."
      : `WhatsApp's new-chat limit for this number is used up until ${t}.`,
    action: null
  },
  refused_463: { say: () => 'WhatsApp refused messages to this contact.', action: 'retry' },
  unlinked: { say: () => 'The number was unlinked from the phone.', action: 'relink' },
  many_undelivered: {
    say: () => 'Many recent messages are not reaching people. WhatsApp may be limiting this number.', action: 'resume'
  },
  decrypt_retry: {
    say: () => "This contact's phone could not read our last message yet. Waiting until it can.", action: null
  },
  decrypt_wave: { say: () => 'Several contacts could not read our messages. Sending is paused.', action: 'relink' },
  likely_blocked: { say: () => 'This contact has probably blocked the number.', action: 'send_by_hand' },
  dnc: { say: () => 'This contact asked not to be messaged.', action: 'lift' },
  not_on_whatsapp: { say: () => 'This number is not on WhatsApp.', action: null },
  quiet_hours: {
    say: (t) => t === null ? 'Waiting for quiet hours to end.' : `Waiting for quiet hours to end at ${t}.`,
    action: 'send_now'
  },
  send_error: {
    say: (_t, d) => d === null || d.trim() === '' ? 'The send failed.' : `The send failed: ${d}`,
    action: 'retry'
  },
  // Codes the gateway writes that the S10 table does not list. Plain words, so none of them reads as an unknown code.
  sender_not_connected: { say: () => 'The number is not connected right now.', action: 'relink' },
  no_whatsapp_number: { say: () => 'This contact has no phone number to send to.', action: null },
  own_number: { say: () => 'This is the number sending the message; WhatsApp cannot message itself.', action: null },
  empty_body: { say: () => 'The message has no text.', action: null },
  media_storage_unavailable: { say: () => 'The attached file could not be read from storage.', action: 'retry' }
};

/** Codes that are another spelling of one above. */
const ALIAS: Record<string, string> = { whatsapp_refused_463: 'refused_463', do_not_contact: 'dnc' };

/** Turns a reason code into a sentence and, where one exists, an action. Never blank, whatever the code. */
export function describeReason(code: string | null | undefined, ctx: ReasonContext = {}): Reason {
  const raw = (code ?? '').trim();
  const entry = BY_CODE[ALIAS[raw] ?? raw];
  if (entry === undefined) {
    return {
      code: raw, known: false, action: null, actionLabel: null,
      sentence: raw === '' ? 'No reason was recorded.' : `Held or failed for a reason this screen does not know yet (${raw}).`
    };
  }
  const time = ctx.until === undefined || ctx.until === null ? null : clockTime(ctx.until, ctx.timeZone);
  return {
    code: raw, known: true, sentence: entry.say(time, ctx.detail ?? null),
    action: entry.action, actionLabel: entry.action === null ? null : LABEL[entry.action]
  };
}
