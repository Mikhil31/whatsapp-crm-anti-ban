import type { LlmDriver } from '@crm/llm';
import { sql } from 'drizzle-orm';
import { setTenant, type Database, type Transaction } from '@crm/db';
import { tenantDatabase } from './tenant.js';
import { chooseRecipientNumber } from './number-fallback.js';
import type { ChannelProvider, NormalisedConnectionEvent } from '@crm/channels';
import {
  classifyLinkFailure, encodeLinkError,
  markMessageFailed, markMessageSent, dispatchCampaign, reconcileCampaign, writeOpenings, typingDelayMs,
  basicPolicy, type AntiBanPolicy, recordHealthEvent, reencryptBatch
} from '@crm/core';
import type { Logger } from '@crm/shared';
import type { KmsDriver } from '@crm/kms-local';
import type { StorageDriver } from '@crm/storage';

/** A queued outbound message, joined to everything needed to actually send it. */
interface QueuedSend {
  readonly messageId: string;
  readonly orgId: string;
  readonly senderIdentityId: string;
  readonly senderPhone: string | null;
  /** Who the message is to, for the number-fallback lookup. */
  readonly contactId: string;
  /** Flagged do-not-contact; refused unless an admin overrode it for this message (`dncOverride`). */
  readonly doNotContact: boolean;
  readonly dncOverride: boolean;
  readonly recipientValue: string;
  readonly recipientKind: string;
  readonly bodyEnc: Uint8Array | null;
  /** The attachment this message carries (D-25), or null for plain text. */
  readonly mediaStorageKey: string | null;
  readonly mediaContentType: string | null;
  readonly mediaGifPlayback: boolean | null;
  readonly mediaFilename: string | null;
}

/** A pending request from the API to link a number. */
interface PendingLink {
  readonly sessionId: string;
  readonly senderIdentityId: string;
  readonly mode: 'qr' | 'pairing_code';
  readonly phone: string | null;
}

/** Everything the work handlers need. Passed in, never imported, so they stay testable. */
export interface WorkContext {
  readonly db: Database;
  /**
   * Encrypts a campaign body on its way into a message. Absent in contexts that never
   * dispatch a campaign, which is most tests.
   */
  readonly kms?: KmsDriver;
  /** The AI model, for campaigns whose first messages the AI writes. Absent = such campaigns wait. */
  readonly llm?: LlmDriver;
  readonly provider: ChannelProvider;
  readonly logger: Logger;
  /** Decrypts a stored message body back to text for sending. */
  readonly decrypt: (cipher: Uint8Array) => string;
  /**
   * What decides when a message may go and how many campaign messages queue at once. Absent = `basicPolicy`, so a
   * context that says nothing still spaces its sends out; tests that want none of it pass a policy that always sends.
   */
  readonly antiBan?: AntiBanPolicy;
  /** Most identical message bodies a sender may hold per 24h (D-26). Absent = no cap. */
  readonly identicalBodyCap?: number;
  /**
   * Emit a `composing` presence and pause a human-like beat before each send (D-24). Opt-in, so tests that do
   * not exercise it are unaffected and add no real delay. A failure to signal presence never fails the send.
   */
  readonly typingSimulation?: boolean;
  /**
   * Before the first send to a contact with more than one phone number, ask the transport whether the
   * primary number has a WhatsApp account, and use the next one that does (D-60). Opt-in like the
   * other behaviour layers, so tests that do not exercise it never trigger a lookup.
   */
  readonly verifyFallbackNumbers?: boolean;
  /**
   * The restricted role tenant-scoped work drops to (`crm_app`), as resolved at startup by
   * `resolveTenantRole`. Null or absent when the connecting role is already subject to row-level
   * security, or in tests that run as a superuser and only need the org set (D-41).
   */
  readonly tenantRole?: string | null;
  /** How many of the oldest queued messages one sweep attempts. Default 200. */
  readonly sweepBatchSize?: number;
  /**
   * Where stored files live, so a queued message that carries one can be read back and sent
   * (D-25). Absent in tests that only send text; a media message with no storage fails visibly.
   */
  readonly storage?: StorageDriver;
  /**
   * Waits before a send. Injected so tests do not spend real seconds on the gap between sends — production
   * passes a real sleep, and skipping it entirely would defeat the point of the gap.
   */
  readonly sleep?: (ms: number) => Promise<void>;
}

/**
 * The same context with its database pinned to one org (D-41). Everything the gateway does for a
 * tenant goes through one of these, so Postgres, not each query's `WHERE org_id`, is what keeps
 * one org's rows away from another's.
 */
function scopedTo(ctx: WorkContext, orgId: string): WorkContext {
  return { ...ctx, db: tenantDatabase(ctx.db, orgId, ctx.tenantRole ?? null) };
}

/**
 * Every org id, for a sweep that has to look at all tenants. This and the small "which org owns
 * this id" lookups below are the gateway's only unscoped reads, and they return ids alone: the
 * work itself always runs through `scopedTo`.
 */
async function allOrgIds(ctx: WorkContext): Promise<string[]> {
  const rows = await ctx.db.execute(sql`SELECT id FROM org`);
  return (rows as unknown as Array<{ id: string }>).map((r) => r.id);
}

