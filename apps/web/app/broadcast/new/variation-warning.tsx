'use client';

import { useEffect, useState } from 'react';
import { hasVariation } from '@/lib/visibility';

/**
 * A warning under the message box when the text is the same for everyone (F6 AC-7.2): 500 identical messages is one of the clearest
 * signs of a bulk sender. It never stops the campaign. The box is filled by other parts of the form without an input event (a saved
 * template, the AI), so the text is also read on a short timer.
 */
export function VariationWarning() {
  const [text, setText] = useState('');
  useEffect(() => {
    const read = (): void => { setText(document.querySelector<HTMLTextAreaElement>('textarea[name="body"]')?.value ?? ''); };
    read();
    const timer = setInterval(read, 500);
    return () => { clearInterval(timer); };
  }, []);
  if (text.trim() === '' || hasVariation(text)) return null;
  return (
    <p role="status" data-testid="warning-no_variation" className="mt-3 notice notice-warning">
      Every recipient will get exactly the same text. Add variants like <code>{'{Hi|Hello|Hey}'}</code>, or let the AI write it, to look less
      like a bulk send. You can still create the campaign.
    </p>
  );
}
