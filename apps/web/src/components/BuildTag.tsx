import { useEffect, useState } from 'react';
import clsx from 'clsx';
import { RefreshCw } from 'lucide-react';
import { shellError } from '../App.js';
import {
  applyUpdate,
  onVersionChange,
  publishedSha,
  runningSha,
  updateReady,
} from '../lib/update.js';

/**
 * Che versione di Hive stai eseguendo, adesso.
 *
 * La sigla è il commit da cui esce questo bundle: la stessa che compare nei
 * messaggi in chat quando qualcosa viene pubblicato. Guardarla è l'unico modo
 * per rispondere con certezza a «ma sto vedendo la versione nuova?» — dedurlo
 * da quali funzioni si vedono e quali no è già costato due ore.
 *
 * Quando sul server ce n'è una più recente la riga cambia colore e diventa il
 * bottone per prenderla: la stessa cosa che fa l'avviso in basso, ma sempre
 * visibile invece che una volta sola.
 */
export function BuildTag({ className }: { className?: string }) {
  const [, bump] = useState(0);

  useEffect(() => {
    // Il poll di `version.json` vive in lib/update: qui ci si limita a
    // ridisegnare quando ha qualcosa di nuovo da dire.
    const off = onVersionChange(() => bump((n) => n + 1));
    const timer = setInterval(() => bump((n) => n + 1), 5_000);
    return () => {
      off();
      clearInterval(timer);
    };
  }, []);

  const running = runningSha();
  // Nell'app Mac il guscio è un binario a parte: si aggiorna solo
  // reinstallandolo, quindi la sua versione va detta accanto a quella del
  // frontend, non dedotta da essa.
  let shell: string | null = null;
  try {
    shell = localStorage.getItem('hive:shellVersion');
  } catch {
    shell = null;
  }
  const latest = publishedSha();
  const behind = Boolean(latest && latest !== running);
  const ready = updateReady();

  if (behind || ready) {
    return (
      <button
        onClick={() => applyUpdate()}
        title={`You're running ${running}${latest ? `, published ${latest}` : ''}`}
        className={clsx(
          'flex w-full items-center gap-1.5 rounded-[7px] px-1.5 py-1 text-left text-[11px] font-medium text-[var(--color-honey)] transition-colors hover:bg-[color-mix(in_oklab,var(--color-honey)_10%,transparent)]',
          className,
        )}
      >
        <RefreshCw size={11} strokeWidth={2.6} className="shrink-0" />
        <span className="truncate">New version — reload</span>
      </button>
    );
  }

  return (
    <div
      title={`Build ${running} · ${__BUILD_TIME__}`}
      className={clsx(
        'px-1.5 py-1 text-[11px] tracking-[0.02em] text-[var(--color-ink-faint)] tabular-nums select-text',
        className,
      )}
    >
      Hive · {running}
      {shell ? ` · app ${shell}` : ''}
      {/* Serve a vedere a colpo d'occhio se la finestra ci lascia disegnare
          in cima: se manca, la striscia per trascinare non esiste. */}
      {document.documentElement.dataset.shell === 'tauri' && !shell ? ' · app ?' : ''}
      {shellError && (
        <span className="text-[var(--color-error)]" title={shellError}>
          {' '}
          · guscio ✗
        </span>
      )}
    </div>
  );
}
