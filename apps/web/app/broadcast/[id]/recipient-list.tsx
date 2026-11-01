'use client';

import { useNow } from '@/components/use-now';
import { initialsOf } from '../../ui';
import { ReasonButton, ReasonSentence } from '@/components/reason-action';
import type { CampaignRecipient } from '@/lib/crm';
import { rowStatus, type StatusWord } from '@/lib/recipient-status';

/** The colours of a status word. Colour only ever means status (CW-9.2). */
const WORD_CLASS: Record<StatusWord, string> = {
  Waiting: 'text-muted border-border',
  Sending: 'text-accent border-transparent bg-accent-soft',
  Sent: 'text-success border-transparent bg-success-soft',
  Delivered: 'text-success border-transparent bg-success-soft',
  Read: 'text-success border-transparent bg-success-soft',
  'Not yet': 'text-warning border-warning/40 bg-warning-soft'
};

/** Three dots that bounce one after another while a message is being typed. Still when the viewer wants less motion. */
function TypingDots() {
  return (
    <span aria-hidden data-testid="typing-dots" className="ml-1 inline-flex items-end gap-0.5">
      {[0, 150, 300].map((delay) => (
        <span
          key={delay} className="size-1 rounded-full bg-bright motion-safe:animate-bounce"
          style={{ animationDelay: `${String(delay)}ms` }}
        />
      ))}
    </span>
  );
}

/** The latest message in the chat, one line, in grey: "You: …" for ours, "<first name>: …" for theirs (CW-2.7). */
function LastMessage({ r }: { r: CampaignRecipient }) {
  const m = r.lastMessage ?? null;
  if (m === null || m.text === '') return null;
  const first = (r.displayName ?? '').trim().split(/\s+/)[0];
  const who = m.from === 'us' ? 'You' : first !== undefined && first !== '' ? first : 'They';
  return <p data-testid="last-message" className="truncate text-xs text-muted">{who}: {m.text}</p>;
}

/**
 * Every recipient of this page, in send order (CW-2.2): who, the latest message in their chat, where they are in words, and, for
 * someone who has not been reached, why and what can be done. The row at the head of the queue is highlighted and counts down.
 */
export function RecipientList({ recipients, serverNow, headId, headDueAt, around }: {
  recipients: CampaignRecipient[];
  serverNow: string;
  /** The recipient being sent next, and when. Null when nothing is queued. */
  headId: string | null;
  headDueAt: string | null;
  /** Guessed send times for the waiting rows after it, by recipient id. */
  around: Record<string, string>;
}) {
  const now = useNow(serverNow);
  return (
    <div className="card overflow-x-auto">
      <table data-testid="recipient-table" className="w-full text-left text-sm">
        <thead className="text-xs text-muted">
          <tr>
            <th scope="col" className="px-4 py-2 font-medium">Contact</th>
            <th scope="col" className="px-3 py-2 font-medium">Where they are</th>
            <th scope="col" className="px-3 py-2 font-medium">Why</th>
            <th scope="col" className="px-3 py-2 font-medium">What you can do</th>
          </tr>
        </thead>
        <tbody>
          {recipients.map((r) => {
            const isHead = r.id === headId;
            const s = rowStatus(
              {
                status: r.status, messageStatus: r.messageStatus, holdReason: r.holdReason ?? null, holdUntil: r.holdUntil ?? null,
                sentAt: r.sentAt ?? null, deliveredAt: r.deliveredAt ?? null, readAt: r.readAt ?? null
              },
              {
                now, dueAt: isHead && headDueAt !== null ? new Date(headDueAt) : null,
                around: around[r.id] === undefined ? null : new Date(around[r.id]!)
              }
            );
            const target = {
              messageId: r.messageId ?? null, senderId: r.senderIdentityId ?? null, contactId: r.contactId ?? null,
              conversationId: r.conversationId ?? null
            };
            // The "Why" column is for people who were not reached and people whose message is held; the rest have nothing to explain.
            const code = s.word === 'Not yet' || (r.holdReason ?? null) !== null ? r.reason ?? null : null;
            return (
              <tr
                key={r.id} data-testid="recipient-row" data-status={r.status} data-word={s.word} data-reason={r.reason ?? ''}
                className={`border-t border-border align-top ${s.word === 'Sending' ? 'bg-accent-soft' : ''}`}
              >
                <td className="px-4 py-3">
                  <div className="flex min-w-0 items-center gap-3">
                    <span className="avatar size-9 text-sm" aria-hidden>{initialsOf(r.displayName ?? r.identity ?? '?')}</span>
                    <div className="min-w-0">
                      <p className="truncate font-medium">{r.displayName ?? r.identity ?? 'Unnamed contact'}</p>
                      <LastMessage r={r} />
                      <p className="truncate text-xs text-muted">{r.identity ?? 'no contact details'}</p>
                    </div>
                  </div>
                </td>
                <td className="whitespace-nowrap px-3 py-3" suppressHydrationWarning>
                  <span className={`badge ${WORD_CLASS[s.word]}`}>{s.word}</span>
                  {s.detail !== null && <span className="ml-2 tabular-nums text-muted">{s.detail}</span>}
                  {s.typing && <TypingDots />}
                </td>
                <td className="px-3 py-3">
                  {code === null ? <span className="text-muted">—</span>
                    : <ReasonSentence code={code} until={r.holdUntil ?? null} detail={r.errorDetail ?? null} {...target} />}
                </td>
                <td className="px-3 py-3">
                  {code !== null && <ReasonButton code={code} until={r.holdUntil ?? null} detail={r.errorDetail ?? null} {...target} />}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
