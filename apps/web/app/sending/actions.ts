'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { saveAntiBanSettings, CrmApiError, NotAuthenticatedError } from '@/lib/crm';
import type { AntiBanSettings } from '@/lib/crm';

/** What the form gets back: the settings as saved, or a plain reason they were not. */
export interface SendingResult { ok: boolean; error?: string; settings?: AntiBanSettings }

/** The fields of the form, as typed. Empty text clears a contact detail. */
export interface SendingInput {
  closingMessageEnabled: boolean;
  contactPhone: string;
  contactEmail: string;
  defaultPurpose: string;
  quietHours: { enabled: boolean; start: string; end: string; timeZone: string };
}

/** Saves the org's sending settings (admin only; the API refuses anyone else). */
export async function saveSendingAction(input: SendingInput): Promise<SendingResult> {
  try {
    const settings = await saveAntiBanSettings({
      closingMessageEnabled: input.closingMessageEnabled,
      contactPhone: input.contactPhone.trim() === '' ? null : input.contactPhone.trim(),
      contactEmail: input.contactEmail.trim() === '' ? null : input.contactEmail.trim(),
      defaultPurpose: input.defaultPurpose.trim() === '' ? null : input.defaultPurpose.trim(),
      quietHours: input.quietHours
    });
    revalidatePath('/sending');
    return { ok: true, settings };
  } catch (error) {
    if (error instanceof NotAuthenticatedError) redirect('/login?next=/sending');
    if (error instanceof CrmApiError) return { ok: false, error: error.message };
    throw error;
  }
}
