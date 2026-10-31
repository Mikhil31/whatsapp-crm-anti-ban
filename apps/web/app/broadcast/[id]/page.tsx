import { redirect, notFound } from 'next/navigation';
import Link from 'next/link';
import {
  getCampaign, getCampaignEta, listCampaignRecipients, previewCampaign, getMe, CrmApiError, NotAuthenticatedError
} from '@/lib/crm';
import type { Me, CampaignDetail, CampaignRecipient, CampaignPreview, CampaignEta, RecipientPage } from '@/lib/crm';
import { campaignStatusBadge } from '../campaign-status';
import { Meter, initialsOf } from '../../ui';
import { CampaignControls, SendAnywayButton } from '../campaign-controls';
import { AutoRefresh } from '../auto-refresh';
import { GATE_LABEL } from '../gates';
import { describeReason } from '@/lib/reasons';
import { formatWait } from '@/lib/visibility';
import { ReasonButton, ReasonSentence } from '@/components/reason-action';
import { EtaLine } from '@/components/live-lines';

/** Rendered per request — progress and the status/search filters come live from the query string. */
export const dynamic = 'force-dynamic';

/** The recipient statuses, in the order the filter bar shows them. */
const STATUSES = ['sent', 'queued', 'pending', 'skipped', 'failed'] as const;

/**
 * One campaign's page: its progress and estimated finish, the message it sends, and the **per-recipient table**: every recipient in
 * a terminal or pending state, none silently absent, each with its state, the reason it is held, skipped or failed in a sentence,
 * the action that goes with it, and the gap drawn for it. Filterable by state and reason, searchable by name or number, paged.
 * This is how an operator answers "who did this reach, and why not the rest?" (F5 AC-5, F6 AC-10.2).
 */