/** Runs `work` once per org, each time with a context pinned to that org, and collects the results. */
async function inEachOrg<T>(ctx: WorkContext, work: (scoped: WorkContext) => Promise<T>): Promise<T[]> {
  const out: T[] = [];
  for (const orgId of await allOrgIds(ctx)) out.push(await work(scopedTo(ctx, orgId)));
  return out;
}

/** The org that owns a sender, or null when there is no such sender. */
async function orgOfSender(ctx: WorkContext, senderId: string): Promise<string | null> {
  const rows = await ctx.db.execute(sql`SELECT org_id AS "orgId" FROM sender_identity WHERE id = ${senderId}`);
  return (rows as unknown as Array<{ orgId: string }>)[0]?.orgId ?? null;
}

/** The org that owns a link/unlink session (through its sender), or null when it is gone. */
async function orgOfSession(ctx: WorkContext, sessionId: string): Promise<string | null> {
  const rows = await ctx.db.execute(sql`
    SELECT si.org_id AS "orgId" FROM channel_session cs
    JOIN sender_identity si ON si.id = cs.sender_identity_id
    WHERE cs.id = ${sessionId}`);
  return (rows as unknown as Array<{ orgId: string }>)[0]?.orgId ?? null;
}

/**
 * Starts the linking handshake the API asked for, and writes the challenge back.
 *
 * The API cannot call the provider itself — the socket lives in this process — so the request
 * is left on `channel_session` and the QR or pairing code is returned through the same row.
 */
export async function handleLinkRequest(ctx: WorkContext, sessionId: string): Promise<void> {
  const orgId = await orgOfSession(ctx, sessionId);
  if (orgId === null) return;
  await handleLinkRequestInOrg(scopedTo(ctx, orgId), sessionId);
}

/** `handleLinkRequest` once the session's org is known and the context is pinned to it. */
async function handleLinkRequestInOrg(ctx: WorkContext, sessionId: string): Promise<void> {
  const rows = await ctx.db.execute(sql`
    SELECT cs.id            AS "sessionId",
           cs.sender_identity_id AS "senderIdentityId",
           cs.link_requested_mode AS mode,
           cs.link_requested_phone AS phone
    FROM channel_session cs
    WHERE cs.id = ${sessionId}
      AND cs.link_requested_at IS NOT NULL
      AND cs.link_challenge IS NULL`);
  const req = (rows as unknown as PendingLink[])[0];
  if (!req) return;                     // already handled, or superseded

  try {
    // A number that is not currently connected may still hold the credentials of a session WhatsApp
    // already ended (logged out on the phone). Linking on top of those makes WhatsApp refuse the login
    // and never show a QR, so clear them first. Never done for a live connection.
    const state = (await ctx.db.execute(sql`
      SELECT connection_state AS s FROM channel_session WHERE id = ${req.sessionId}`
    ) as unknown as Array<{ s: string | null }>)[0]?.s ?? null;
    if (state !== 'open') {
      await ctx.provider.logout(req.senderIdentityId).catch(() => undefined);
    }
    const challenge = await ctx.provider.link(
      req.senderIdentityId, req.mode, req.phone ?? undefined
    );
    await ctx.db.execute(sql`
      UPDATE channel_session
      SET link_challenge = ${JSON.stringify(challenge)}::jsonb,
          qr_expires_at = ${challenge.expiresAt.toISOString()},
          link_error = NULL,
          connection_state = 'connecting',
          updated_at = now()
      WHERE id = ${req.sessionId}`);
    ctx.logger.info({ senderId: req.senderIdentityId, mode: req.mode }, 'link challenge issued');
  } catch (error) {
    // Surface the failure on the row so the API can tell the caller, rather than leaving them
    // polling an endpoint that never resolves.
    const info = classifyLinkFailure(error);
    const message = error instanceof Error ? error.message : String(error);
    // The request is closed with the failure: leaving link_requested_at set made the sweep retry the
    // same doomed link every minute. The operator presses Link again when they want another try.
    await ctx.db.execute(sql`
      UPDATE channel_session
      SET link_error = ${encodeLinkError(info)}, link_requested_at = NULL,
          link_requested_mode = NULL, link_requested_phone = NULL,
          connection_state = CASE WHEN connection_state = 'connecting' THEN 'closed' ELSE connection_state END,
          updated_at = now()
      WHERE id = ${req.sessionId}`);
    ctx.logger.error(
      { senderId: req.senderIdentityId, code: info.code, statusCode: info.statusCode ?? null, err: message },
      'link request failed'
    );
  }
}

/**
 * Unlinks a number: logs it out on WhatsApp's side and discards the stored credentials.
 *
 * This is the recovery path a corrupt or logged-out session needs. Baileys only issues a fresh
 * QR when there are no stored credentials, so without clearing them a re-link just reloads the
 * broken session and never shows a QR. `provider.logout` clears them (and drops the socket if
 * one is live); afterwards the sender is back to awaiting a link, and the next link request
 * gets a clean QR.
 */
export async function handleUnlinkRequest(ctx: WorkContext, sessionId: string): Promise<void> {
  const orgId = await orgOfSession(ctx, sessionId);
  if (orgId === null) return;
  await handleUnlinkRequestInOrg(scopedTo(ctx, orgId), sessionId);
}

