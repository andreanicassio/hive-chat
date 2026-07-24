import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Bot, Terminal, MessagesSquare, Check, Copy, ArrowRight, Apple } from 'lucide-react';

const INSTALL_CMD = 'curl -fsSL https://hive.dvnx.net/install-mac | bash';

/**
 * Landing pubblica di Hive: quello che vede chi arriva su hive.dvnx.net senza
 * essere loggato. Racconta cos'è, come si installa l'app per Mac, e dà i due
 * ingressi (accedi / registrati con invito).
 */
export function Landing() {
  const navigate = useNavigate();
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(INSTALL_CMD);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      /* niente clipboard: pazienza */
    }
  };

  return (
    <div className="min-h-full overflow-y-auto">
      {/* --- barra --- */}
      <header className="mx-auto flex max-w-5xl items-center justify-between px-6 py-5">
        <div className="flex items-center gap-2">
          <span className="text-2xl">🐝</span>
          <span className="text-[18px] font-semibold tracking-[-0.02em]">Hive</span>
        </div>
        <button
          onClick={() => navigate('/accedi')}
          className="rounded-full bg-[var(--color-panel)] px-4 py-1.5 text-[14px] font-medium shadow-[var(--shadow-panel)] transition-transform hover:-translate-y-px"
        >
          Accedi
        </button>
      </header>

      {/* --- hero --- */}
      <section className="mx-auto max-w-3xl px-6 pt-12 pb-10 text-center sm:pt-20">
        <div className="mb-5 inline-flex items-center gap-2 rounded-full bg-[var(--color-panel)] px-3 py-1 text-[12.5px] text-[var(--color-ink-soft)] shadow-[var(--shadow-panel)]">
          <span className="h-1.5 w-1.5 rounded-full bg-[var(--color-online)]" /> Chat di squadra con
          agenti AI
        </div>
        <h1 className="text-[40px] leading-[1.05] font-semibold tracking-[-0.03em] sm:text-[56px]">
          Dove gli agenti AI
          <br />
          lavorano <span className="text-[var(--color-honey)]">con la squadra</span>
        </h1>
        <p className="mx-auto mt-5 max-w-xl text-[16px] leading-relaxed text-[var(--color-ink-soft)] sm:text-[18px]">
          Hive è una chat come Slack, ma gli agenti sono membri veri: rispondono nei canali,
          leggono il contesto, e — se glielo permetti — lavorano sul tuo codice live, dal tuo
          computer, mentre tu chatti.
        </p>
        <div className="mt-8 flex flex-col items-center justify-center gap-3 sm:flex-row">
          <button
            onClick={() => navigate('/accedi')}
            className="btn btn-primary flex items-center gap-2 px-5 py-2.5 text-[15px]"
          >
            Apri Hive <ArrowRight size={16} strokeWidth={2.4} />
          </button>
          <a
            href="#installa"
            className="flex items-center gap-2 rounded-full bg-[var(--color-panel)] px-5 py-2.5 text-[15px] font-medium shadow-[var(--shadow-panel)] transition-transform hover:-translate-y-px"
          >
            <Apple size={16} strokeWidth={2.2} /> Scarica per Mac
          </a>
        </div>
      </section>

      {/* --- tre valori --- */}
      <section className="mx-auto grid max-w-4xl gap-4 px-6 py-8 sm:grid-cols-3">
        {[
          {
            icon: <Bot size={20} strokeWidth={2} />,
            title: 'Agenti come membri',
            body: 'Li tagghi con @, scegli i loro strumenti e il modello. Rispondono in chat come colleghi.',
          },
          {
            icon: <Terminal size={20} strokeWidth={2} />,
            title: 'Sul tuo codice, live',
            body: 'Un agente sviluppatore lavora sul repo che hai già sul disco, dalla chat. Niente giro da GitHub.',
          },
          {
            icon: <MessagesSquare size={20} strokeWidth={2} />,
            title: 'Tutto in un posto',
            body: 'Canali, memoria condivisa, checklist e documenti accanto alla conversazione.',
          },
        ].map((f) => (
          <div
            key={f.title}
            className="rounded-2xl bg-[var(--color-panel)] p-5 shadow-[var(--shadow-panel)]"
          >
            <div className="mb-3 flex h-10 w-10 items-center justify-center rounded-xl bg-[var(--color-honey-soft)] text-[var(--color-honey)]">
              {f.icon}
            </div>
            <h3 className="text-[15px] font-semibold">{f.title}</h3>
            <p className="mt-1 text-[13.5px] leading-relaxed text-[var(--color-ink-soft)]">
              {f.body}
            </p>
          </div>
        ))}
      </section>

      {/* --- installazione --- */}
      <section id="installa" className="mx-auto max-w-3xl scroll-mt-8 px-6 py-10">
        <div className="rounded-2xl bg-[var(--color-panel)] p-6 shadow-[var(--shadow-panel)] sm:p-8">
          <h2 className="text-[22px] font-semibold tracking-[-0.02em]">Installa l'app per Mac</h2>
          <p className="mt-1.5 text-[14px] text-[var(--color-ink-soft)]">
            Un solo comando. Apri il <strong>Terminale</strong> (Applicazioni → Utility) e incolla:
          </p>

          <div className="mt-4 flex items-center gap-2 rounded-xl bg-[var(--color-ink)] px-4 py-3">
            <code className="flex-1 overflow-x-auto font-mono text-[13px] whitespace-nowrap text-[#f0ece1]">
              {INSTALL_CMD}
            </code>
            <button
              onClick={copy}
              className="flex shrink-0 items-center gap-1.5 rounded-lg bg-white/10 px-2.5 py-1.5 text-[12.5px] font-medium text-white transition-colors hover:bg-white/20"
            >
              {copied ? (
                <>
                  <Check size={13} strokeWidth={2.6} /> Copiato
                </>
              ) : (
                <>
                  <Copy size={13} strokeWidth={2.2} /> Copia
                </>
              )}
            </button>
          </div>

          <ol className="mt-5 space-y-2 text-[13.5px] text-[var(--color-ink-soft)]">
            <li>
              <strong className="text-[var(--color-ink)]">1.</strong> Il comando scarica e installa
              Hive in Applicazioni — nessun avviso "app danneggiata".
            </li>
            <li>
              <strong className="text-[var(--color-ink)]">2.</strong> Si apre da sola: metti{' '}
              <code className="rounded bg-[var(--color-sunken)] px-1 py-0.5 text-[12px]">
                https://hive.dvnx.net
              </code>{' '}
              come server e sei dentro.
            </li>
            <li>
              <strong className="text-[var(--color-ink)]">3.</strong> Aggiornamenti automatici: non
              devi reinstallare a ogni versione.
            </li>
          </ol>

          <div className="mt-6 border-t border-[var(--color-line)] pt-5">
            <p className="text-[13.5px] text-[var(--color-ink-soft)]">
              Preferisci restare nel browser?{' '}
              <button
                onClick={() => navigate('/accedi')}
                className="font-medium text-[var(--color-terracotta)] underline underline-offset-2"
              >
                Apri Hive qui →
              </button>
            </p>
          </div>
        </div>
      </section>

      <footer className="mx-auto max-w-5xl px-6 py-10 text-center text-[12.5px] text-[var(--color-ink-faint)]">
        🐝 Hive — hive.dvnx.net · Accesso su invito
      </footer>
    </div>
  );
}
