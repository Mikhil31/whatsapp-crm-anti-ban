'use client';

import { useEffect, useId, useRef, useState } from 'react';
import { fillInsAction } from '../actions';
import { unknownFillInSentence } from '../gates';
import type { FillInReport } from '@/lib/crm';
import { suggestKey } from './fill-in-keys';

/** A `{{key}}` or `{{contact.key}}` in the text: the same shape the server fills in. */
const VARIABLE = /\{\{\s*(?:contact\.)?(\w+)\s*\}\}/gi;

const BUILT_IN = [
  { key: 'name', label: 'Name', sample: null, have: -1 },
  { key: 'first_name', label: 'First name', sample: null, have: -1 }
];

/** "12 Nov 2026 · 982 of 1,000 have it", or just the key when nothing is known about the audience yet. */
function describe(f: { sample: string | null; have: number }, total: number | null): string {
  const parts: string[] = [];
  if (f.sample !== null) parts.push(f.sample);
  if (total !== null && f.have >= 0) parts.push(`${f.have.toLocaleString('en-US')} of ${total.toLocaleString('en-US')} have it`);
  return parts.join(' · ');
}

/**
 * The message box (CW-7.6, CW-7.7): the textarea the form posts, with an Insert list for the chosen audience's fill-ins, chips for
 * `{{fill-ins}}` in the box, a red underline for a key that is not a column, and what to do for people who have no value for one.
 *
 * The textarea stays the real field and keeps the text as `{{key}}`; the chips are drawn behind it, so the other parts of the form
 * that fill the box (a saved template, the AI) keep working. The audience is read from the form's own selects.
 */