export default async function CampaignPage(
  { params, searchParams }: {
    params: Promise<{ id: string }>;
    searchParams: Promise<{ status?: string; reason?: string; q?: string; cursor?: string; created?: string }>;
  }
) {
  const { id } = await params;
  const { status, reason, q, cursor, created } = await searchParams;
  const activeStatus = typeof status === 'string' ? status : '';
  const activeReason = typeof reason === 'string' ? reason : '';
  const query = typeof q === 'string' ? q : '';
  const activeCursor = typeof cursor === 'string' ? cursor : '';
  const serverNow = new Date().toISOString();

  let me: Me | null = null;
  let campaign: CampaignDetail | null = null;
  let page: RecipientPage = { data: [], nextCursor: null, reasons: [] };
  let eta: CampaignEta | null = null;
  let preview: CampaignPreview | null = null;
  let failure: string | null = null;
  let expired = false;
  let missing = false;
  try {
    [campaign, page, me] = await Promise.all([
      getCampaign(id),
      listCampaignRecipients(id, { status: activeStatus, reason: activeReason, q: query, cursor: activeCursor }),
      getMe()
    ]);
    // When it finishes only means something once it has an audience that is still being sent to. If it cannot be read the page
    // still works without it.
    if (campaign.status === 'running' || campaign.status === 'paused') eta = await getCampaignEta(id).catch((): CampaignEta | null => null);
    // A draft has no frozen audience yet, so its progress is all zeros — a dry-run preview is the
    // useful thing to show before start. One extra round trip, and only for drafts.
    if (campaign.status === 'draft') preview = await previewCampaign(id);
  } catch (error) {
    if (error instanceof NotAuthenticatedError) expired = true;
    else if (error instanceof CrmApiError && error.status === 404) missing = true;
    else {
      failure = error instanceof CrmApiError
        ? `${error.code}: ${error.message}`
        : 'Could not reach the API. Is it running? Start it with: npm run dev';
    }
  }

  if (expired) redirect(`/login?next=/broadcast/${id}`);
  if (missing) notFound();
  const recipients = page.data;

  return (
    <main className="page">
      <Link href="/broadcast" className="text-sm text-muted hover:text-ink">← All campaigns</Link>

      {failure !== null && <p className="notice notice-danger mt-4">{failure}</p>}

      {campaign !== null && (
        <>
          <header className="mb-6 mt-3 flex flex-wrap items-start justify-between gap-4">
            <div className="min-w-0">
              <div className="flex items-center gap-3">
                <h1 className="page-title truncate">{campaign.name}</h1>
                <StatusBadge status={campaign.status} />
              </div>
              <p className="page-desc">
                {campaign.startedAt !== null
                  ? <>Started {new Date(campaign.startedAt).toLocaleString()}</>
                  : <>Draft — not started yet</>}
              </p>
            </div>
            <CampaignControls id={id} status={campaign.status} isAdmin={me?.role === 'admin'} />
          </header>

          {created === '1' && campaign.status === 'draft' && (
            <p role="status" className="mb-4 notice notice-success">
              Draft created. Nothing has been sent yet — check the message and who it reaches, then press Start.
            </p>
          )}

          {campaign.status === 'running' && <AutoRefresh />}

          {campaign.status === 'draft' && preview !== null && (preview.audience.recentlyMessaged ?? 0) > 0 && (
            <div role="alert" className="mb-4 notice notice-warning flex flex-wrap items-center justify-between gap-3">
              <p>
                {preview.audience.recentlyMessaged} of {preview.audience.reachable} contacts were already messaged in another
                campaign{(preview.audience.recentCampaign ?? null) !== null ? <>, “{preview.audience.recentCampaign}”</> : null}, in the
                last 14 days. They will be skipped unless you send anyway.
              </p>
              {me?.role === 'admin' ? <SendAnywayButton /> : <span className="text-xs">Only an admin can send anyway.</span>}
            </div>
          )}

          {campaign.pauseReason === 'ban_suspected' && campaign.status === 'paused' && (
            <p role="alert" className="mb-4 notice notice-danger">
              Paused automatically: WhatsApp refused or logged out the sending number, which can mean a ban.
              Open WhatsApp on that phone and look for a notice before resuming anything. The Numbers page has
              the details.
            </p>
          )}

          {campaign.pauseReason === 'unlinked' && campaign.status === 'paused' && (
            <p role="alert" className="mb-4 notice notice-warning">
              Paused automatically: the sending number was removed under Linked devices on the phone. Link it
              again on the Numbers page, then resume.
            </p>
          )}

          {campaign.gateOverrides.length > 0 && (
            <p className="mb-4 notice notice-warning">
              An admin lifted: {campaign.gateOverrides.map((g) => GATE_LABEL[g]?.split(' — ')[0] ?? g).join(', ')}
              {campaign.gateOverrideReason !== null && <> — “{campaign.gateOverrideReason}”</>}
            </p>
          )}

          <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_20rem]">
            <div className="min-w-0">
              {campaign.status === 'draft' && preview !== null
                ? <DraftPreview preview={preview} />
                : <ProgressHeader campaign={campaign} activeStatus={activeStatus} query={query} id={id} />}

              {eta !== null && <EtaLine eta={eta} serverNow={serverNow} />}

              {(campaign.warnings ?? []).map((w) => (
                <p key={w.code} role="status" data-testid={`warning-${w.code}`} className="mb-3 notice notice-warning">{w.message}</p>
              ))}

              <section className="mt-6">
                <div className="mb-3 flex items-center justify-between">
                  <h2 className="text-base font-semibold tracking-tight">Recipients</h2>
                  <span className="text-sm text-muted">{recipients.length} shown{page.nextCursor !== null ? ', more on the next page' : ''}</span>
                </div>

                <StatusFilterBar id={id} activeStatus={activeStatus} activeReason={activeReason} query={query} />
                <ReasonFilterBar id={id} activeStatus={activeStatus} activeReason={activeReason} query={query} reasons={page.reasons} />
                <SearchBox id={id} activeStatus={activeStatus} activeReason={activeReason} query={query} />

                {recipients.length === 0 && (
                  <p className="text-sm text-muted">
                    {campaign.progress.total === 0
                      ? 'No recipients yet — this campaign has not been started, so its audience is not frozen.'
                      : 'No recipients match this filter.'}
                  </p>
                )}

                {recipients.length > 0 && <RecipientTable recipients={recipients} />}

                <nav aria-label="Recipient pages" className="mt-3 flex items-center justify-between text-sm">
                  {activeCursor !== ''
                    ? <Link href={hrefFor(id, activeStatus, query, activeReason)} className="text-muted hover:text-ink">← First page</Link>
                    : <span />}
                  {page.nextCursor !== null
                    ? <Link href={hrefFor(id, activeStatus, query, activeReason, page.nextCursor)} className="btn btn-sm" rel="next">Next page →</Link>
                    : <span />}
                </nav>
              </section>
            </div>

            <aside className="lg:sticky lg:top-6">
              {campaign.mediaAssetId !== null && (
                <section className="card mb-4 p-4" aria-label="Picture">
                  <h2 className="text-sm font-semibold">Picture</h2>
                  {/* A safe re-encoded preview from our own server (the original is never shown inline). */}
                  <img src={`/media/${campaign.mediaAssetId}/thumb`} alt="The picture sent with this campaign" className="mt-2 max-h-52 rounded-lg border border-border" />
                  <p className="mt-2 text-xs text-muted">
                    {campaign.mediaFilename ?? 'picture'}{campaign.mediaSizeBytes !== null ? ` · ${(campaign.mediaSizeBytes / 1048576).toFixed(2)} MB` : ''}
                    {campaign.mediaContentType === 'image/gif' ? ' · GIF, sent as a looping clip' : ''}. Sent to everyone with the message below as its caption.
                  </p>
                </section>
              )}
              <MessageBody body={campaign.body} />
            </aside>
          </div>
        </>
      )}
    </main>
  );
}