/** `handleUnlinkRequest` once the session's org is known and the context is pinned to it. */
async function handleUnlinkRequestInOrg(ctx: WorkContext, sessionId: string): Promise<void> {
  const rows = await ctx.db.execute(sql`
    SELECT sender_identity_id AS "senderIdentityId"
    FROM channel_session
    WHERE id = ${sessionId} AND unlink_requested_at IS NOT NULL`);
  const row = (rows as unknown as Array<{ senderIdentityId: string }>)[0];
  if (!row) return;                     // already handled, or superseded

  try {
    await ctx.provider.logout(row.senderIdentityId);
  } catch (error) {
    // Even if the logout call fails (no live socket, already gone from WhatsApp's side), the
    // stored credentials are what matter for a re-link, and logout clears those first. Log and
    // still reset the row so this does not loop.
    ctx.logger.warn(
      { senderId: row.senderIdentityId, err: error instanceof Error ? error.message : String(error) },
      'logout during unlink did not complete cleanly'
    );
  }

  // Return the sender to the same state as a freshly created, never-linked one — both the live
  // connection state and the business status, so neither is left describing a link that is gone
  // (the "written in both directions" rule, docs/00-prior-art.md).
  await ctx.db.execute(sql`
    UPDATE channel_session SET
      connection_state = 'closed', disconnect_reason = 'unlinked',
      link_requested_at = NULL, link_requested_mode = NULL, link_requested_phone = NULL,
      link_challenge = NULL, link_error = NULL, qr_expires_at = NULL,
      unlink_requested_at = NULL, updated_at = now()
    WHERE id = ${sessionId}`);
  await ctx.db.execute(sql`
    UPDATE sender_identity SET status = 'linking', updated_at = now()
    WHERE id = ${row.senderIdentityId}`);
  ctx.logger.info({ senderId: row.senderIdentityId }, 'number unlinked; credentials cleared');
}

/**
 * Messages this process is handling right now. A message can reach `handleSend` from the NOTIFY and from the sweep,
 * and each call may sleep before sending: without this a second caller arriving during the pause would send it twice.
 * In-process only; a second gateway process would need a database claim, which there is none of.
 */
const inFlight = new Set<string>();

/**
 * Sends one queued message.
 *
 * Every failure is recorded against that message and nothing else. In the previous system one
 * unsendable recipient threw and took down the whole engine, so the watchdog restarted it, the
 * operator retried, and it died again — a permanent crash loop for a single contact
 * (docs/00-prior-art.md, M26).
 *
 * There is no retry here, deliberately. Retrying into WhatsApp is exactly how a number gets banned, so a failed
 * message stays failed until a person sends it again.
 */
export async function handleSend(ctx: WorkContext, messageId: string): Promise<void> {
  if (inFlight.has(messageId)) return;
  inFlight.add(messageId);
  try {
    // One send at a time per number. The policy's gap is measured from the last send that has *left*, and a send
    // does not count until after its pause, so two messages checked at once would both see the same gap and both
    // go. Serialising per number makes check-then-send atomic, which is also the cadence the gap is there to produce.
    const owner = (await ctx.db.execute(sql`
      SELECT v.sender_identity_id AS "senderId", m.org_id AS "orgId"
      FROM message m JOIN conversation v ON v.id = m.conversation_id
      WHERE m.id = ${messageId}`) as unknown as Array<{ senderId: string; orgId: string }>)[0];
    if (owner === undefined) return;
    // Everything from here on runs pinned to the message's own org (D-41).
    const scoped = scopedTo(ctx, owner.orgId);
    await withSenderLock(owner.senderId, () => handleSendOnce(scoped, messageId));
  } finally {
    inFlight.delete(messageId);
  }
}

/** The tail of each number's send queue, so the next send for that number waits its turn. */
const senderLocks = new Map<string, Promise<void>>();

/**
 * Runs `work` after every earlier piece of work for the same sender has finished, whether it
 * succeeded or threw. The map entry is dropped once the chain goes idle, so it cannot grow.
 */
async function withSenderLock(senderId: string, work: () => Promise<void>): Promise<void> {
  const previous = senderLocks.get(senderId) ?? Promise.resolve();
  let release!: () => void;
  const mine = new Promise<void>((resolve) => { release = resolve; });
  const tail = previous.then(() => mine);
  senderLocks.set(senderId, tail);
  await previous.catch(() => undefined);
  try {
    await work();
  } finally {
    release();
    if (senderLocks.get(senderId) === tail) senderLocks.delete(senderId);
  }
}

