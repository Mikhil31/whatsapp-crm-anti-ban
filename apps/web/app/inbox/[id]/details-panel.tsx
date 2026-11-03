'use client';

import Link from 'next/link';
import { useEffect, useRef } from 'react';
import { initials } from '@/lib/inbox-format';
import type { OrgUser } from '@/lib/crm';
import type { ChatPerson } from '@/lib/inbox';

/**
 * Details: the slide-over about the person and the chat. Who has the chat (the AI assistant, a person or nobody), Resolve and Reopen, the
 * number the chat is on, and the campaigns that messaged them. It is closed until asked for, at every width.
 */
export function DetailsPanel(props: {
  open: boolean;
  onClose: () => void;
  title: string;
  phone: string | null;
  senderLabel: string | null;
  /** Whether the chat's number can send right now; null when unknown. */
  linked: boolean | null;
  person: ChatPerson | null;
  users: OrgUser[];
  assigneeUserId: string | null;
  isAi: boolean;
  status: string;
  busy: boolean;
  onOwner: (userId: string) => void;
  onStatus: () => void;
}) {
  const bot = props.users.find((u) => u.isBot) ?? null;
  const people = props.users.filter((u) => !u.isBot);
  const campaigns = props.person?.campaigns ?? [];
  const closeBtn = useRef<HTMLButtonElement>(null);
  // The slide-over is not modal, but opening it moves the keyboard to it so Close is the first stop.
  useEffect(() => {
    if (!props.open) return;
    // The panel is still `visibility: hidden` for the first instant of its slide, and a hidden control cannot take focus.
    const t = setTimeout(() => { closeBtn.current?.focus(); }, 60);
    return () => { clearTimeout(t); };
  }, [props.open]);

  return (
    <aside className={`ib-info${props.open ? ' ib-open' : ''}`} aria-label="About this person" aria-hidden={!props.open}>
      <button ref={closeBtn} className="ib-btn ib-g ib-sm ib-close" type="button" onClick={props.onClose}>Close</button>
      <div className="ib-who">
        <span className="ib-av" aria-hidden="true">{initials(props.title)}</span>
        <b style={{ fontSize: 16 }}>{props.title}</b>
        <span className="ib-small">{props.phone ?? 'No number shared'}</span>
        {props.senderLabel !== null && (
          <span className="ib-small">
            via {props.senderLabel}
            {props.linked !== null && <> · <span className={`ib-st ${props.linked ? 'ib-ok' : 'ib-bd'}`}><i />{props.linked ? 'Linked' : 'Not linked'}</span></>}
          </span>
        )}
      </div>

      <div>
        <h2>Who has this chat</h2>
        <select className="ib-select" aria-label="Who has this chat" value={props.assigneeUserId ?? ''} disabled={props.busy}
          onChange={(e) => { props.onOwner(e.target.value); }}>
          {bot !== null && <option value={bot.id}>AI assistant</option>}
          {people.map((u) => <option key={u.id} value={u.id}>{u.displayName}</option>)}
          <option value="">Unassigned</option>
        </select>
        <p className="ib-small" style={{ marginTop: 4 }}>{props.isAi ? 'The AI assistant answers replies here, using the campaign’s instructions.' : 'Only your team answers here.'}</p>
      </div>

      <div>
        <h2>Status</h2>
        <button className="ib-btn" type="button" style={{ width: '100%' }} disabled={props.busy} onClick={props.onStatus}>
          {props.status === 'open' ? 'Resolve this chat' : 'Reopen this chat'}
        </button>
        <p className="ib-small" style={{ marginTop: 4 }}>
          {props.status === 'open' ? 'It moves to Closed. If they write again, it opens again by itself.' : 'It moves back to Open.'}
        </p>
      </div>

      <div>
        <h2>Campaigns</h2>
        {campaigns.length === 0 && <p className="ib-small">No campaign has messaged them in this chat.</p>}
        {campaigns.map((c) => (
          <div key={c.id} className="ib-crow">
            <b style={{ fontWeight: 500 }}>{c.name}</b>
            <span className="ib-small">{props.senderLabel !== null ? `${props.senderLabel} · ` : ''}{c.replied ? 'Replied' : 'Sent'}</span>
          </div>
        ))}
      </div>

      <Link className="ib-btn" href={`/contacts?q=${encodeURIComponent(props.phone ?? props.title)}`}>Open in Contacts</Link>
    </aside>
  );
}
