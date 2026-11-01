'use client';

import Link from 'next/link';
import { useNow } from '@/components/use-now';
import { etaLines, waitPhrase, type EtaFacts } from '@/lib/visibility';
import { reachSummary, type ProgressFacts, type Show } from '@/lib/recipient-status';

/** The ring is full when the wait starts; this is the wait it counts against if the row's own gap is not known. */
const FALLBACK_GAP_MS = 50_000;
const RING_RADIUS = 18;
const RING_LENGTH = 2 * Math.PI * RING_RADIUS;

/** What the panel shows about the person who goes next. */
export interface NextUp {
  readonly name: string;
  /** When their message goes. */
  readonly dueAt: string | null;
  /** The gap they wait for, so the ring knows what "full" is. */
  readonly gapMs: number | null;
}

/** The countdown ring: the time to the next send drains round it. Still when nothing is counting. */
function Ring({ fraction, label }: { fraction: number; label: string }) {
  const offset = RING_LENGTH * (1 - Math.min(1, Math.max(0, fraction)));
  return (
    <svg viewBox="0 0 44 44" className="size-12 shrink-0 -rotate-90" role="img" aria-label={label}>
      <circle cx="22" cy="22" r={RING_RADIUS} fill="none" strokeWidth="4" className="stroke-border" />
      <circle
        cx="22" cy="22" r={RING_RADIUS} fill="none" strokeWidth="4" strokeLinecap="round" className="stroke-bright"
        strokeDasharray={RING_LENGTH} strokeDashoffset={offset}
      />
    </svg>
  );
}

/** The two-colour bar: reached in bright green, not yet in the warning colour, the rest still waiting. */
function ReachBar({ reached, notYet, total }: { reached: number; notYet: number; total: number }) {
  const pct = (n: number): string => `${String(total <= 0 ? 0 : Math.min(100, (n / total) * 100))}%`;
  return (
    <div
      role="progressbar" aria-label="Campaign progress" aria-valuemin={0} aria-valuemax={total} aria-valuenow={reached}
      aria-valuetext={`${String(reached)} of ${String(total)} reached, ${String(notYet)} not yet`}
      className="flex h-2 w-full overflow-hidden rounded-full bg-border"
    >
      <div className="h-full bg-bright" style={{ width: pct(reached) }} />
      <div className="h-full bg-warning" style={{ width: pct(notYet) }} />
    </div>
  );
}

/**
 * The top of the campaign page while it sends (CW-2.1, 2.3, 3.9): whether it is working, who goes next and when, when it will be done
 * and why it takes that long, and the counts. A running campaign has a countdown ring and a pulsing "Sending" pill; a paused or
 * finished one says so and nothing moves. All motion uses `motion-safe:`, so it is off when the viewer has reduced motion set.
 */
export function LivePanel({ id, status, progress, eta, next, serverNow, activeShow }: {
  id: string;
  status: 'running' | 'paused' | 'completed' | 'cancelled';
  progress: ProgressFacts;
  eta: EtaFacts | null;
  next: NextUp | null;
  serverNow: string;
  activeShow: string;
}) {
  const now = useNow(serverNow);
  const summary = reachSummary(progress);
  const running = status === 'running';
  const finished = status === 'completed' || status === 'cancelled';
  const lines = eta === null || finished ? null : etaLines(eta, now);

  const dueMs = next?.dueAt === undefined || next.dueAt === null ? null : new Date(next.dueAt).getTime() - now.getTime();
  const gap = next?.gapMs ?? FALLBACK_GAP_MS;
  const fraction = running && dueMs !== null ? dueMs / Math.max(gap, 1000) : 0;
  const secondsLeft = dueMs === null ? null : Math.max(0, Math.round(dueMs / 1000));

  const pill = running
    ? { text: 'Sending', cls: 'bg-accent-soft text-accent' }
    : status === 'paused' ? { text: 'Paused', cls: 'bg-warning-soft text-warning' }
    : status === 'cancelled' ? { text: 'Stopped', cls: 'bg-warning-soft text-warning' }
    : { text: 'Done', cls: 'bg-success-soft text-success' };

  // Clock time of the finish, e.g. "around 14:52".
  const finishClock = eta === null || eta.finishAt === null ? null
    : new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(eta.finishAt));

  return (
    <section data-testid="live-panel" data-state={status} aria-label="Sending progress" className="card mb-3 p-4">
      <div className="flex flex-wrap items-center gap-4">
        {running && <Ring fraction={fraction} label={secondsLeft === null ? 'Waiting for the next send' : `${String(secondsLeft)} seconds to the next send`} />}
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <span
              data-testid="live-pill" data-animated={running ? 'true' : 'false'}
              className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-semibold ${pill.cls}`}
            >
              <span aria-hidden className={`size-2 rounded-full bg-current ${running ? 'motion-safe:animate-pulse' : ''}`} />
              {pill.text}
            </span>
            {running && next !== null && (
              <p className="text-sm" suppressHydrationWarning>
                Next message to <span className="font-medium">{next.name}</span>
                {secondsLeft !== null && <span className="tabular-nums text-muted"> · {secondsLeft === 0 ? 'now' : waitPhrase(secondsLeft * 1000, { now })}</span>}
              </p>
            )}
          </div>
          <p data-testid="reach-headline" className="mt-2 text-base font-medium"><span className="tabular-nums">{summary.headline}</span></p>
        </div>
        {finishClock !== null && !finished && (
          <p data-testid="live-finish" className="text-sm tabular-nums" suppressHydrationWarning>
            Finish around {finishClock}{lines !== null && lines.left !== null && <span className="text-muted"> · {lines.left}</span>}
          </p>
        )}
      </div>

      <div className="mt-3"><ReachBar reached={summary.reached} notYet={summary.notYet} total={progress.total} /></div>

      <ul aria-label="Counts" className="mt-3 flex flex-wrap gap-x-2 gap-y-1 text-sm">
        {summary.counts.map((c) => (
          <li key={c.key}>
            <Link
              href={showHref(id, activeShow === c.key ? '' : c.key)}
              aria-current={activeShow === c.key ? 'true' : undefined}
              className={`inline-flex min-h-11 items-center gap-1 rounded-lg px-2 ${activeShow === c.key ? 'font-semibold text-ink underline' : 'text-muted hover:text-ink'}`}
            >
              <span className="tabular-nums">{c.value}</span> {c.label}
            </Link>
          </li>
        ))}
      </ul>

      {lines !== null && lines.why !== null && (
        <div data-testid="campaign-eta" className="mt-2 border-t border-border pt-3 text-sm">
          <p data-testid="eta-headline" className="font-medium" suppressHydrationWarning>{lines.headline}.</p>
          <p className="mt-0.5 text-muted">{lines.why}</p>
          {lines.delay !== null && <p data-testid="eta-delay" className="mt-0.5 text-warning" suppressHydrationWarning>{lines.delay}</p>}
          {eta?.basis === 'time_only' && eta.finishAt !== null && (
            <p className="mt-0.5 text-xs text-muted">WhatsApp has not said how many new chats this number has left, so this counts time only.</p>
          )}
        </div>
      )}
    </section>
  );
}

/** A link to this campaign showing one group of people; empty shows everyone. */
function showHref(id: string, show: Show | ''): string {
  return `/broadcast/${id}${show === '' ? '' : `?show=${show}`}`;
}