/** The campaign status badge, reusing the list's colours. */
function StatusBadge({ status }: { status: string }) {
  const badge = campaignStatusBadge(status);
  return (
    <span className={`badge ${badge.cls}`}>
      {badge.label}
    </span>
  );
}

/**
 * The campaign's progress as a compact header: the bar, then the counts as one line of links, each filtering the table below to that
 * state — so the summary and the detail are one thing, not two.
 */
function ProgressHeader(
  { campaign, activeStatus, query, id }:
  { campaign: CampaignDetail; activeStatus: string; query: string; id: string }
) {
  const p = campaign.progress;
  const counts: Array<{ key: string; label: string; value: number; filter: string }> = [
    { key: 'total', label: 'total', value: p.total, filter: '' },
    { key: 'sent', label: 'sent', value: p.sent, filter: 'sent' },
    { key: 'queued', label: 'queued', value: p.queued, filter: 'queued' },
    { key: 'pending', label: 'pending', value: p.pending, filter: 'pending' },
    { key: 'skipped', label: 'skipped', value: p.skipped, filter: 'skipped' },
    { key: 'failed', label: 'failed', value: p.failed, filter: 'failed' }
  ];

  // The bar counts people actually attempted. Skipped people were never sent anything, so a campaign that skipped everyone
  // must not look finished.
  const done = p.sent + p.failed;
  const allSkipped = p.total > 0 && p.skipped === p.total;
  return (
    <div className="card mb-3 p-4">
      <div className="mb-2 flex items-baseline justify-between">
        <p className="font-medium">
          <span className="tabular-nums">{done}</span> of <span className="tabular-nums">{p.total}</span> sent
          {p.skipped > 0 && <span className="text-muted"> · {p.skipped} skipped</span>}
          {p.queued > 0 && <span className="text-muted"> · {p.queued} queued</span>}
        </p>
        <p className="text-sm tabular-nums text-muted">
          {p.total === 0 ? 0 : Math.round((done / p.total) * 100)}%
        </p>
      </div>
      <Meter value={done} max={p.total} label="Campaign progress" />
      <ul aria-label="Counts" className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-sm">
        {counts.map((c) => (
          <li key={c.key}>
            <Link
              href={hrefFor(id, c.filter, query)}
              className={(activeStatus === c.filter) ? 'font-semibold text-ink underline' : 'text-muted hover:text-ink'}
            >
              <span className="tabular-nums">{c.value}</span> {c.label}
            </Link>
          </li>
        ))}
      </ul>
      {allSkipped && (
        <p role="alert" className="mt-2 text-sm text-warning">
          Nothing was sent: all {p.total} people were skipped. See the Skipped list below for why.
        </p>
      )}
    </div>
  );
}

/**
 * The dry-run preview shown for a draft: who it would reach, before anything is
 * frozen. The unreachable count is called out because a tag of contacts with no numbers is a
 * mistake worth catching before pressing Start, not after.
 */
