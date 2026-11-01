import { test, expect, type Page } from '@playwright/test';
import { signIn, CREDS_MISSING } from './helpers';

const API = process.env.E2E_API_URL ?? 'http://localhost:3000/api/v1';

/**
 * F13 CW-2.1, in the browser: a running campaign shows the countdown ring, a pulsing "Sending" pill and the count line; a paused one
 * says "Paused" and nothing moves. The number is never linked, so nothing can really be sent and the campaign stays running until
 * it is paused here.
 */
const STAMP = Date.now();
// A corner of the fiction range no other spec uses (0500 to 0599).
const phone = (i: number): string => `+1202555${String(500 + ((STAMP + i * 7) % 100)).padStart(4, '0')}`;

/** The CSRF-carrying headers of the signed-in page. */
async function headersOf(page: Page): Promise<Record<string, string>> {
  const csrf = (await page.context().cookies()).find((c) => c.name === 'crm_csrf')?.value ?? '';
  return { 'x-csrf-token': csrf, 'content-type': 'application/json' };
}

/** A number that is never linked, one contact, and a started campaign to them. Returns the campaign id. */
async function runningCampaign(page: Page): Promise<string> {
  const headers = await headersOf(page);
  const sender = await page.request.post(`${API}/senders`, { headers, data: { label: `E2E live panel ${String(STAMP)}`, provider: 'baileys' } });
  expect(sender.status()).toBe(201);
  const senderId = ((await sender.json()) as { data: { id: string } }).data.id;
  const made = await page.request.post(`${API}/contacts`, { headers, data: { displayName: 'E2E Live Panel', phone: phone(1) } });
  const contactId = made.status() === 201
    ? ((await made.json()) as { data: { id: string } }).data.id
    : ((await made.json()) as { existingContactId: string }).existingContactId;
  const created = await page.request.post(`${API}/campaigns`, {
    headers, data: { name: `E2E live panel ${String(STAMP)}`, body: 'Hi {{name}}, an e2e live panel test.', senderIdentityId: senderId, explicitContactIds: [contactId] }
  });
  expect(created.status()).toBe(201);
  const id = ((await created.json()) as { data: { id: string } }).data.id;
  const started = await page.request.post(`${API}/campaigns/${id}/start`, {
    headers, data: { overrideGates: ['engagement', 'cooldown', 'duplicate_campaign'], reason: 'e2e re-run reuses a small pool of fiction numbers' }
  });
  expect(started.status()).toBeLessThan(300);
  return id;
}

test.describe('campaign live panel (F13 CW-2.1)', () => {
  test.skip(CREDS_MISSING, 'set TEST_EMAIL / TEST_PASSWORD in .env');
  test.describe.configure({ mode: 'serial' });
  test.setTimeout(120_000);

  let campaignId = '';

  test('a running campaign shows the ring, the Sending pill and the count line', async ({ page }) => {
    await signIn(page);
    campaignId = await runningCampaign(page);
    await page.goto(`/broadcast/${campaignId}`);
    const panel = page.getByTestId('live-panel');
    await expect(panel).toHaveAttribute('data-state', 'running');
    await expect(panel.getByRole('img', { name: /next send/ })).toBeVisible();
    const pill = panel.getByTestId('live-pill');
    await expect(pill).toHaveText('Sending');
    await expect(pill).toHaveAttribute('data-animated', 'true');
    await expect(panel.getByRole('list', { name: 'Counts' }).getByRole('listitem')).toHaveText([/Sent/, /Delivered/, /Read/, /Not yet/]);
  });

  test('a paused campaign says Paused and nothing animates', async ({ page }) => {
    await signIn(page);
    const paused = await page.request.post(`${API}/campaigns/${campaignId}/pause`, { headers: await headersOf(page) });
    expect(paused.status()).toBeLessThan(300);
    await page.goto(`/broadcast/${campaignId}`);
    const panel = page.getByTestId('live-panel');
    await expect(panel).toHaveAttribute('data-state', 'paused');
    const pill = panel.getByTestId('live-pill');
    await expect(pill).toHaveText('Paused');
    await expect(pill).toHaveAttribute('data-animated', 'false');
    await expect(panel.getByRole('img', { name: /next send/ })).toHaveCount(0);
  });
});
