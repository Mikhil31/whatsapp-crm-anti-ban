'use client';

import { etaLines, formatWait, laneLines, quotaLine, type EtaFacts, type LaneFacts } from '@/lib/visibility';
import { describeReason } from '@/lib/reasons';
import { ReasonButton } from './reason-action';
import { useNow } from './use-now';

/**
 * When the campaign finishes (F6 AC-10.3), in the owner's words, and what pushed it back. It moves whenever the campaign page
 * re-reads the numbers behind it.
 */
export function EtaLine({ eta, serverNow }: { eta: EtaFacts; serverNow: string }) {
  const now = useNow(serverNow, 30_000);
  const { headline, delay } = etaLines(eta, now);
  return (
    <div data-testid="campaign-eta" className="card mb-3 p-4">
      <p className="text-xs font-medium uppercase tracking-wide text-muted">Estimated finish</p>
      <p data-testid="eta-headline" className="mt-1 text-base font-medium" suppressHydrationWarning>{headline}</p>
      {delay !== null && <p data-testid="eta-delay" className="mt-0.5 text-sm text-muted" suppressHydrationWarning>{delay}</p>}
      {eta.basis === 'time_only' && eta.finishAt !== null && (
        <p className="mt-0.5 text-xs text-muted">WhatsApp has not said how many new chats this number has left, so this counts time only.</p>
      )}
    </div>
  );
}

/** The live part of a number's card (F6 AC-10.4): when it sends next, what it is holding back, its warning level and its hints. */
export function NumberLane({ senderId, lane, serverNow, quota, linkedSince, hints }: {
  senderId: string;
  lane: LaneFacts;
  serverNow: string;
  quota: { cappingStatus: string | null; cappingUsedQuota: number | null; cappingTotalQuota: number | null; cappingCycleEnd: string | null };
  linkedSince: string | null;
  hints: Array<{ code: string; text: string }>;
}) {
  const now = useNow(serverNow);
  const { sending, holding } = laneLines(lane, now);
  const q = quotaLine(quota, now);
  const holdReason = lane.hold === null ? null : describeReason(lane.hold.reason, { until: lane.hold.until });
  const tone = q.tone === 'danger' ? 'text-danger' : q.tone === 'warn' ? 'text-warning' : 'text-success';
  return (
    <div data-testid="number-lane" className="mt-3 rounded-lg border border-border bg-canvas px-3 py-2.5 text-sm">
      <p data-testid="lane-sending" className="font-medium" suppressHydrationWarning>{sending}</p>
      {holding !== null && (
        <p data-testid="lane-holding" className="mt-0.5 flex flex-wrap items-center gap-x-2 text-warning" suppressHydrationWarning>
          <span>{holding}</span>
          {lane.hold !== null && holdReason !== null && holdReason.action !== null && <ReasonButton code={lane.hold.reason} senderId={senderId} until={lane.hold.until} />}
        </p>
      )}
      <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-xs">
        <dt className="text-muted">WhatsApp warning</dt>
        <dd data-testid="lane-warning" className={`font-medium ${tone}`} suppressHydrationWarning>
          {q.level}{q.used !== null && <span className="font-normal text-ink"> · {q.used}</span>}{q.resets !== null && <span className="font-normal text-muted"> · {q.resets}</span>}
        </dd>
        <dt className="text-muted">Linked since</dt>
        <dd data-testid="lane-linked-since" suppressHydrationWarning>{linkedSince === null ? 'not linked' : whenLinked(linkedSince, now)}</dd>
      </dl>
      <p data-testid="lane-updated" className="mt-2 text-[11px] text-muted" suppressHydrationWarning>
        Updated {formatWait(Math.max(0, now.getTime() - new Date(serverNow).getTime()))} ago
      </p>
      {hints.length > 0 && (
        <ul data-testid="lane-hints" className="mt-2 flex flex-col gap-1">
          {hints.map((h) => <li key={h.code} className="notice text-xs">{h.text}</li>)}
        </ul>
      )}
    </div>
  );
}

/** When a number was linked, as a date with how long ago. */
function whenLinked(iso: string, now: Date): string {
  const days = Math.floor((now.getTime() - new Date(iso).getTime()) / 86_400_000);
  const date = new Date(iso).toLocaleDateString([], { day: 'numeric', month: 'short', year: 'numeric' });
  return days <= 0 ? `${date} (today)` : `${date} (${String(days)} day${days === 1 ? '' : 's'} ago)`;
}
