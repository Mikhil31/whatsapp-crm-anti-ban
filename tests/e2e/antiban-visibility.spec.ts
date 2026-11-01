import { test, expect, type Page } from '@playwright/test';
import { signIn, CREDS_MISSING } from './helpers';

const API = process.env.E2E_API_URL ?? 'http://localhost:3000/api/v1';

/**
 * F6 S10, in the browser: what the owner sees of the anti-ban engine. AC-10.1 the timeline of a message and its reason with an action,
 * AC-10.2 the recipient table, AC-10.3 the ETA, AC-10.4 the number card, AC-10.5 the countdown and the refresh without a reload; and the
 * settings and the new-campaign fields that go with them (S6, S7).
 *
 * Everything it needs goes in through the API with names made for this run: a number that is never linked, a few contacts (one of them
 * on do-not-contact), and a campaign. Nothing can really be sent, because the number has no socket: the gateway holds every message for
 * it with the reason `sender_not_connected`, and that held state is what these tests read. What cannot be made without a linked number
 * (a countdown to the next send, a timelock, a failed send) is covered by the unit tests of the sentences (`apps/web/lib`) and the API
 * integration tests (`tests/integration/antiban-v2-visibility.test.ts`).
 */
const STAMP = Date.now();
const SENDER = `E2E visibility ${String(STAMP)}`;
const HELD_NAME = 'E2E Vis Held';
const OPTOUT_NAME = 'E2E Vis Optout';
const LATER_NAME = 'E2E Vis Later';
// A corner of the fiction range no other spec uses (0400 to 0499), rotating so a re-run meets a contact without history.
const phone = (i: number): string => `+1202555${String(400 + ((STAMP + i * 7) % 100)).padStart(4, '0')}`;

interface Seed { senderId: string; campaignId: string; heldContactId: string; optoutContactId: string; conversationId: string; messageId: string }
let seed: Seed | null = null;

/** The CSRF-carrying headers of the signed-in page. */
async function headersOf(page: Page): Promise<Record<string, string>> {
  const csrf = (await page.context().cookies()).find((c) => c.name === 'crm_csrf')?.value ?? '';
  return { 'x-csrf-token': csrf, 'content-type': 'application/json' };
}

/** Makes a contact (or finds the one with that number) and returns its id. */
async function contact(page: Page, name: string, number: string): Promise<string> {
  const made = await page.request.post(`${API}/contacts`, { headers: await headersOf(page), data: { displayName: name, phone: number } });
  return made.status() === 201
    ? ((await made.json()) as { data: { id: string } }).data.id
    : ((await made.json()) as { existingContactId: string }).existingContactId;
}

/** Starts a campaign to these contacts from this number, lifting the gates a re-run on a small pool of numbers would trip. */
async function launch(page: Page, name: string, senderId: string, contactIds: string[]): Promise<string> {
  const headers = await headersOf(page);
  const created = await page.request.post(`${API}/campaigns`, {
    headers, data: { name, body: 'Hi {{name}}, an e2e visibility test.', senderIdentityId: senderId, explicitContactIds: contactIds }
  });
  expect(created.status()).toBe(201);
  const id = ((await created.json()) as { data: { id: string } }).data.id;
  const started = await page.request.post(`${API}/campaigns/${id}/start`, {
    headers, data: { overrideGates: ['engagement', 'cooldown', 'duplicate_campaign'], reason: 'e2e re-run reuses a small pool of fiction numbers' }
  });
  expect(started.status()).toBeLessThan(300);
  return id;
}

