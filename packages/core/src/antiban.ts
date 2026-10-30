/**
 * The seam every outbound message passes through on its way to the provider.
 *
 * The gateway asks the policy two questions and nothing else: may this message go now
 * (`beforeSend`), and how many more campaign messages may be queued for this number
 * (`campaignBatch`). Everything that decides how fast or how many lives behind this interface,
 * so a replacement anti-ban driver plugs in here and the send path does not change.
 *
 * What does not go through the policy: who may be messaged at all (do-not-contact, the recipient
 * policy gates in `policy-gates.ts`), a number that is not connected, and the typing beat.
 */

/** What the gateway tells the policy about the message about to go out. */
export interface SendContext {
  readonly senderIdentityId: string;
  readonly now: Date;
  /** When this number last sent anything (a reply, an AI message or a campaign message), or null if never. */
  readonly lastSentAt: Date | null;
}

/** The policy's answer: go, go after a pause, or leave the message queued with a reason shown in the thread. */
export type SendDecision =
  | { readonly action: 'send' }
  | { readonly action: 'wait'; readonly ms: number }
  | { readonly action: 'hold'; readonly reason: string };

/** What the gateway tells the policy when it is about to top a campaign's queue up. */
export interface BatchContext {
  readonly senderIdentityId: string;
  /** Messages already queued and not yet sent for this number, from any source. */
  readonly waiting: number;
}

/** What a driver provides: the two questions the gateway asks, and nothing else. */
export interface AntiBanPolicy {
  /** Called once per send attempt, after the gates that protect people and before anything reaches the provider. */
  beforeSend(ctx: SendContext): Promise<SendDecision>;
  /** How many more campaign messages the dispatcher may queue for this number right now. */
  campaignBatch(ctx: BatchContext): number;
}

/** The shortest gap between two sends from one number, in milliseconds. */
export const BASIC_GAP_MIN_MS = 3_000;
/** The longest gap between two sends from one number, in milliseconds. */
export const BASIC_GAP_MAX_MS = 8_000;
/** Campaign messages waiting per number at any one time. */
export const BASIC_BATCH = 20;

/** The basic policy with an injectable random source, so a test can pin the gap. */
export function makeBasicPolicy(rng: () => number = Math.random): AntiBanPolicy {
  return {
    beforeSend({ now, lastSentAt }) {
      if (lastSentAt === null) return Promise.resolve({ action: 'send' });
      const gap = BASIC_GAP_MIN_MS + Math.floor(rng() * (BASIC_GAP_MAX_MS - BASIC_GAP_MIN_MS));
      const wait = gap - (now.getTime() - lastSentAt.getTime());
      return Promise.resolve(wait > 0 ? { action: 'wait', ms: wait } : { action: 'send' });
    },
    campaignBatch({ waiting }) {
      return Math.max(0, BASIC_BATCH - waiting);
    }
  };
}

/**
 * Placeholder until the new anti-ban driver replaces it: a random 3 to 8 second gap between sends from one number, and at
 * most 20 campaign messages waiting per number. There are no daily caps, by design (a user decision), and it does not look
 * at delivery, replies or the time of day.
 */
export const basicPolicy: AntiBanPolicy = makeBasicPolicy();
