'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { retryMessage, resumeSender, setDoNotContact, CrmApiError, NotAuthenticatedError } from '@/lib/crm';

/** What a reason's action button gets back: done, or the reason it was not, in words. */
export interface ReasonActionResult { ok: boolean; error?: string }

/** Runs one action on behalf of a person's click; a lapsed session goes to /login, a refusal comes back as a sentence. */
async function run(fn: () => Promise<unknown>): Promise<ReasonActionResult> {
  try {
    await fn();
  } catch (error) {
    if (error instanceof NotAuthenticatedError) redirect('/login');
    if (error instanceof CrmApiError) return { ok: false, error: error.message };
    throw error;
  }
  revalidatePath('/inbox', 'layout');
  revalidatePath('/broadcast', 'layout');
  revalidatePath('/link');
  return { ok: true };
}

/** Retry on a failed or refused message. Called only from the button: nothing in the app retries by itself. */
export async function retryMessageAction(messageId: string): Promise<ReasonActionResult> {
  return run(() => retryMessage(messageId));
}

/** Resume on a number held because many messages were not reaching people. */
export async function resumeSenderAction(senderId: string): Promise<ReasonActionResult> {
  return run(() => resumeSender(senderId));
}

/** Lift on a contact who asked not to be messaged. The button asks twice before calling this. */
export async function liftDncAction(contactId: string): Promise<ReasonActionResult> {
  return run(() => setDoNotContact(contactId, false));
}
