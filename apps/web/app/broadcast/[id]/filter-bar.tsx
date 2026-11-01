import { SHOW_OPTIONS, REASON_SHOW_PREFIX } from '@/lib/recipient-status';
import { reasonLabel } from '@/lib/reasons';
import type { RecipientPage } from '@/lib/crm';

/**
 * One search box and one "Show" menu (CW-2.4): Everyone, Waiting, Reached, Not yet, then the reasons people were not reached, in
 * words with how many ("WhatsApp refused 4"), never as codes. A plain form, so it works without scripts.
 */
export function FilterBar({ id, show, reason, query, reasons }: {
  id: string;
  /** The group chosen: a `Show` value, or empty for everyone. */
  show: string;
  reason: string;
  query: string;
  reasons: RecipientPage['reasons'];
}) {
  // A reason in the address that this campaign does not have still shows, so it can be cleared.
  const list = reason !== '' && !reasons.some((r) => r.reason === reason) ? [{ reason, count: 0 }, ...reasons] : reasons;
  const current = reason !== '' ? `${REASON_SHOW_PREFIX}${reason}` : show;
  return (
    <form data-testid="filter-bar" className="mb-4 flex flex-wrap items-end gap-2" action={`/broadcast/${id}`}>
      <label className="min-w-48 flex-1">
        <span className="mb-1 block text-xs text-muted">Search</span>
        <input name="q" defaultValue={query} placeholder="Name or number" className="field w-full min-h-11" />
      </label>
      <label>
        <span className="mb-1 block text-xs text-muted">Show</span>
        <select name="show" defaultValue={current} className="field min-h-11">
          {SHOW_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          {list.length > 0 && (
            <optgroup label="Why not yet">
              {list.map((r) => (
                <option key={r.reason} value={`${REASON_SHOW_PREFIX}${r.reason}`}>{reasonLabel(r.reason)} {r.count}</option>
              ))}
            </optgroup>
          )}
        </select>
      </label>
      <button type="submit" className="btn min-h-11">Apply</button>
    </form>
  );
}
