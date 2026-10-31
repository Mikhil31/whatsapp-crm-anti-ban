'use client';

import { useState, useTransition } from 'react';
import type { AntiBanSettings } from '@/lib/crm';
import { saveSendingAction } from './actions';

/**
 * The org's sending rules (F6 S6, S7): whether a closing message goes when someone opts out, the contact details it quotes, why the
 * org messages people by default, and quiet hours. Saving shows the settings as the server stored them, including which contact
 * details the closing message is still without.
 */
export function SendingForm({ initial }: { initial: AntiBanSettings }) {
  const [saved, setSaved] = useState(initial);
  const [closing, setClosing] = useState(initial.closingMessageEnabled);
  const [phone, setPhone] = useState(initial.contactPhone ?? '');
  const [email, setEmail] = useState(initial.contactEmail ?? '');
  const [purpose, setPurpose] = useState(initial.defaultPurpose ?? '');
  const [quiet, setQuiet] = useState(initial.quietHours.enabled);
  const [start, setStart] = useState(initial.quietHours.start);
  const [end, setEnd] = useState(initial.quietHours.end);
  const [zone, setZone] = useState(initial.quietHours.timeZone);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [pending, startTransition] = useTransition();

  /** Sends the form to the server and shows the settings as stored. */
  function save(): void {
    setError(null);
    setDone(false);
    startTransition(async () => {
      const out = await saveSendingAction({
        closingMessageEnabled: closing, contactPhone: phone, contactEmail: email, defaultPurpose: purpose,
        quietHours: { enabled: quiet, start, end, timeZone: zone.trim() }
      });
      if (!out.ok || out.settings === undefined) { setError(out.error ?? 'Could not save. Try again.'); return; }
      setSaved(out.settings);
      setDone(true);
    });
  }

  const label = (text: string, hint?: string) => (
    <span>
      <span className="block text-sm font-medium">{text}</span>
      {hint !== undefined && <span className="block text-xs text-muted">{hint}</span>}
    </span>
  );

  return (
    <form onSubmit={(e) => { e.preventDefault(); save(); }} className="flex flex-col gap-5" aria-busy={pending}>
      <section className="card p-5" aria-labelledby="closing-h">
        <h2 id="closing-h" className="font-semibold">When someone opts out</h2>
        <p className="mb-3 text-sm text-muted">
          A person who writes STOP is never messaged again by campaigns or the AI. You can also send them one last message that says who
          you are, why you wrote, and how to reach you.
        </p>
        <label className="mb-3 flex items-start gap-2">
          <input type="checkbox" name="closingMessageEnabled" checked={closing} onChange={(e) => { setClosing(e.target.checked); }} className="mt-1" />
          {label('Send one closing message', 'They are put on do-not-contact either way.')}
        </label>
        {closing && saved.missing.length > 0 && (
          <p role="status" data-testid="missing-warning" className="mb-3 notice notice-warning">
            The closing message is missing your {saved.missing.map((m) => m === 'contactPhone' ? 'contact number' : 'contact email').join(' and ')}.
            That line is left out until you add it below.
          </p>
        )}
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="flex flex-col gap-1.5">
            {label('Contact number')}
            <input name="contactPhone" value={phone} onChange={(e) => { setPhone(e.target.value); }} maxLength={40} className="field" placeholder="+91 98765 43210" />
          </label>
          <label className="flex flex-col gap-1.5">
            {label('Contact email')}
            <input name="contactEmail" type="email" value={email} onChange={(e) => { setEmail(e.target.value); }} maxLength={200} className="field" placeholder="hr@example.com" />
          </label>
        </div>
        <label className="mt-3 flex flex-col gap-1.5">
          {label('Why you message people', 'Used when a campaign does not say its own purpose.')}
          <textarea name="defaultPurpose" value={purpose} onChange={(e) => { setPurpose(e.target.value); }} maxLength={300} rows={2} className="field"
            placeholder="you applied for a job with us" />
        </label>
      </section>

      <section className="card p-5" aria-labelledby="quiet-h">
        <h2 id="quiet-h" className="font-semibold">Quiet hours</h2>
        <p className="mb-3 text-sm text-muted">
          Campaign and AI first messages wait while it is quiet. Replies and messages an agent types still go.
        </p>
        <label className="mb-3 flex items-start gap-2">
          <input type="checkbox" name="quietEnabled" checked={quiet} onChange={(e) => { setQuiet(e.target.checked); }} className="mt-1" />
          {label('Keep quiet hours')}
        </label>
        <div className="grid gap-3 sm:grid-cols-3">
          <label className="flex flex-col gap-1.5">
            {label('From')}
            <input name="quietStart" type="time" value={start} onChange={(e) => { setStart(e.target.value); }} disabled={!quiet} className="field" />
          </label>
          <label className="flex flex-col gap-1.5">
            {label('Until')}
            <input name="quietEnd" type="time" value={end} onChange={(e) => { setEnd(e.target.value); }} disabled={!quiet} className="field" />
          </label>
          <label className="flex flex-col gap-1.5">
            {label('Time zone', 'For example Asia/Kolkata')}
            <input name="quietZone" value={zone} onChange={(e) => { setZone(e.target.value); }} disabled={!quiet} maxLength={64} className="field" />
          </label>
        </div>
      </section>

      {error !== null && <p role="alert" className="notice notice-danger">{error}</p>}
      {done && <p role="status" data-testid="saved" className="notice notice-success">Saved.</p>}
      <div>
        <button type="submit" disabled={pending} className="btn btn-primary disabled:opacity-60">{pending ? 'Saving…' : 'Save'}</button>
      </div>
    </form>
  );
}