function DraftPreview({ preview }: { preview: CampaignPreview }) {
  const { audience } = preview;
  return (
    <div className="rounded-lg border border-border bg-surface px-4 py-3">
      <p className="text-xs font-medium text-muted">Dry run — nothing sent yet</p>
      <p className="mt-1 text-sm">
        Would message <span className="font-semibold tabular-nums">{audience.reachable}</span>{' '}
        {audience.reachable === 1 ? 'person' : 'people'}
        {audience.unreachable > 0 && (
          <> · <span className="tabular-nums">{audience.unreachable}</span> skipped (no number)</>
        )}
        {' '}· {audience.total} in the audience.
      </p>
      {audience.reachable === 0 && (
        <p className="mt-1 text-xs text-danger">
          Nobody in this audience has a number — starting would send to no one. Check the tag.
        </p>
      )}
    </div>
  );
}

/** The message every recipient is sent — shown so the results are read next to what went out. */
function MessageBody({ body }: { body: string }) {
  return (
    <section className="card p-4">
      <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-muted">Message</h2>
      <div className="rounded-2xl rounded-tl-sm bg-accent-soft px-4 py-3">
        <p className="whitespace-pre-wrap break-words text-[15px] leading-relaxed">{body}</p>
      </div>
      <p className="mt-3 text-xs text-muted">
        Each person gets their own copy: <code>{'{{name}}'}</code> and any <code>{'{a|b}'}</code> choices are
        filled in per recipient.
      </p>
    </section>
  );
}

/** The row of state filters. "All" clears it; the active one is highlighted. */
function StatusFilterBar(
  { id, activeStatus, activeReason, query }: { id: string; activeStatus: string; activeReason: string; query: string }
) {
  const chip = (active: boolean): string =>
    `badge capitalize ${active ? 'badge-accent !border-accent/40 font-semibold' : 'text-muted hover:bg-accent-soft'}`;
  return (
    <div className="mb-2 flex flex-wrap items-center gap-1.5">
      <span className="text-xs text-muted">State:</span>
      <Link href={hrefFor(id, '', query, activeReason)} className={chip(activeStatus === '')}>All</Link>
      {STATUSES.map((s) => (
        <Link key={s} href={hrefFor(id, s, query, activeReason)} className={chip(activeStatus === s)}>{s}</Link>
      ))}
    </div>
  );
}

/** The reasons this campaign has, as filters, each with how many. Absent while nobody is held, skipped or failed. */
function ReasonFilterBar(
  { id, activeStatus, activeReason, query, reasons }:
  { id: string; activeStatus: string; activeReason: string; query: string; reasons: RecipientPage['reasons'] }
) {
  // A reason in the address that this campaign does not have still shows, so it can be cleared.
  const list = activeReason !== '' && !reasons.some((r) => r.reason === activeReason)
    ? [{ reason: activeReason, count: 0 }, ...reasons] : reasons;
  if (list.length === 0) return null;
  const chip = (active: boolean): string =>
    `badge ${active ? 'badge-accent !border-accent/40 font-semibold' : 'text-muted hover:bg-accent-soft'}`;
  return (
    <div data-testid="reason-filters" className="mb-3 flex flex-wrap items-center gap-1.5">
      <span className="text-xs text-muted">Reason:</span>
      <Link href={hrefFor(id, activeStatus, query)} className={chip(activeReason === '')}>Any</Link>
      {list.map((r) => (
        <Link key={r.reason} href={hrefFor(id, activeStatus, query, r.reason)} className={chip(activeReason === r.reason)}
          title={describeReason(r.reason).sentence} data-reason={r.reason}>
          {r.reason} <span className="tabular-nums text-muted">{r.count}</span>
        </Link>
      ))}
    </div>
  );
}

/** Search by contact name or number, keeping the active filters. */
function SearchBox(
  { id, activeStatus, activeReason, query }: { id: string; activeStatus: string; activeReason: string; query: string }
) {
  return (
    <form className="mb-4 flex gap-2" action={`/broadcast/${id}`}>
      {activeStatus !== '' && <input type="hidden" name="status" value={activeStatus} />}
      {activeReason !== '' && <input type="hidden" name="reason" value={activeReason} />}
      <input
        name="q"
        defaultValue={query}
        placeholder="Search recipient name or number…"
        aria-label="Search recipients"
        className="flex-1 field"
      />
      <button
        type="submit"
        className="btn"
      >
        Search
      </button>
    </form>
  );
}