/** The body of `handleSend`, run at most once at a time per message. */
async function handleSendOnce(ctx: WorkContext, messageId: string): Promise<void> {
  const rows = await ctx.db.execute(sql`
    SELECT m.id AS "messageId", m.org_id AS "orgId", m.body_enc AS "bodyEnc",
           ma.storage_key AS "mediaStorageKey", ma.content_type AS "mediaContentType", ma.gif_playback AS "mediaGifPlayback",
           ma.filename AS "mediaFilename",
           si.id AS "senderIdentityId", si.phone_e164 AS "senderPhone",
           v.contact_id AS "contactId", ct.do_not_contact AS "doNotContact",
           m.dnc_override AS "dncOverride",
           ci.value_normalized AS "recipientValue", ci.kind AS "recipientKind"
    FROM message m
    JOIN conversation v   ON v.id = m.conversation_id
    JOIN contact ct       ON ct.id = v.contact_id
    JOIN sender_identity si ON si.id = v.sender_identity_id
    LEFT JOIN media_asset ma ON ma.id = m.media_id AND ma.org_id = m.org_id
    JOIN contact_identity ci ON ci.contact_id = v.contact_id
                            AND ci.kind IN ('phone','wa_jid','wa_lid')
    WHERE m.id = ${messageId} AND m.direction = 'outbound' AND m.status = 'queued'
    ORDER BY CASE ci.kind WHEN 'phone' THEN 0 WHEN 'wa_jid' THEN 1 ELSE 2 END,
             ci.is_primary DESC
    LIMIT 1`);
  const job = (rows as unknown as QueuedSend[])[0];
  if (!job) return;                     // already sent, cancelled, or has no reachable identity

  if (job.bodyEnc === null) {
    await markMessageFailed(ctx.db, messageId, 'empty_body');
    return;
  }

  // Never send from a number to itself. A linked device's message to its own account cannot be decrypted on the phone:
  // it shows "Waiting for this message" and keeps asking for a resend (31 retry requests in one day, 2026-10-22).
  if (job.recipientKind === 'phone' && job.senderPhone !== null && job.recipientValue === job.senderPhone) {
    await markMessageFailed(ctx.db, messageId, 'own_number');
    return;
  }

  // The last line of the do-not-contact gate. It is checked when a message is created, but a contact
  // can be flagged after that.
  // Only an admin's explicit, audited per-message override lets it through.
  if (job.doNotContact && !job.dncOverride) {
    await markMessageFailed(ctx.db, messageId, 'do_not_contact');
    return;
  }

  // Why this message is still waiting, shown in the thread as "waiting: reason". Written each time
  // the gateway leaves it queued; cleared when it sends. Best-effort: never blocks the send path.
  const hold = async (reason: string): Promise<void> => {
    await ctx.db.execute(sql`
      UPDATE message SET hold_reason = ${reason}
      WHERE id = ${messageId} AND hold_reason IS DISTINCT FROM ${reason}`).catch(() => undefined);
  };

  try {
    const health = await ctx.provider.health(job.senderIdentityId);
    if (health.state !== 'open') {
      // Leave it queued rather than failing it: the boot sweep will pick it up once the
      // sender reconnects. A send is not wrong just because the socket is briefly down.
      ctx.logger.warn(
        { messageId, senderId: job.senderIdentityId, state: health.state },
        'sender not connected — leaving message queued'
      );
      await hold('sender_not_connected');
      return;
    }

    // ── the anti-ban policy ──────────────────────────────────────────────────────────
    // Everything that decides when this message may go is behind one interface (`antiBan`): it can let the message
    // go, ask for a pause first, or leave it queued with a reason. Do-not-contact above and the number being
    // connected are not its business and cannot be relaxed by it.
    const lastSent = (await ctx.db.execute(sql`
      SELECT max(m.sent_at) AS "lastSentAt"
      FROM message m JOIN conversation v ON v.id = m.conversation_id
      WHERE v.sender_identity_id = ${job.senderIdentityId} AND m.direction = 'outbound'`
    ) as unknown as Array<{ lastSentAt: string | null }>)[0]?.lastSentAt ?? null;
    const decision = await (ctx.antiBan ?? basicPolicy).beforeSend({
      senderIdentityId: job.senderIdentityId, now: new Date(),
      lastSentAt: lastSent === null ? null : new Date(lastSent)
    });
    if (decision.action === 'hold') {
      // Left queued, exactly like a disconnected sender: a message that is merely early is not a failed message.
      ctx.logger.warn({ messageId, senderId: job.senderIdentityId, reason: decision.reason }, 'send held by the anti-ban policy');
      await hold(decision.reason);
      return;
    }
    // Before the send rather than after, so a burst arriving at once is spread out instead of going at once and then waiting.
    if (decision.action === 'wait' && ctx.sleep) await ctx.sleep(decision.ms);

    const senderRef = { id: job.senderIdentityId, phoneE164: job.senderPhone ?? '' };
    // A contact with more than one number: make sure the one we send to has a WhatsApp account, and
    // move to the next that does if not (D-60). Runs after the anti-ban policy and its pause.
    let recipientValue = job.recipientValue;
    if (ctx.verifyFallbackNumbers) {
      const pick = await chooseRecipientNumber(ctx, job, senderRef);
      if (pick.kind === 'none') {
        // Sending to a number with no account would only cost the sender its delivery ratio.
        await markMessageFailed(ctx.db, messageId, 'no_whatsapp_number');
        ctx.logger.warn({ messageId, contactId: job.contactId }, 'none of this contact\'s numbers has a WhatsApp account');
        return;
      }
      if (pick.kind === 'switched') recipientValue = pick.phone;
    }
    const recipient = job.recipientKind === 'phone'
      ? { phoneE164: recipientValue }
      : { phoneE164: '', providerAddress: recipientValue };
    const body = ctx.decrypt(job.bodyEnc);

    // An attachment (D-25): read the file back from storage so the adapter can upload it. Done
    // before the typing pause is spent on a message that cannot go. A file that cannot be read
    // fails this one message with a clear code — the inbox shows it, nothing else is affected.
    let media: { bytes: Uint8Array; contentType: string; filename: string | null; gifPlayback?: boolean } | undefined;
    if (job.mediaStorageKey !== null) {
      if (!ctx.storage) throw new Error('media_storage_unavailable');
      media = {
        bytes: await ctx.storage.get(job.mediaStorageKey),
        contentType: job.mediaContentType ?? 'application/octet-stream',
        filename: job.mediaFilename,
        ...(job.mediaGifPlayback === true ? { gifPlayback: true } : {})
      };
    }

    // ── typing simulation ─────────────────────────────────────────────────────────────
    // Show the "typing…" bubble and pause a beat proportional to the message length before
    // sending, so the send looks human rather than instant (D-24). Opt-in,
    // and strictly cosmetic: presence is best-effort, so a failure to signal it is swallowed and
    // never fails the send it precedes.
    if (ctx.typingSimulation && ctx.provider.typing) {
      try {
        await ctx.provider.typing(senderRef, recipient, 'composing');
        if (ctx.sleep) await ctx.sleep(typingDelayMs(body.length));
        await ctx.provider.typing(senderRef, recipient, 'paused');
      } catch (presenceError) {
        ctx.logger.warn(
          { messageId, senderId: job.senderIdentityId, err: String(presenceError) },
          'typing presence failed — sending anyway'
        );
      }
    }

    const result = await ctx.provider.send(
      senderRef, recipient, { kind: 'freeform', body, ...(media ? { media } : {}) }
    );
    await markMessageSent(ctx.db, messageId, result.providerMessageId);
    ctx.logger.info({ messageId, providerMessageId: result.providerMessageId }, 'message sent');
  } catch (error) {
    const code = error instanceof Error ? error.message : String(error);
    await markMessageFailed(ctx.db, messageId, code);
    ctx.logger.error({ messageId, err: code }, 'send failed');
  }
}

