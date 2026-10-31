'use client';

import { useEffect, useState } from 'react';

/**
 * The current time, ticking every second, for countdowns that move without a reload (F6 AC-10.5).
 *
 * `serverNowIso` is the server's clock when the page was rendered. The first render uses it, so the server's HTML and the browser's
 * first paint say the same thing; after that the browser's own clock drives the ticks, shifted by how far it differs from the
 * server's, so a countdown to a time the server stored is right even when this computer's clock is not.
 */
export function useNow(serverNowIso: string, everyMs = 1000): Date {
  const [now, setNow] = useState(() => new Date(serverNowIso));
  useEffect(() => {
    const skew = new Date(serverNowIso).getTime() - Date.now();
    const tick = (): void => { setNow(new Date(Date.now() + skew)); };
    const timer = setInterval(tick, everyMs);
    return () => { clearInterval(timer); };
  }, [serverNowIso, everyMs]);
  return now;
}
