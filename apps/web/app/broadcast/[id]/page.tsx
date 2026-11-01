import { redirect, notFound } from 'next/navigation';
import Link from 'next/link';
import {
  getCampaign, getCampaignEta, listCampaignRecipients, listSenders, previewCampaign, getMe, CrmApiError, NotAuthenticatedError
} from '@/lib/crm';
import type { Me, CampaignDetail, CampaignPreview, CampaignEta, RecipientPage, CampaignRecipient, Sender } from '@/lib/crm';
import { campaignStatusBadge } from '../campaign-status';
import { CampaignControls, SendAnywayButton } from '../campaign-controls';
import { AutoRefresh } from '../auto-refresh';
import { GATE_LABEL } from '../gates';
import { estimateTimes, isShow, REASON_SHOW_PREFIX } from '@/lib/recipient-status';
import { LivePanel } from './live-panel';
import { RecipientList } from './recipient-list';
import { FilterBar } from './filter-bar';

/** Rendered per request — progress and the status/search filters come live from the query string. */
export const dynamic = 'force-dynamic';

/**
 * One campaign's page: a live panel (is it working, who is next, when it is done), the message it sends, and the **list of everyone**
 * in send order from the moment it starts, none silently absent, each with where they are in words, the latest message in their
 * chat, and for those not reached the reason and the action that goes with it. One search box and one Show menu, paged.
 * This is how an operator answers "who did this reach, and why not the rest?" (F5 AC-5, F6 AC-10.2, F13 section 2).
 */
