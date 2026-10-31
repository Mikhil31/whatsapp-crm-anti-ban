'use client';

import { messageTimeline, type MessageFacts } from '@/lib/visibility';
import { ReasonLine, type ReasonTarget } from './reason-action';
import { useNow } from './use-now';

/**
 * Where one outbound message is on its way out (F6 AC-10.1): queued, waiting n s, typing, sent, delivered, read. A message that is
 * held or failed shows the reason in a sentence with the action beside it instead. The seconds count down on their own (AC-10.5);
 * the numbers behind it come from the page, which the thread re-reads every few seconds.
 */
export function MessageTimeline({ facts, target, serverNow, messageId }: {
  facts: MessageFacts; target: ReasonTarget; serverNow: string; messageId: string;
}) {
  const now = useNow(serverNow);
  const t = messageTimeline(facts, now);
  const finished = facts.status === 'sent' || facts.status === 'delivered' || facts.status === 'read';
  // Once sent, only the steps reached are worth the line; before that, the whole road shows where it is.
  const steps = finished ? t.steps.filter((s) => s.state !== 'todo') : t.steps;

  return (
    <div data-testid="message-timeline" data-outcome={t.outcome} className="mt-1.5 flex flex-col gap-1 text-[11px]">
      {t.outcome !== 'in_flight' && t.reason !== null && (
        <p data-testid="message-problem" className={t.outcome === 'failed' ? 'font-medium text-danger' : 'font-medium text-warning'}>
          <span aria-hidden>{t.outcome === 'failed' ? '✕ ' : '⏸ '}</span>
          <span className="sr-only">{t.outcome === 'failed' ? 'Failed: ' : 'Held: '}</span>
          <ReasonLine code={t.reason.code} until={t.reason.until} detail={t.reason.detail} {...target} messageId={messageId} inThread />
        </p>
      )}
      <ol aria-label="Message timeline" className="flex flex-wrap items-center gap-x-1 text-muted">
        {steps.map((s, i) => (
          <li key={s.key} data-testid={`step-${s.key}`} data-state={s.state} className="flex items-center gap-1">
            {i > 0 && <span aria-hidden>→</span>}
            <span
              className={s.state === 'current' ? 'font-semibold text-ink' : s.state === 'done' ? '' : 'opacity-50'}
              title={s.at === null ? undefined : new Date(s.at).toLocaleString()}
              suppressHydrationWarning
            >
              {s.state === 'done' ? '✓ ' : ''}{s.label}
            </span>
          </li>
        ))}
      </ol>
    </div>
  );
}
