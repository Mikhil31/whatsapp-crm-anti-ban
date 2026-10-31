'use client';

import { useState, useTransition } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { describeReason, type ReasonContext } from '@/lib/reasons';
import { liftDncAction, resumeSenderAction, retryMessageAction } from '@/app/visibility-actions';

/** What an action needs to know to act: the message, the number, the contact, the thread. Whatever is missing hides the button. */
export interface ReasonTarget {
  messageId?: string | null;
  senderId?: string | null;
  contactId?: string | null;
  conversationId?: string | null;
  /** True inside the thread itself, where "Send by hand" can focus the composer instead of opening the thread. */
  inThread?: boolean;
}

/** A reason code with what fills its sentence and what its action acts on. */
interface ReasonProps extends ReasonTarget {
  code: string | null;
  until?: string | null;
  detail?: string | null;
}

const ctxOf = (p: ReasonProps): ReasonContext => ({ until: p.until ?? null, detail: p.detail ?? null });

/**
 * The sentence for a reason code. The clock time in it is the viewer's own, so the server's render and the browser's can differ by
 * zone; the text is marked so React does not treat that as a mistake.
 */
export function ReasonSentence(p: ReasonProps) {
  const r = describeReason(p.code, ctxOf(p));
  return (
    <span data-testid="reason-sentence" data-code={r.code} suppressHydrationWarning>
      {r.sentence}
    </span>
  );
}

/**
 * The action beside a reason: Retry, Relink, Resume, Lift or Send by hand, each doing its real thing. Renders nothing when the
 * reason has no action, when the thing it needs (a message, a number, a contact) is not known, or when there is no way to do it yet
 * (Send now, for quiet hours, has no route behind it).
 */
export function ReasonButton(p: ReasonProps) {
  const r = describeReason(p.code, ctxOf(p));
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [asking, setAsking] = useState(false);

  const act = (run: () => Promise<{ ok: boolean; error?: string }>): void => {
    setError(null);
    start(async () => {
      const out = await run();
      if (!out.ok) setError(out.error ?? 'It did not work. Try again.');
      else router.refresh();
      setAsking(false);
    });
  };

  if (r.action === null || r.actionLabel === null) return null;
  const messageId = p.messageId ?? null;
  const senderId = p.senderId ?? null;
  const contactId = p.contactId ?? null;
  const conversationId = p.conversationId ?? null;
  const label = r.actionLabel;
  const btn = 'btn btn-sm disabled:opacity-60';
  const shown = (node: React.ReactNode): React.ReactNode => (
    <span className="inline-flex flex-wrap items-center gap-1.5">
      {node}
      {error !== null && <span role="alert" className="text-xs text-danger">{error}</span>}
    </span>
  );

  switch (r.action) {
    case 'retry':
      if (messageId === null) return null;
      return shown(
        <button type="button" className={btn} disabled={pending} data-action="retry"
          onClick={() => { act(() => retryMessageAction(messageId)); }}>
          {pending ? 'Retrying…' : label}
        </button>
      );
    case 'resume':
      if (senderId === null) return null;
      return shown(
        <button type="button" className={btn} disabled={pending} data-action="resume"
          onClick={() => { act(() => resumeSenderAction(senderId)); }}>
          {pending ? 'Resuming…' : label}
        </button>
      );
    case 'relink':
      return shown(
        <Link href={senderId !== null ? `/link?start=${encodeURIComponent(senderId)}` : '/link'} className={btn} data-action="relink">
          {label}
        </Link>
      );
    case 'lift':
      if (contactId === null) return null;
      return asking
        ? shown(
          <>
            <span className="text-xs">Allow messages to this contact again?</span>
            <button type="button" className={`${btn} btn-danger`} disabled={pending} data-action="lift-confirm"
              onClick={() => { act(() => liftDncAction(contactId)); }}>
              {pending ? 'Lifting…' : 'Yes, lift'}
            </button>
            <button type="button" className={btn} disabled={pending} onClick={() => { setAsking(false); }}>No</button>
          </>
        )
        : shown(
          <button type="button" className={btn} data-action="lift" onClick={() => { setAsking(true); }}>{label}</button>
        );
    case 'send_by_hand':
      if (p.inThread === true) {
        return shown(
          <button type="button" className={btn} data-action="send_by_hand"
            onClick={() => { document.querySelector<HTMLTextAreaElement>('textarea')?.focus(); }}>
            {label}
          </button>
        );
      }
      if (conversationId === null) return null;
      return shown(
        <Link href={`/inbox/${encodeURIComponent(conversationId)}`} className={btn} data-action="send_by_hand">{label}</Link>
      );
    case 'send_now':
      // There is no route that sends a message held for quiet hours early, so no button promises one.
      return null;
  }
}

/** A reason in one line: its sentence, then its action. */
export function ReasonLine(p: ReasonProps) {
  return (
    <span className="inline-flex flex-wrap items-center gap-x-2 gap-y-1">
      <ReasonSentence {...p} />
      <ReasonButton {...p} />
    </span>
  );
}