/**
 * Turns campaign recipients into queued messages, a small batch at a time.
 *
 * A campaign does not queue its messages at launch: the `campaign_recipient` rows are the queue, and this
 * converts only as many as the anti-ban policy allows (`campaignBatch`). Everything downstream — the policy in
 * `handleSend` — then applies unchanged, so there is no second path to a provider and no way for a campaign to
 * bypass the gates (M12).
 *
 * It also keeps a campaign from burying an agent's reply: only a small batch of campaign messages is ever
 * sitting in the send queue at once.
 */
export async function dispatchCampaigns(ctx: WorkContext): Promise<number> {
  const counts = await inEachOrg(ctx, (c) => dispatchCampaignsInOrg(c));
  return counts.reduce((a, b) => a + b, 0);
}

/** One org's share of `dispatchCampaigns`, run with a context already pinned to that org. */
async function dispatchCampaignsInOrg(ctx: WorkContext): Promise<number> {
  if (!ctx.kms) return 0;

  const rows = await ctx.db.execute(sql`
    SELECT c.id, c.org_id AS "orgId", c.body, c.sender_identity_id AS "senderIdentityId",
           c.gate_overrides AS "gateOverrides"
    FROM campaign c
    WHERE c.status = 'running'
    ORDER BY c.started_at ASC
    LIMIT 20`);

  const policy = ctx.antiBan ?? basicPolicy;
  let queued = 0;
  for (const campaign of rows as unknown as Array<{
    id: string; orgId: string; body: string; senderIdentityId: string; gateOverrides: string[];
  }>) {
    const tenant = tenantRunner(ctx, campaign.orgId);

    // What is already waiting for this sender, from any source (a reply an agent typed counts): the policy says how
    // many more campaign messages may join it. Without this a sweep every few seconds would queue the whole audience.
    const waiting = (await ctx.db.execute(sql`
      SELECT count(*)::int AS n
      FROM message m JOIN conversation v ON v.id = m.conversation_id
      WHERE v.sender_identity_id = ${campaign.senderIdentityId} AND m.direction = 'outbound' AND m.status = 'queued'`
    ) as unknown as Array<{ n: number }>)[0]!.n;
    const room = policy.campaignBatch({ senderIdentityId: campaign.senderIdentityId, waiting });

    if (room > 0) {
      // A campaign with an AI template sends what the AI writes for each person: write the next few openings first (no-op otherwise).
      if (ctx.llm !== undefined && ctx.llm.name !== 'none') {
        try { await writeOpenings({ db: ctx.db, kms: ctx.kms, llm: ctx.llm }, { orgId: campaign.orgId, campaignId: campaign.id, limit: Math.min(room, 5) }); }
        catch (error) { ctx.logger.error({ campaignId: campaign.id, err: error instanceof Error ? error.message : String(error) }, 'could not write AI openings'); }
      }
      queued += await dispatchCampaign(tenant, ctx.kms, {
        orgId: campaign.orgId, campaignId: campaign.id,
        senderIdentityId: campaign.senderIdentityId, body: campaign.body, limit: room,
        identicalBodyCap: ctx.identicalBodyCap ?? Number.MAX_SAFE_INTEGER,
        gateOverrides: campaign.gateOverrides
      });
    }
    await tenant((tx) => reconcileCampaign(tx, campaign.orgId, campaign.id));
  }
  return queued;
}

/**
 * The background half of a key rotation (D-31): moves a small batch of values per org from retired
 * keys onto the current one, every sweep, until nothing is left on an old key.
 *
 * Does nothing at all unless a retired key is configured, so an install that never rotates pays
 * no cost. Honours the operator's pause. Small batches per org keep it from competing with sends.
 * Returns how many values were moved.
 */
