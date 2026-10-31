# 08 · Anti-ban

> **Removed on 2026-10-30. The new anti-ban is pending.**

Running Baileys against a normal WhatsApp number **violates WhatsApp's Terms of Service**. The number can be banned at any
time, for reasons outside this system's control, with no appeal. Nothing here removes that risk. Never point this at a
number you cannot afford to lose.

## What was removed

The old engine (warmup ramp, per-minute/hour/day caps, circadian pacing, contact-graph gates, risk score and health bands,
timed recovery, silent-restriction detection, advisory mode, fake background activity, delayed read receipts, recipient
time zones) is gone: code, tests, screens, API fields and database columns. Its numbers were copied from one public library
with no data behind them, and the only primary source is WhatsApp's own 2019 white paper on abuse and unwanted messages.
The history stays in `CHANGELOG.md`, `HANDOFF.md` and `21-deferred.md`.

## What is in place now

Everything that decides *how fast* or *how many* is behind one interface, `AntiBanPolicy` in `packages/core/src/antiban.ts`.
The gateway asks it two questions and nothing else:

| Question | Where | Answer |
|---|---|---|
| May this message go now? `beforeSend` | `handleSend` in `apps/gateway/src/work.ts`, for **every** outbound message: a reply, an AI reply, an API message, a campaign message | `send`, `wait` (sleep, then send), or `hold` (leave it queued, show the reason in the thread) |
| How many more campaign messages may be queued for this number? `campaignBatch` | `dispatchCampaigns` in the same file | a number |

The one implementation is `basicPolicy`, a placeholder until the new driver replaces it:

- a random gap of **3 to 8 seconds** between sends from the same number, measured from that number's last `sent_at`;
- at most **20** campaign messages waiting per number at a time.

There are **no daily caps**, by design (a user decision). It does not look at delivery, replies or the time of day.

## What stays, because it protects people and not the number

These are not behind the policy and nothing in it can relax them:

- **Do-not-contact**, checked when a message is created and again as the last line before it is sent. Only an admin can lift it, per message or per campaign, with a reason, audited.
- **The recipient policy gates** (`packages/core/src/policy-gates.ts`): an agent mid-conversation, the 14-day cooldown after another campaign, a duplicate in a live campaign. An admin can lift them for one campaign, with a reason.
- **Not sending to the sending number itself, an empty body, a contact whose numbers have no WhatsApp account** (the number fallback, D-60).
- **The typing beat** (`SEND_TYPING_SIMULATION`): a "typing…" presence before each send.
- **Connection handling**: a 403 raises a ban warning on the Numbers page and pauses the number's running campaigns; an unrequested logout (401) does the same; a device removed under Linked devices is an unlink, not a ban (R-017). These are written to `sender_health_event`.

## Plugging a new anti-ban in

Write an `AntiBanPolicy`, pass it as `antiBan` in the gateway's `WorkContext` (`apps/gateway/src/main.ts`), and delete
`basicPolicy`. `SendContext` carries the number, the time and when it last sent; add what the new driver needs there. A
test that names the old engine's identifiers fails on purpose (`tests/integration/antiban-purged.test.ts`).