/** The state a recipient is in, in a word: for a sent recipient the message's own state (delivered, read) says more than "sent". */
function stateOf(r: CampaignRecipient): string {
  return r.status === 'sent' && r.messageStatus !== null && r.messageStatus !== 'sent' ? r.messageStatus : r.status;
}

/** Every recipient of this page: who, in what state, why, what can be done, and the gap drawn for them. */
function RecipientTable({ recipients }: { recipients: CampaignRecipient[] }) {
  return (
    <div className="card overflow-x-auto">
      <table data-testid="recipient-table" className="w-full text-left text-sm">
        <thead className="text-xs text-muted">
          <tr>
            <th scope="col" className="px-4 py-2 font-medium">Contact</th>
            <th scope="col" className="px-3 py-2 font-medium">State</th>
            <th scope="col" className="px-3 py-2 font-medium">Reason</th>
            <th scope="col" className="px-3 py-2 font-medium">Action</th>
            <th scope="col" className="px-3 py-2 font-medium">Gap</th>
          </tr>
        </thead>
        <tbody>
          {recipients.map((r) => <RecipientRow key={r.id} recipient={r} />)}
        </tbody>
      </table>
    </div>
  );
}

/** One recipient's row. */
function RecipientRow({ recipient: r }: { recipient: CampaignRecipient }) {
  const state = stateOf(r);
  const cls =
    r.status === 'sent' ? 'text-success border-transparent bg-success-soft'
    : r.status === 'failed' ? 'text-danger border-danger/50'
    : r.status === 'skipped' ? 'text-warning border-warning/40 bg-warning-soft'
    : 'text-muted border-border';
  const target = {
    messageId: r.messageId ?? null, senderId: r.senderIdentityId ?? null, contactId: r.contactId ?? null,
    conversationId: r.conversationId ?? null
  };
  // A skipped recipient has no message, so its reason is the skip reason; otherwise the hold or the failure.
  const code = r.reason ?? null;
  return (
    <tr data-testid="recipient-row" data-status={r.status} data-reason={code ?? ''} className="border-t border-border align-top">
      <td className="px-4 py-3">
        <div className="flex min-w-0 items-center gap-3">
          <span className="avatar size-9 text-sm" aria-hidden>
            {initialsOf(r.displayName ?? r.identity ?? '?')}
          </span>
          <div className="min-w-0">
            <p className="truncate font-medium">{r.displayName ?? r.identity ?? 'Unnamed contact'}</p>
            <p className="truncate text-xs text-muted">
              {r.identity ?? 'no contact details'}
              {r.attemptedAt !== null && <span suppressHydrationWarning> · {new Date(r.attemptedAt).toLocaleString()}</span>}
            </p>
          </div>
        </div>
      </td>
      <td className="px-3 py-3"><span className={`badge capitalize ${cls}`}>{state}</span></td>
      <td className="px-3 py-3">
        {code === null ? <span className="text-muted">—</span> : (
          <ReasonSentence code={code} until={r.holdUntil ?? null} detail={r.errorDetail ?? null} {...target} />
        )}
      </td>
      <td className="px-3 py-3">
        {code !== null && <ReasonButton code={code} until={r.holdUntil ?? null} detail={r.errorDetail ?? null} {...target} />}
      </td>
      <td className="whitespace-nowrap px-3 py-3 tabular-nums text-muted">
        {r.plannedGapMs === null || r.plannedGapMs === undefined ? '—' : formatWait(r.plannedGapMs)}
      </td>
    </tr>
  );
}

/** Builds a link to this campaign filtered by state, reason and search term, at a page (the cursor of the page before). */
function hrefFor(id: string, status: string, query: string, reason = '', cursor = ''): string {
  const p = new URLSearchParams();
  if (status !== '') p.set('status', status);
  if (reason !== '') p.set('reason', reason);
  if (query !== '') p.set('q', query);
  if (cursor !== '') p.set('cursor', cursor);
  const qs = p.toString();
  return `/broadcast/${id}${qs === '' ? '' : `?${qs}`}`;
}
