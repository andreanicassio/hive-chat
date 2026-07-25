import { useEffect, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { applyUpdate, updateReady, watchForUpdates } from '../lib/update.js';

/**
 * «C'è una versione nuova».
 *
 * Compare in basso, sopra tutto, e non si mette in mezzo: si può ignorare e
 * continuare a scrivere. Non c'è una X per chiuderlo — chiuderlo non
 * cambierebbe niente, la versione nuova resta lì in attesa — ma non torna
 * a farsi vedere dopo che si è ricaricato, perché a quel punto non c'è più.
 */
export function UpdateToast() {
  const [ready, setReady] = useState(updateReady);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    watchForUpdates(() => setReady(true));
  }, []);

  if (!ready) return null;

  return (
    <div
      role="status"
      className="animate-in-msg fixed inset-x-0 bottom-0 z-[120] flex justify-center px-3 pb-[max(env(safe-area-inset-bottom),12px)]"
    >
      <div className="pointer-events-auto flex max-w-[420px] items-center gap-3 rounded-[12px] border border-[var(--color-line)] bg-[var(--color-panel)] py-2.5 pr-2.5 pl-3.5 shadow-[var(--shadow-pop)]">
        <span className="min-w-0 text-[13.5px] text-[var(--color-ink-soft)]">
          C’è una versione nuova di Hive.
        </span>
        <button
          onClick={() => {
            setBusy(true);
            applyUpdate();
          }}
          disabled={busy}
          className="flex h-8 shrink-0 items-center gap-1.5 rounded-[9px] bg-[var(--color-ink)] px-3 text-[13px] font-semibold text-[var(--color-panel)] transition-opacity disabled:opacity-60"
        >
          <RefreshCw size={13} strokeWidth={2.4} className={busy ? 'animate-spin' : undefined} />
          {busy ? 'Ricarico…' : 'Ricarica'}
        </button>
      </div>
    </div>
  );
}
