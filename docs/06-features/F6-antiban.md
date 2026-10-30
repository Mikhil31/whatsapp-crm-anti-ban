# F6 · Anti-ban

**Status:** the old engine was removed on 2026-10-30; the new one is pending. What exists now is a placeholder behind one
interface, described in **[`../08-antiban.md`](../08-antiban.md)**.

## What is built

- `AntiBanPolicy` (`packages/core/src/antiban.ts`): `beforeSend` (send, wait or hold) and `campaignBatch`.
- `basicPolicy`: a random 3 to 8 second gap between sends from one number, and at most 20 campaign messages waiting per number.
- Every outbound message passes through it (`handleSend`), and the campaign dispatcher asks it for its batch (`dispatchCampaigns`).

## Acceptance

- **AC-1** Every outbound message, whoever queued it (an agent, the AI assistant, the API, a campaign), is spaced from the previous send of the same number.
- **AC-2** A campaign never has more than the policy's batch waiting for one number.
- **AC-3** The policy cannot relax do-not-contact, the recipient policy gates or a number that is not connected.
- **AC-4** A different policy can be passed to the gateway without changing the send path.

## Tests

`packages/core/src/antiban.test.ts` (the policy), `tests/integration/antiban-policy.test.ts` (the send path, a 50-recipient
campaign, the migration that removed the old engine) and `tests/integration/antiban-purged.test.ts` (the old names stay out of
the code).