export async function sweepKeyRotation(ctx: WorkContext, batch = 100): Promise<number> {
  const kms = ctx.kms;
  if (!kms || kms.knownKeyVersions().length <= 1) return 0;
  const state = (await ctx.db.execute(sql`
    SELECT paused FROM key_rotation_state WHERE id = 1`) as unknown as Array<{ paused: boolean }>)[0];
  if (state?.paused === true) return 0;

  const results = await inEachOrg(ctx, (c) => reencryptBatch(c.db, kms, batch));
  const moved = results.reduce((n, r) => n + r.reencrypted, 0);
  const unreadable = results.reduce((n, r) => n + r.unreadable, 0);
  if (moved > 0 || unreadable > 0) {
    await ctx.db.execute(sql`
      UPDATE key_rotation_state
      SET last_run_at = now(), reencrypted_total = reencrypted_total + ${moved},
          last_unreadable = ${unreadable}, updated_at = now()
      WHERE id = 1`);
    ctx.logger.info({ moved, unreadable }, 'key rotation: re-encrypted a batch onto the current key');
  }
  return moved;
}

/** A tenant-scoped runner for the gateway, which has no request to take one from. */
function tenantRunner(ctx: WorkContext, orgId: string) {
  return <T>(work: (tx: Transaction) => Promise<T>): Promise<T> =>
    ctx.db.transaction(async (tx) => {
      await setTenant(tx, orgId);
      return work(tx);
    });
}

/**
 * Picks up work left behind while this process was down.
 *
 * The reason the command channel is a durable table and not only a NOTIFY: a notification sent
 * while the gateway was stopped is gone forever, but a queued row is still there.
 */
export async function sweepPendingWork(ctx: WorkContext): Promise<{ links: number; sends: number }> {
  const linkRows = await ctx.db.execute(sql`
    SELECT id FROM channel_session
    WHERE link_requested_at IS NOT NULL AND link_challenge IS NULL
      AND link_requested_at > now() - interval '10 minutes'`);
  const links = (linkRows as unknown as Array<{ id: string }>).map((r) => r.id);
  for (const id of links) await handleLinkRequest(ctx, id);

  // Unlink requests left behind: no time bound — a pending reset must not be lost just because
  // the gateway was down when it was asked for.
  const unlinkRows = await ctx.db.execute(sql`
    SELECT id FROM channel_session WHERE unlink_requested_at IS NOT NULL`);
  for (const r of unlinkRows as unknown as Array<{ id: string }>) await handleUnlinkRequest(ctx, r.id);

  const sendRows = await ctx.db.execute(sql`
    SELECT id FROM message
    WHERE direction = 'outbound' AND status = 'queued'
    ORDER BY created_at ASC LIMIT ${ctx.sweepBatchSize ?? 200}`);
  const sends = (sendRows as unknown as Array<{ id: string }>).map((r) => r.id);
  for (const id of sends) await handleSend(ctx, id);

  // A key rotation in progress (D-31): a small batch per sweep, never in the way of a send.
  await sweepKeyRotation(ctx);

  // After sending, not before: a campaign tops the queue up with whatever room the policy gives
  // once this sweep's sends have gone.
  await dispatchCampaigns(ctx);

  return { links: links.length, sends: sends.length };
}

/**
 * Reconnects every number that was linked before this process restarted.
 *
 * Credentials live in Postgres precisely so this is possible without anyone scanning a QR
 * again — the previous system needed every session reconnected by hand after each restart
 * (M29/M30).
 *
 * `providers` names which `sender_identity.provider` values this gateway's transport owns: the
 * default is the real thing, and the fake-channel gateway passes `['fake']` so a seeded test number
 * comes up connected while a UI-created one stays unlinked.
 */
export async function restoreSessions(
  ctx: WorkContext, providers: readonly string[] = ['baileys']
): Promise<number> {
  // One query per org, each pinned to it, so a number is only ever listed from inside its own org.
  const perOrg = await inEachOrg(ctx, async (c) => (await c.db.execute(sql`
    SELECT si.id, si.phone_e164 AS phone FROM sender_identity si
    WHERE si.provider IN (${sql.join(providers.map((p) => sql`${p}`), sql`, `)})
      AND si.status = 'active'`)) as unknown as Array<{ id: string; phone: string | null }>);
  const senders = perOrg.flat();

  let restored = 0;
  for (const s of senders) {
    try {
      await ctx.provider.connect({ id: s.id, phoneE164: s.phone ?? '' });
      restored += 1;
      ctx.logger.info({ senderId: s.id }, 'session restored from stored credentials');
    } catch (error) {
      // One number failing to reconnect must not stop the others.
      ctx.logger.warn(
        { senderId: s.id, err: error instanceof Error ? error.message : String(error) },
        'could not restore session'
      );
    }
  }
  return restored;
}

/**
 * Pauses a number's running campaigns and says why. A person resumes them after checking the phone;
 * nothing resumes on its own, so a relink cannot silently carry on a campaign into a banned number.
 */
async function pauseCampaignsFor(ctx: WorkContext, senderId: string, reason: 'ban_suspected' | 'unlinked'): Promise<number> {
  const rows = await ctx.db.execute(sql`
    UPDATE campaign SET status = 'paused', pause_reason = ${reason}, updated_at = now()
    WHERE sender_identity_id = ${senderId} AND status = 'running'
    RETURNING id`);
  return (rows as unknown as unknown[]).length;
}