/** Seeds once per run: signed in, a number, a held recipient, a do-not-contact recipient. Waits for the gateway to record the hold. */
async function ensureSeed(page: Page): Promise<Seed> {
  if (seed !== null) return seed;
  const headers = await headersOf(page);
  const sender = await page.request.post(`${API}/senders`, { headers, data: { label: SENDER, provider: 'baileys' } });
  expect(sender.status()).toBe(201);
  const senderId = ((await sender.json()) as { data: { id: string } }).data.id;

  const heldContactId = await contact(page, HELD_NAME, phone(1));
  const optoutContactId = await contact(page, OPTOUT_NAME, phone(2));
  const flagged = await page.request.put(`${API}/contacts/${optoutContactId}/do-not-contact`, { headers, data: { value: true, reason: 'opt_out' } });
  expect(flagged.status()).toBe(204);

  const campaignId = await launch(page, `E2E visibility ${String(STAMP)}`, senderId, [heldContactId, optoutContactId]);

  // The gateway queues the held contact's message and records why it cannot go: the number is not connected.
  type Row = { id: string; status: string; reason: string | null; messageId: string | null; conversationId: string | null };
  let held: Row | undefined;
  await expect.poll(async () => {
    const rows = ((await (await page.request.get(`${API}/campaigns/${campaignId}/recipients`, { headers })).json()) as { data: Row[] }).data;
    held = rows.find((r) => r.status !== 'skipped');
    return held?.reason ?? 'none';
  }, { timeout: 90_000, intervals: [2_000] }).toBe('sender_not_connected');

  seed = { senderId, campaignId, heldContactId, optoutContactId, conversationId: held!.conversationId!, messageId: held!.messageId! };
  return seed;
}