export function MessageBox() {
  const box = useRef<HTMLTextAreaElement>(null);
  const backdrop = useRef<HTMLDivElement>(null);
  const listId = useId();
  const [text, setText] = useState('');
  const [report, setReport] = useState<FillInReport | null>(null);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [choice, setChoice] = useState<'send' | 'skip' | 'fallback'>('send');
  const [fallback, setFallback] = useState('');
  const [audienceKey, setAudienceKey] = useState('');

  // The box is also filled by a saved template and by the AI without an input event, and the audience is chosen elsewhere in the
  // form, so both are read on a short timer.
  useEffect(() => {
    const read = (): void => {
      setText(box.current?.value ?? '');
      const pick = (n: string): string => document.querySelector<HTMLSelectElement>(`select[name="${n}"]`)?.value ?? '';
      setAudienceKey(JSON.stringify({ fromTagId: pick('fromTagId'), fromImportRunId: pick('fromImportRunId'), fromSegmentId: pick('fromSegmentId') }));
    };
    read();
    const timer = setInterval(read, 500);
    return () => { clearInterval(timer); };
  }, []);

  useEffect(() => {
    const a = JSON.parse(audienceKey === '' ? '{}' : audienceKey) as Record<string, string>;
    const chosen = Object.fromEntries(Object.entries(a).filter(([, v]) => v !== ''));
    if (Object.keys(chosen).length === 0) { setReport(null); return; }
    let live = true;
    void fillInsAction(chosen).then((r) => { if (live) setReport(r); });
    return () => { live = false; };
  }, [audienceKey]);

  const fields = report?.fields ?? BUILT_IN;
  const total = report?.total ?? null;
  const known = fields.map((f) => f.key);

  // What the text uses: each key once, with whether it is a column and how many people lack it.
  const used = [...new Set([...text.matchAll(VARIABLE)].map((m) => m[1]!.toLowerCase()))];
  const unknown = used.filter((k) => !known.includes(k));
  const blanks = report === null ? [] : used.flatMap((k) => {
    const f = report.fields.find((x) => x.key === k);
    return f !== undefined && f.have < report.total ? [{ f, missing: report.total - f.have }] : [];
  });

  /** Puts the fill-in at the cursor. If the person typed "{" to open the list, that brace is replaced. */
  function insert(key: string): void {
    const el = box.current;
    if (el === null) return;
    let start = el.selectionStart;
    if (start > 0 && el.value[start - 1] === '{') start -= 1;
    el.setRangeText(`{{${key}}}`, start, el.selectionEnd, 'end');
    el.dispatchEvent(new Event('input', { bubbles: true }));
    setText(el.value);
    setOpen(false);
    el.focus();
  }

  /** With the list open: arrows move, Enter picks, Esc closes (CW-7.6 AC4). */
  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>): void {
    if (!open) return;
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive((i) => (i + 1) % fields.length); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((i) => (i - 1 + fields.length) % fields.length); }
    else if (e.key === 'Enter') { e.preventDefault(); insert(fields[active]?.key ?? 'name'); }
    else if (e.key === 'Escape') { e.preventDefault(); setOpen(false); }
  }

  /** Typing "{" opens the same list as the Insert button. */
  function onKeyUp(e: React.KeyboardEvent<HTMLTextAreaElement>): void {
    if (e.key === '{') { setActive(0); setOpen(true); }
  }

  // The chips, drawn behind the textarea in the same font and wrapping so they sit under the typed text.
  const pieces: React.ReactNode[] = [];
  let last = 0;
  for (const m of text.matchAll(VARIABLE)) {
    const at = m.index;
    pieces.push(text.slice(last, at));
    const isUnknown = !known.includes(m[1]!.toLowerCase());
    pieces.push(
      <span
        key={at}
        className={isUnknown
          ? 'rounded-sm underline decoration-danger decoration-wavy underline-offset-2'
          : 'rounded-sm bg-accent/20 outline outline-1 outline-accent/40'}
      >
        {m[0]}
      </span>
    );
    last = at + m[0].length;
  }
  pieces.push(text.slice(last));

  const optionId = (i: number): string => `${listId}-${String(i)}`;

  return (
    <div>
      <div className="mb-1.5 flex items-center justify-between gap-2">
        <label htmlFor={`${listId}-box`} className="text-sm font-medium">Message</label>
        <button
          type="button" className="btn btn-sm" aria-haspopup="listbox" aria-expanded={open} aria-controls={listId}
          onClick={() => { setActive(0); setOpen((o) => !o); box.current?.focus(); }}
        >
          Insert
        </button>
      </div>

      <div className="relative">
        <div
          ref={backdrop} aria-hidden
          className="field pointer-events-none absolute inset-0 overflow-hidden whitespace-pre-wrap break-words text-transparent"
        >
          {pieces}
        </div>
        <textarea
          id={`${listId}-box`} ref={box} name="body" required maxLength={4096} rows={5}
          placeholder="What every recipient receives…" className="field relative w-full bg-transparent"
          role="combobox" aria-expanded={open} aria-controls={listId} aria-autocomplete="list" aria-haspopup="listbox"
          aria-activedescendant={open ? optionId(active) : undefined}
          onInput={(e) => { setText(e.currentTarget.value); }}
          onScroll={(e) => { if (backdrop.current) backdrop.current.scrollTop = e.currentTarget.scrollTop; }}
          onKeyDown={onKeyDown} onKeyUp={onKeyUp}
          onBlur={() => { setTimeout(() => { setOpen(false); }, 150); }}
        />
        {open && (
          <ul
            id={listId} role="listbox" aria-label="Fill-ins you can insert"
            className="absolute left-0 right-0 top-full z-10 mt-1 max-h-60 overflow-auto rounded-lg border border-border bg-surface p-1 shadow-lg"
          >
            {fields.map((f, i) => (
              <li
                key={f.key} id={optionId(i)} role="option" aria-selected={i === active}
                onMouseDown={(e) => { e.preventDefault(); insert(f.key); }}
                onMouseEnter={() => { setActive(i); }}
                className={`cursor-pointer rounded-md px-2 py-1.5 text-sm ${i === active ? 'bg-accent/15' : ''}`}
              >
                <span className="font-medium">{f.key}</span>
                {describe(f, total) !== '' && <span className="text-muted"> · {describe(f, total)}</span>}
              </li>
            ))}
          </ul>
        )}
      </div>

      <p className="mt-1.5 text-sm text-muted">
        Use <code>{'{{name}}'}</code> for the contact&apos;s name, and <code>{'{Hi|Hey|Hello}'}</code> to
        vary the wording — each recipient gets a slightly different message, which is safer than 500
        identical sends. Press <code>{'{'}</code> or Insert to pick a fill-in.
      </p>

      {unknown.map((k) => (
        <p key={k} role="status" data-testid="unknown-fill-in" className="mt-2 text-sm text-danger">
          {unknownFillInSentence(k, suggestKey(k, known))}
        </p>
      ))}

      <input type="hidden" name="blankFillInChoice" value={blanks.length > 0 ? choice : 'send'} />
      <input type="hidden" name="fillInFallback" value={blanks.length > 0 && choice === 'fallback' ? fallback : ''} />
      {blanks.length > 0 && (
        <fieldset className="mt-3 rounded-lg border border-border p-3" data-testid="blank-fill-ins">
          <legend className="px-1 text-sm font-medium">
            {blanks.map(({ f, missing }) => `${missing.toLocaleString('en-US')} ${missing === 1 ? 'person has' : 'people have'} no ${f.label.toLowerCase()}.`).join(' ')}
          </legend>
          <label className="flex items-center gap-2 py-1 text-sm">
            <input type="radio" name="blankChoice" checked={choice === 'skip'} onChange={() => { setChoice('skip'); }} />
            Skip them
          </label>
          <label className="flex items-center gap-2 py-1 text-sm">
            <input type="radio" name="blankChoice" checked={choice === 'fallback'} onChange={() => { setChoice('fallback'); }} />
            Use a fallback
            <input
              type="text" value={fallback} maxLength={200} placeholder="e.g. soon" aria-label="Fallback text"
              disabled={choice !== 'fallback'} onChange={(e) => { setFallback(e.target.value); }} className="field field-sm w-40"
            />
          </label>
          <label className="flex items-center gap-2 py-1 text-sm">
            <input type="radio" name="blankChoice" checked={choice === 'send'} onChange={() => { setChoice('send'); }} />
            Send anyway
          </label>
        </fieldset>
      )}
    </div>
  );
}