/**
 * A close with code 403: WhatsApp refused this number. Records one critical timeline event (not one per
 * reconnect attempt: nothing within 30 minutes of the last) that tells the operator to look at the
 * phone first, and pauses the number's running campaigns.
 */
async function suspectBan(
  ctx: WorkContext, senderId: string, kind: 'forbidden', at: Date, evidence: Record<string, unknown>
): Promise<void> {
  const org = (await ctx.db.execute(sql`
    SELECT org_id AS "orgId" FROM sender_identity WHERE id = ${senderId}`
  ) as unknown as Array<{ orgId: string }>)[0];
  if (!org) return;
  const recent = (await ctx.db.execute(sql`
    SELECT 1 FROM sender_health_event
    WHERE sender_identity_id = ${senderId} AND kind = ${`${kind}_suspected`}
      AND at > now() - interval '30 minutes' LIMIT 1`) as unknown as unknown[]).length > 0;
  if (recent) return;
  const paused = await pauseCampaignsFor(ctx, senderId, 'ban_suspected');
  await recordHealthEvent(ctx.db, {
    orgId: org.orgId, senderIdentityId: senderId, kind: `${kind}_suspected`, severity: 'critical', at,
    summary: 'WhatsApp refused this number\'s connection (403), which is the code it uses for bans and '
      + 'blocks. Open WhatsApp on the phone now and look for an "account banned" or "temporarily banned" '
      + `notice before doing anything else. ${paused > 0 ? `${String(paused)} running campaign(s) were paused.` : 'No campaign was running.'}`,
    evidence
  });
  ctx.logger.error({ senderId, paused }, 'WhatsApp refused the number (403) — possible ban, campaigns paused');
}

/**
 * Records a connection state change, and promotes or demotes the sender to match.
 *
 * This is the only writer of `channel_session.connection_state`, which is what the UI reads to
 * answer "is this number actually linked?". `sender_identity.status` cannot answer that: it is
 * a business state that says nothing about whether a socket is open.
 */
export async function applyConnectionEvent(
  ctx: WorkContext, event: NormalisedConnectionEvent
): Promise<void> {
  const orgId = await orgOfSender(ctx, event.senderId);
  if (orgId === null) return;
  await applyConnectionEventInOrg(scopedTo(ctx, orgId), event);
}