test.describe('anti-ban visibility (F6 S10)', () => {
  test.skip(CREDS_MISSING, 'set TEST_EMAIL / TEST_PASSWORD in .env');
  test.describe.configure({ mode: 'serial' });
  test.setTimeout(150_000);

  test('AC-10.1 a held message shows its timeline, the reason in a sentence, and an action that goes somewhere real', async ({ page }) => {
    await signIn(page);
    const s = await ensureSeed(page);

    await page.goto(`/inbox/${s.conversationId}`);
    const timeline = page.getByTestId('message-timeline').first();
    await expect(timeline).toBeVisible();
    await expect(timeline).toHaveAttribute('data-outcome', 'held');
    // The road a message takes is there, and it is still at the first stop.
    await expect(timeline.getByTestId('step-queued')).toHaveAttribute('data-state', 'current');
    for (const step of ['waiting', 'typing', 'sent', 'delivered', 'read']) {
      await expect(timeline.getByTestId(`step-${step}`)).toHaveAttribute('data-state', 'todo');
    }
    // The reason in words, not a code, and the action for it.
    await expect(timeline.getByTestId('reason-sentence')).toHaveText('The number is not connected right now.');
    await expect(timeline.getByTestId('reason-sentence')).toHaveAttribute('data-code', 'sender_not_connected');
    const relink = timeline.getByRole('link', { name: 'Link the number again' });
    await expect(relink).toHaveAttribute('href', new RegExp(`^/link\\?start=${s.senderId}$`));
  });

  test('AC-10.1 Retry only ever runs on a click, and refuses a message that did not fail', async ({ page }) => {
    await signIn(page);
    const s = await ensureSeed(page);
    const headers = await headersOf(page);
    // Held, not failed: nothing to retry.
    const refused = await page.request.post(`${API}/messages/${s.messageId}/retry`, { headers });
    expect(refused.status()).toBe(409);
    expect(((await refused.json()) as { code: string }).code).toBe('NOT_RETRYABLE');
    // And a held message is still held: the engine did not send or requeue it behind our back.
    await page.goto(`/inbox/${s.conversationId}`);
    await expect(page.getByTestId('message-timeline').first()).toHaveAttribute('data-outcome', 'held');
  });

  test('AC-10.2 the campaign page lists every recipient in a table, with where they are, why and what to do, instead of count boxes', async ({ page }) => {
    await signIn(page);
    const s = await ensureSeed(page);
    await page.goto(`/broadcast/${s.campaignId}`);

    // The counts are a compact header: one line of links, not a grid of boxes.
    await expect(page.getByRole('list', { name: 'Counts' })).toBeVisible();
    const table = page.getByTestId('recipient-table');
    await expect(table).toBeVisible();
    await expect(table.getByRole('columnheader')).toHaveText(['Contact', 'Where they are', 'Why', 'What you can do']);
    const rows = table.getByTestId('recipient-row');
    await expect(rows).toHaveCount(2);

    const held = rows.filter({ hasText: HELD_NAME });
    await expect(held.getByTestId('reason-sentence')).toHaveText('The number is not connected right now.');
    await expect(held.getByRole('link', { name: 'Link the number again' })).toBeVisible();
    // A held person is Waiting, and says why in words.
    await expect(held).toContainText('Waiting');
    await expect(held).toContainText('Number not connected');

    const optout = rows.filter({ hasText: OPTOUT_NAME });
    await expect(optout).toHaveAttribute('data-status', 'skipped');
    await expect(optout.getByTestId('reason-sentence')).toHaveText('This contact asked not to be messaged.');
    await expect(optout.getByRole('button', { name: 'Allow messages again' })).toBeVisible();
  });

  test('AC-10.2 the table filters by state and by reason', async ({ page }) => {
    await signIn(page);
    const s = await ensureSeed(page);
    await page.goto(`/broadcast/${s.campaignId}`);
    const rows = page.getByTestId('recipient-row');

    // By state: the Show menu, in plain words.
    await page.getByLabel('Show').selectOption('not_yet');
    await page.getByRole('button', { name: 'Apply' }).click();
    await expect(page).toHaveURL(/show=not_yet/);
    await expect(rows).toHaveCount(1);
    await expect(rows.first()).toContainText(OPTOUT_NAME);

    // By reason: the filter lists the reasons this campaign has, with counts.
    await page.goto(`/broadcast/${s.campaignId}`);
    const show = page.getByLabel('Show');
    await expect(show.locator('option', { hasText: 'Asked not to be messaged' })).toHaveCount(1);
    await show.selectOption('reason:sender_not_connected');
    await page.getByRole('button', { name: 'Apply' }).click();
    await expect(page).toHaveURL(/show=reason%3Asender_not_connected/);
    // Reasons are words with counts, never codes.
    await expect(page.getByTestId('filter-bar')).not.toContainText(/[a-z]+_[a-z]+/);
    await expect(rows).toHaveCount(1);
    await expect(rows.first()).toContainText(HELD_NAME);

    // A reason nobody has shows an empty table, not an error.
    await page.goto(`/broadcast/${s.campaignId}?reason=timelock`);
    await expect(rows).toHaveCount(0);
    await expect(page.getByText('No recipients match this filter.')).toBeVisible();
  });

  test('AC-10.1 Lift on a do-not-contact recipient asks first, then really lifts it', async ({ page }) => {
    await signIn(page);
    const s = await ensureSeed(page);
    const headers = await headersOf(page);
    await page.goto(`/broadcast/${s.campaignId}`);
    const row = page.getByTestId('recipient-row').filter({ hasText: OPTOUT_NAME });

    await row.getByRole('button', { name: 'Allow messages again' }).click();
    await expect(row.getByText('Allow messages to this contact again?')).toBeVisible();
    // Asked, not done: the contact is still flagged.
    const flagged = async (): Promise<boolean> => {
      const list = ((await (await page.request.get(`${API}/contacts?q=${encodeURIComponent(phone(2))}`, { headers })).json()) as
        { data: Array<{ id: string; doNotContact: boolean }> }).data;
      return list.find((c) => c.id === s.optoutContactId)?.doNotContact === true;
    };
    expect(await flagged()).toBe(true);

    await row.getByRole('button', { name: 'Yes, lift' }).click();
    await expect.poll(flagged, { timeout: 15_000 }).toBe(false);
  });

  test('AC-10.3 a running campaign shows when it finishes', async ({ page }) => {
    await signIn(page);
    const s = await ensureSeed(page);
    await page.goto(`/broadcast/${s.campaignId}`);
    const eta = page.getByTestId('campaign-eta');
    await expect(eta).toBeVisible();
    // "Done by about 17:42", or the split around WhatsApp's reset ("370 go now, finishing 15:10; 130 after WhatsApp's reset at 09:00
    // tomorrow"), or "Nothing left to send." once everything has gone. Never a bare code or an empty line.
    await expect(eta.getByTestId('eta-headline')).toHaveText(
      /^(Done by about \d{2}:\d{2}( tomorrow| on \d+ \w+)?|\d+ go now(, finishing [^;]+)?; \d+ after WhatsApp's reset at \d{2}:\d{2}.*|None go now; .*|Nothing left to send\.)\.?$/
    );
  });

  test('AC-10.4 the number card shows the lane, the warning level, when it was linked and what it is holding', async ({ page }) => {
    await signIn(page);
    const s = await ensureSeed(page);
    await page.goto('/link');
    const card = page.locator('li.card', { hasText: SENDER });
    const lane = card.getByTestId('number-lane');
    await expect(lane).toBeVisible();
    await expect(lane.getByTestId('lane-sending')).toHaveText(/^\d+ waiting$/);
    await expect(lane.getByTestId('lane-holding')).toContainText('Holding: The number is not connected right now.');
    await expect(lane.getByTestId('lane-warning')).toContainText('No report from WhatsApp yet');
    await expect(lane.getByTestId('lane-linked-since')).toHaveText('not linked');
    // The hold's action is the same "Link the number again" as on the message.
    await expect(lane.getByRole('link', { name: 'Link the number again' })).toHaveAttribute('href', new RegExp(`/link\\?start=${s.senderId}`));
  });

  test('AC-10.5 the number card counts on its own and picks up new work without a reload', async ({ page }) => {
    await signIn(page);
    const s = await ensureSeed(page);
    await page.goto('/link');
    const card = page.locator('li.card', { hasText: SENDER });
    const sending = card.getByTestId('lane-sending');
    await expect(sending).toHaveText(/^\d+ waiting$/);
    const before = Number(/\d+/.exec((await sending.textContent()) ?? '')![0]);

    // This document must survive: a reload would clear the marker.
    await page.evaluate(() => { (globalThis as unknown as { __noReload: boolean }).__noReload = true; });

    // The "updated n s ago" line moves by itself between refreshes.
    const updated = card.getByTestId('lane-updated');
    const first = await updated.textContent();
    await expect.poll(async () => updated.textContent(), { timeout: 8_000, intervals: [500] }).not.toBe(first);

    // New work arrives from elsewhere: a second campaign to someone new. The card learns of it by itself.
    const laterId = await contact(page, LATER_NAME, phone(3));
    await launch(page, `E2E visibility later ${String(STAMP)}`, s.senderId, [laterId]);
    await expect.poll(async () => Number(/\d+/.exec((await sending.textContent()) ?? '')?.[0] ?? '0'), { timeout: 60_000, intervals: [2_000] })
      .toBeGreaterThan(before);
    expect(await page.evaluate(() => (globalThis as unknown as { __noReload?: boolean }).__noReload)).toBe(true);
  });

  test('AC-10.5 a thread keeps itself up to date: the timeline is on the page without a reload', async ({ page }) => {
    await signIn(page);
    const s = await ensureSeed(page);
    await page.goto(`/inbox/${s.conversationId}`);
    await page.evaluate(() => { (globalThis as unknown as { __noReload: boolean }).__noReload = true; });
    await expect(page.getByTestId('message-timeline').first()).toBeVisible();
    // The inbox re-reads itself every few seconds; after one such beat the page is still the same document and still shows the timeline.
    await page.waitForTimeout(6_500);
    expect(await page.evaluate(() => (globalThis as unknown as { __noReload?: boolean }).__noReload)).toBe(true);
    await expect(page.getByTestId('message-timeline').first()).toHaveAttribute('data-outcome', 'held');
  });

  test('S6 the sending rules: the closing message, its contact details and a warning when they are missing', async ({ page }) => {
    await signIn(page);
    const headers = await headersOf(page);
    const original = ((await (await page.request.get(`${API}/antiban/settings`, { headers })).json()) as {
      data: { closingMessageEnabled: boolean; contactPhone: string | null; contactEmail: string | null; defaultPurpose: string | null }
    }).data;
    try {
      await page.goto('/sending');
      await expect(page.getByRole('heading', { name: 'Sending rules' })).toBeVisible();

      // Start from "on, with nothing filled in".
      const closing = page.locator('input[name="closingMessageEnabled"]');
      if (!(await closing.isChecked())) await closing.check();
      await page.locator('input[name="contactPhone"]').fill('');
      await page.locator('input[name="contactEmail"]').fill('');
      await page.getByRole('button', { name: 'Save', exact: true }).click();
      await expect(page.getByTestId('saved')).toBeVisible();
      await expect(page.getByTestId('missing-warning')).toContainText('contact number and contact email');

      // Fill them in: the warning goes.
      await page.locator('input[name="contactPhone"]').fill('+91 98765 43210');
      await page.locator('input[name="contactEmail"]').fill('hr@example.test');
      await page.locator('textarea[name="defaultPurpose"]').fill('you applied for a job with us');
      await page.getByRole('button', { name: 'Save', exact: true }).click();
      await expect(page.getByTestId('saved')).toBeVisible();
      await expect(page.getByTestId('missing-warning')).toHaveCount(0);

      // It was stored, not just shown.
      await page.reload();
      await expect(page.locator('input[name="contactPhone"]')).toHaveValue('+91 98765 43210');
      await expect(page.locator('input[name="contactEmail"]')).toHaveValue('hr@example.test');

      // Quiet hours are part of it too.
      await expect(page.locator('input[name="quietStart"]')).toHaveValue(/^\d{2}:\d{2}$/);
      await expect(page.locator('input[name="quietEnd"]')).toHaveValue(/^\d{2}:\d{2}$/);

      // A bad email is refused in words.
      await page.locator('input[name="contactEmail"]').evaluate((el) => { (el as unknown as { type: string }).type = 'text'; });
      await page.locator('input[name="contactEmail"]').fill('not-an-email');
      await page.getByRole('button', { name: 'Save', exact: true }).click();
      await expect(page.getByRole('alert')).toContainText(/email/i);
    } finally {
      await page.request.put(`${API}/antiban/settings`, { headers, data: {
        closingMessageEnabled: original.closingMessageEnabled, contactPhone: original.contactPhone ?? '', contactEmail: original.contactEmail ?? '',
        defaultPurpose: original.defaultPurpose ?? ''
      } });
    }
  });

  test('S6 S7 the new-campaign form asks for a purpose, offers the media-after-reply switch, and warns about identical text', async ({ page }) => {
    await signIn(page);
    const s = await ensureSeed(page);
    const headers = await headersOf(page);
    const tagName = `e2e-vis-${String(STAMP)}`;
    const tagId = ((await (await page.request.post(`${API}/tags`, { headers, data: { name: tagName } })).json()) as { data: { id: string } }).data.id;
    await page.request.post(`${API}/contacts/${s.heldContactId}/tags`, { headers, data: { tagId } });

    await page.goto('/broadcast/new');
    const switchBox = page.locator('input[name="mediaAfterReply"]');
    await expect(switchBox).toBeChecked();                      // on by default (AC-7.3)
    await expect(page.locator('input[name="purpose"]')).toBeVisible();

    // The same words for everyone earn a warning; a {a|b} choice takes it away. Either way the campaign can still be made.
    const body = page.locator('textarea[name="body"]');
    await body.fill('Hi {{name}}, the same text for everybody.');
    await expect(page.getByTestId('warning-no_variation')).toBeVisible();
    await body.fill('{Hi|Hello} {{name}}, a little different each time.');
    await expect(page.getByTestId('warning-no_variation')).toHaveCount(0);

    const name = `E2E purpose ${String(STAMP)}`;
    await page.locator('input[name="name"]').fill(name);
    await page.locator('input[name="purpose"]').fill('you applied for the Pune driver job');
    await switchBox.uncheck();
    const pick = async (select: string, text: string): Promise<void> => {
      const value = await page.locator(`select[name="${select}"] option`, { hasText: text }).first().getAttribute('value');
      await page.locator(`select[name="${select}"]`).selectOption(value ?? '');
    };
    await pick('senderIdentityId', SENDER);
    await pick('fromTagId', tagName);
    await page.getByRole('button', { name: /create|save|draft/i }).first().click();
    await expect(page).toHaveURL(/\/broadcast\/[0-9a-f-]{36}/);

    // What was typed is what was stored.
    const id = /\/broadcast\/([0-9a-f-]{36})/.exec(page.url())![1]!;
    const stored = ((await (await page.request.get(`${API}/campaigns/${id}`, { headers })).json()) as {
      data: { purpose: string | null; mediaAfterReply: boolean }
    }).data;
    expect(stored.purpose).toBe('you applied for the Pune driver job');
    expect(stored.mediaAfterReply).toBe(false);
    await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  });

  test('cleanup: leave nothing running', async ({ page }) => {
    await signIn(page);
    const s = await ensureSeed(page);
    const headers = await headersOf(page);
    const list = ((await (await page.request.get(`${API}/campaigns`, { headers })).json()) as { data: Array<{ id: string; name: string; status: string }> }).data;
    for (const c of list.filter((x) => x.name.startsWith(`E2E visibility`) && x.name.includes(String(STAMP)) && x.status === 'running')) {
      await page.request.post(`${API}/campaigns/${c.id}/cancel`, { headers });
    }
    await page.request.post(`${API}/campaigns/${s.campaignId}/cancel`, { headers });
  });
});
