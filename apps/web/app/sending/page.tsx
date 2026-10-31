import { redirect } from 'next/navigation';
import { getAntiBanSettings, getMe, CrmApiError, NotAuthenticatedError } from '@/lib/crm';
import type { AntiBanSettings } from '@/lib/crm';
import { PageHeader } from '../ui';
import { SendingForm } from './sending-form';

/** Rendered per request: the form shows what is stored now. */
export const dynamic = 'force-dynamic';

/**
 * Sending rules: the closing message when someone opts out, the contact details it quotes, why the org messages people, and quiet
 * hours (F6 S6, S7). Admin only; the API refuses anyone else, so hiding the tab is a convenience and not the protection.
 */
export default async function SendingPage() {
  let settings: AntiBanSettings | null = null;
  let isAdmin = false;
  let failure: string | null = null;
  let expired = false;
  try {
    isAdmin = (await getMe()).role === 'admin';
    if (isAdmin) settings = await getAntiBanSettings();
  } catch (error) {
    if (error instanceof NotAuthenticatedError) expired = true;
    failure = error instanceof CrmApiError ? error.message : 'Could not reach the API.';
  }
  if (expired) redirect('/login?next=/sending');

  return (
    <main className="page page-narrow">
      <PageHeader title="Sending rules" description="What happens when someone opts out, and when campaigns stay quiet." />
      {failure !== null && <p className="notice notice-danger">{failure}</p>}
      {failure === null && !isAdmin && (
        <p className="notice notice-warning">Only admins can change the sending rules. Ask an admin if you need a change.</p>
      )}
      {failure === null && settings !== null && <SendingForm initial={settings} />}
    </main>
  );
}