/** `applyConnectionEvent` once the sender's org is known and the context is pinned to it. */
async function applyConnectionEventInOrg(
  ctx: WorkContext, event: NormalisedConnectionEvent
): Promise<void> {
  const openedAt = event.state === 'open' ? event.at.toISOString() : null;
  // Did a person ask for this unlink? Read before the update below, because an unlink in flight is
  // what tells a deliberate logout from WhatsApp logging the number out on its own.
  const unlinkRow = event.state === 'logged_out'
    ? (await ctx.db.execute(sql`
        SELECT unlink_requested_at AS "at", connection_state AS "previous"
        FROM channel_session
        WHERE sender_identity_id = ${event.senderId}`) as unknown as Array<{ at: string | null; previous: string | null }>)[0]
    : undefined;
  const deliberateUnlink = unlinkRow?.at !== null && unlinkRow?.at !== undefined;
  const alreadyLoggedOut = unlinkRow?.previous === 'logged_out';

  await ctx.db.execute(sql`
    INSERT INTO channel_session (sender_identity_id, connection_state, disconnect_reason, last_connected_at)
    VALUES (${event.senderId}, ${event.state}, ${event.reason}, ${openedAt})
    ON CONFLICT (sender_identity_id) DO UPDATE
      SET connection_state = ${event.state},
          disconnect_reason = ${event.reason},
          last_connected_at = COALESCE(${openedAt}, channel_session.last_connected_at),
          updated_at = now()`);

  // A completed link has no further use for the challenge, and leaving it behind would let the UI keep offering a QR for a number that is
  // already connected. Same for the request itself: left set, the sweep kept asking for a link on a number that was already connected,
  // and each attempt disturbed the live session. Its own statement, run only on open: `channel_session_link_requested` fires on any SET of
  // `link_requested_at`, even to the same value, so writing it on every event re-sent a pending link to the gateway (R-014).
  if (event.state === 'open') {
    await ctx.db.execute(sql`
      UPDATE channel_session
      SET link_challenge = NULL, link_requested_at = NULL, link_requested_mode = NULL, link_requested_phone = NULL,
          link_error = NULL, qr_expires_at = NULL
      WHERE sender_identity_id = ${event.senderId}`);
  }

  // 403 is the code WhatsApp uses when it refuses a number outright (a ban or a block). It arrives as a
  // plain close, not a logout, so it needs its own branch: say so loudly and stop the campaigns.
  if (event.code === 403) {
    await suspectBan(ctx, event.senderId, 'forbidden', event.at, { code: 403, reason: event.reason });
  }

  if (event.state === 'open') {
    // Promote on first successful connection. Until this existed only the wa:link script set
    // 'active', so a number linked through the API stayed 'linking' forever and POST /messages
    // kept answering NO_ACTIVE_SENDER.
    await ctx.db.execute(sql`
      UPDATE sender_identity
      SET status = 'active', updated_at = now()
      WHERE id = ${event.senderId} AND status = 'linking'`);

    // Record the number this connection belongs to, so a linked number is not left reading "no number
    // yet". Only fills a blank (a number someone typed in stays as typed), and only when no other number
    // of this org already has that phone, which the unique index would otherwise reject.
    if (event.phoneE164 !== undefined && event.phoneE164 !== null) {
      await ctx.db.execute(sql`
        UPDATE sender_identity si
        SET phone_e164 = ${event.phoneE164}, updated_at = now()
        WHERE si.id = ${event.senderId} AND si.phone_e164 IS NULL
          AND NOT EXISTS (
            SELECT 1 FROM sender_identity o
            WHERE o.org_id = si.org_id AND o.provider = si.provider AND o.phone_e164 = ${event.phoneE164})`);
    }
  }

  if (event.state === 'logged_out') {
    // Terminal: the number was unlinked from the phone. Say so rather than leaving it looking
    // active, which would keep the dispatcher queueing sends that can never leave. Deliberately
    // *not* auto-retired: a genuine 401 ban and a user-initiated unlink look identical at the
    // socket, and retiring a number the operator just unlinked would be wrong.
    await ctx.db.execute(sql`
      UPDATE sender_identity SET status = 'linking', updated_at = now()
      WHERE id = ${event.senderId}`);

    // Nobody asked for this logout, so WhatsApp ended the session: that is what a ban looks like from
    // the socket (and also what unlinking from the phone looks like). Say so on the timeline instead
    // of letting the number quietly turn up as "not connected".
    // WhatsApp ended this session, so the stored credentials are dead. Clear them now, so the next
    // Link starts clean instead of retrying a login that can only fail.
    if (!deliberateUnlink && !alreadyLoggedOut) {
      await ctx.provider.logout(event.senderId).catch(() => undefined);
    }

    // Say it once per logout. A failed re-login on the same dead session reports `logged_out` again,
    // and recording each one buried the real signal under a pile of identical "possible ban" alarms.
    // `device_removed` is WhatsApp saying the device was taken off the phone's Linked devices list: an unlink, not a ban (a ban
    // comes as a 403). It gets its own calm event, so the page does not shout "possible ban" at someone who just unlinked it.
    if (event.detail === 'device_removed' && !deliberateUnlink && !alreadyLoggedOut) {
      const org = (await ctx.db.execute(sql`
        SELECT org_id AS "orgId" FROM sender_identity WHERE id = ${event.senderId}`
      ) as unknown as Array<{ orgId: string }>)[0];
      if (org) {
        await recordHealthEvent(ctx.db, {
          orgId: org.orgId, senderIdentityId: event.senderId, kind: 'unlinked_on_phone',
          severity: 'warning', at: event.at,
          summary: 'This device was removed under Linked devices on the phone (WhatsApp: device_removed). That is an '
            + 'unlink, not a ban; a ban comes as a 403. Link it again once, from this page.',
          evidence: { code: event.code ?? null, reason: event.reason, detail: event.detail }
        });
        ctx.logger.info({ senderId: event.senderId }, 'number removed from Linked devices on the phone');
        await pauseCampaignsFor(ctx, event.senderId, 'unlinked');
      }
    }

    const recent = (await ctx.db.execute(sql`
      SELECT 1 FROM sender_health_event
      WHERE sender_identity_id = ${event.senderId} AND kind = 'hard_ban_suspected'
        AND at > now() - interval '30 minutes' LIMIT 1`) as unknown as unknown[]).length > 0;
    if (event.detail !== 'device_removed' && !deliberateUnlink && !alreadyLoggedOut && !recent) {
      const org = (await ctx.db.execute(sql`
        SELECT org_id AS "orgId" FROM sender_identity WHERE id = ${event.senderId}`
      ) as unknown as Array<{ orgId: string }>)[0];
      if (org) {
        await recordHealthEvent(ctx.db, {
          orgId: org.orgId, senderIdentityId: event.senderId, kind: 'hard_ban_suspected',
          severity: 'critical', at: event.at,
          summary: 'WhatsApp logged this number out without being asked. That is either a ban or someone '
            + 'unlinking it on the phone. Check the phone, and do not relink in a hurry.',
          evidence: { code: event.code ?? null, reason: event.reason }
        });
        ctx.logger.error({ senderId: event.senderId }, 'number logged out by WhatsApp — possible ban');
        await pauseCampaignsFor(ctx, event.senderId, 'ban_suspected');
      }
    }
  }

  ctx.logger.info(
    { senderId: event.senderId, state: event.state, reason: event.reason },
    'connection state changed'
  );
}

/**
 * Marks every session closed. Run at boot and at shutdown.
 *
 * `connection_state` describes a socket held by *this* process, so it is meaningless the
 * moment the process is not running — yet it would sit at `'open'` forever, and the UI would
 * cheerfully report a number as connected with no gateway alive. Running it at boot also
 * covers the case a graceful shutdown cannot: a crash or a `kill -9`, where nothing gets the
 * chance to tidy up. Anything genuinely reachable is set back to `'open'` seconds later as
 * `restoreSessions()` reconnects it.
 */
export async function markAllSessionsClosed(ctx: WorkContext): Promise<number> {
  const counts = await inEachOrg(ctx, async (c) => {
    const rows = await c.db.execute(sql`
      UPDATE channel_session
      SET connection_state = 'closed', updated_at = now()
      WHERE connection_state <> 'closed'
      RETURNING sender_identity_id`);
    return (rows as unknown as unknown[]).length;
  });
  return counts.reduce((a, b) => a + b, 0);
}