export default async function CampaignPage(
  { params, searchParams }: {
    params: Promise<{ id: string }>;
    searchParams: Promise<{ show?: string; reason?: string; q?: string; cursor?: string; created?: string }>;
  }
) {
  const { id } = await params;
  const { show, reason, q, cursor, created } = await searchParams;
  // The Show menu writes either a group (`waiting`) or `reason:<code>`; a reason can also come on its own.
  const showRaw = typeof show === 'string' ? show : '';
  const activeReason = showRaw.startsWith(REASON_SHOW_PREFIX) ? showRaw.slice(REASON_SHOW_PREFIX.length) : typeof reason === 'string' ? reason : '';
  const activeShow = isShow(showRaw) ? showRaw : '';
  const query = typeof q === 'string' ? q : '';
  const activeCursor = typeof cursor === 'string' ? cursor : '';
  const serverNow = new Date().toISOString();

  let me: Me | null = null;
  let campaign: CampaignDetail | null = null;
  let page: RecipientPage = { data: [], nextCursor: null, reasons: [] };
  let eta: CampaignEta | null = null;
  let sender: Sender | null = null;
  let head: CampaignRecipient | null = null;
  let preview: CampaignPreview | null = null;
  let failure: string | null = null;
  let expired = false;
  let missing = false;
  try {
    [campaign, page, me] = await Promise.all([
      getCampaign(id),
      listCampaignRecipients(id, { show: activeShow, reason: activeReason, q: query, cursor: activeCursor }),
      getMe()
    ]);
    // When it finishes only means something once it has an audience that is still being sent to. If it cannot be read the page
    // still works without it.
    if (campaign.status === 'running' || campaign.status === 'paused') eta = await getCampaignEta(id).catch((): CampaignEta | null => null);
    // Who goes next and when: the first queued person in send order, and the number's lane says when its message goes. Neither is
    // needed for the page to work, so a failure leaves them out.
    if (campaign.status === 'running' || campaign.status === 'paused') {
      const [senders, queued] = await Promise.all([
        listSenders().catch((): Sender[] => []),
        listCampaignRecipients(id, { show: 'waiting', limit: 1 }).catch((): RecipientPage | null => null)
      ]);
      sender = senders.find((x) => x.id === campaign?.senderIdentityId) ?? null;
      head = queued?.data[0] ?? null;
    }
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
  // Who goes next, and a guess at when each person after them goes. The head's time is the number's own next-send time; a guess
  // is only right on a page that starts at the head of the queue, so a filter, a search or a later page gets none.
  const headHeld = head !== null && (head.holdReason ?? null) !== null;
  const headDueAt = head === null || headHeld ? null : sender?.lane?.nextSendAt ?? null;
  const unfiltered = activeShow === '' && activeReason === '' && query === '' && activeCursor === '';
  const around: Record<string, string> = {};
  if (unfiltered && head !== null && headDueAt !== null) {
    for (const [rid, at] of estimateTimes(recipients, head.id, new Date(headDueAt))) around[rid] = at.toISOString();
  }
  const panelStatus = campaign?.status === 'running' || campaign?.status === 'paused' || campaign?.status === 'completed' || campaign?.status === 'cancelled'
    ? campaign.status : null;

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
              {' '}<Link href="/numbers" className="btn btn-sm min-h-11" data-action="open-number">Open the number</Link>
            </p>
          )}

          {campaign.pauseReason === 'unlinked' && campaign.status === 'paused' && (
            <p role="alert" className="mb-4 notice notice-warning">
              Paused automatically: the sending number was removed under Linked devices on the phone. Link it
              again on the Numbers page, then resume.
              {' '}<Link
                href={`/link?start=${encodeURIComponent(campaign.senderIdentityId)}`} className="btn btn-sm min-h-11" data-action="relink"
              >Link it again</Link>
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
                : panelStatus !== null && (
                  <LivePanel
                    id={id} status={panelStatus} progress={campaign.progress} eta={eta} serverNow={serverNow} activeShow={activeShow}
                    next={head === null ? null : { name: head.displayName ?? head.identity ?? 'the next person', dueAt: headDueAt, gapMs: head.plannedGapMs ?? null }}
                  />
                )}

              {(campaign.warnings ?? []).map((w) => (
                <p key={w.code} role="status" data-testid={`warning-${w.code}`} className="mb-3 notice notice-warning">{w.message}</p>
              ))}

              <section className="mt-6">
                <div className="mb-3 flex items-center justify-between">
                  <h2 className="text-base font-semibold tracking-tight">Recipients</h2>
                  <span className="text-sm text-muted">{recipients.length} shown{page.nextCursor !== null ? ', more on the next page' : ''}</span>
                </div>

                <FilterBar id={id} show={activeShow} reason={activeReason} query={query} reasons={page.reasons} />

                {recipients.length === 0 && (
                  <p className="text-sm text-muted">
                    {campaign.progress.total === 0
                      ? 'No recipients yet — this campaign has not been started, so its audience is not frozen.'
                      : 'No recipients match this filter.'}
                  </p>
                )}

                {recipients.length > 0 && (
                  <RecipientList recipients={recipients} serverNow={serverNow} headId={head?.id ?? null} headDueAt={headDueAt} around={around} />
                )}

                <nav aria-label="Recipient pages" className="mt-3 flex items-center justify-between text-sm">
                  {activeCursor !== ''
                    ? <Link href={hrefFor(id, activeShow, query, activeReason)} className="text-muted hover:text-ink">← First page</Link>
                    : <span />}
                  {page.nextCursor !== null
                    ? <Link href={hrefFor(id, activeShow, query, activeReason, page.nextCursor)} className="btn btn-sm" rel="next">Next page →</Link>
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

/** Builds a link to this campaign showing one group and search term, at a page (the cursor of the page before). */
function hrefFor(id: string, show: string, query: string, reason = '', cursor = ''): string {
  const p = new URLSearchParams();
  if (reason !== '') p.set('show', `${REASON_SHOW_PREFIX}${reason}`);
  else if (show !== '') p.set('show', show);
  if (query !== '') p.set('q', query);
  if (cursor !== '') p.set('cursor', cursor);
  const qs = p.toString();
  return `/broadcast/${id}${qs === '' ? '' : `?${qs}`}`;
}
