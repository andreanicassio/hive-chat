import { useLayoutEffect, useEffect, useRef, type ReactNode } from 'react';
import { Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import clsx from 'clsx';
import { Activity, ChevronLeft, Hexagon, MessageSquare, User } from 'lucide-react';
import { useStore } from '../store.js';
import { MobileChannels } from './Channels.js';
import { MobileChannel } from './Channel.js';
import { MobileWork } from './Work.js';
import { MobileThread } from './ThreadScreen.js';
import { MobileActivity } from './Activity.js';

/* ==========================================================================
   Guscio mobile.

   Sotto i 768px le due colonne non ci stanno: si impila e si naviga. E si
   naviga con ROTTE VERE, non con uno stato locale — il tasto indietro del
   sistema e il gesto di scorrimento devono funzionare, e una notifica di
   permesso deve poter aprire direttamente la schermata giusta.
   ======================================================================== */

/** Lo spazio che la barra di sistema si prende in cima. */
export const STATUS_BAR = 'pt-[max(env(safe-area-inset-top),20px)]';

/**
 * Intestazione di schermata: sta sul gradiente, non su un foglio.
 *
 * L'area di tocco del tasto indietro è 44px anche se l'icona è più piccola:
 * su un telefono è la misura sotto la quale si sbaglia bersaglio.
 */
export function MobileHeader({
  title,
  subtitle,
  onBack,
  right,
  large,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  onBack?: () => void;
  right?: ReactNode;
  large?: boolean;
}) {
  /*
   * L'intestazione è un OVERLAY, non un fratello nel flex.
   *
   * È la condizione perché il vetro sia vetro: se niente scorre dietro, un
   * pannello sfocato non ha nulla da sfocare e legge come nebbia. Lo spazio
   * lo recupera lo scroller col suo `padding-top`, che vale l'altezza vera
   * di questa barra — misurata, non scritta a mano: cambia col titolo grande,
   * col sottotitolo e con la tacca del telefono.
   */
  const ref = useRef<HTMLElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const apply = () =>
      document.documentElement.style.setProperty('--hdr-h', `${el.offsetHeight}px`);
    apply();
    const ro = new ResizeObserver(apply);
    ro.observe(el);
    return () => ro.disconnect();
  }, [title, subtitle, large]);

  return (
    <header
      ref={ref}
      className={clsx(
        'glass-chrome absolute inset-x-0 top-0 z-[5] px-3 pb-2.5',
        STATUS_BAR,
      )}
    >
      <div className="flex min-h-[44px] items-center gap-1">
        {onBack && (
          <button
            onClick={onBack}
            aria-label="Indietro"
            className="-ml-2 flex h-11 w-11 shrink-0 items-center justify-center text-[var(--color-honey)]"
          >
            <ChevronLeft size={24} strokeWidth={2.2} />
          </button>
        )}
        <div className="min-w-0 flex-1">
          <h1
            className={clsx(
              'truncate font-bold',
              large ? 'text-[26px] tracking-[-0.03em]' : 'text-[17px] tracking-[-0.02em]',
            )}
          >
            {title}
          </h1>
          {subtitle && (
            <p className="truncate text-[12px] text-[var(--color-ink-faint)]">{subtitle}</p>
          )}
        </div>
        {right}
      </div>
    </header>
  );
}

/** Le quattro voci in fondo. Non si vedono dentro una conversazione. */
function TabBar() {
  const navigate = useNavigate();
  const busy = useStore((s) => s.agentActivity.size > 0);
  // Dal router, non da `window.location`: quello non fa ri-rendere niente e la
  // voce attiva resterebbe indietro di una navigazione.
  const path = useLocation().pathname;

  const tabs = [
    { to: '/', icon: MessageSquare, label: 'Chat', match: (p: string) => p === '/' },
    { to: '/alveare', icon: Hexagon, label: 'Alveare', match: (p: string) => p === '/alveare' },
    { to: '/attivita', icon: Activity, label: 'Attività', match: (p: string) => p === '/attivita' },
    { to: '/tu', icon: User, label: 'Tu', match: (p: string) => p === '/tu' },
  ];

  /*
   * Una capsula che galleggia, non una barra appoggiata: niente bordo
   * superiore (galleggiare vuol dire non toccare niente) e sta sopra
   * l'indicatore di sistema, non sopra il contenuto — a lasciargli spazio è
   * il `padding-bottom` dello scroller.
   */
  return (
    <nav className="glass-capsule absolute inset-x-3 bottom-[calc(env(safe-area-inset-bottom)+8px)] z-[5] h-16 rounded-full">
      <div className="flex h-full">
        {tabs.map((t) => {
          const active = t.match(path);
          return (
            <button
              key={t.to}
              onClick={() => navigate(t.to)}
              className={clsx(
                'relative flex flex-1 flex-col items-center justify-center gap-0.5',
                active ? 'text-[var(--color-honey)]' : 'text-[var(--color-ink-faint)]',
              )}
            >
              <t.icon size={21} strokeWidth={2} />
              <span className={clsx('text-[10.5px]', active ? 'font-semibold' : 'font-normal')}>
                {t.label}
              </span>
              {t.label === 'Attività' && busy && (
                <span className="absolute top-1.5 right-[calc(50%-14px)] h-[7px] w-[7px] animate-pulse rounded-full bg-[var(--color-online)]" />
              )}
            </button>
          );
        })}
      </div>
    </nav>
  );
}

/** Schermata con la tab bar sotto. */
export function WithTabs({ children }: { children: ReactNode }) {
  // Radice `relative`: è l'ancora di header e capsula, che ora ci stanno
  // sopra invece che accanto.
  return (
    <div className="relative h-full min-h-0">
      {children}
      <TabBar />
    </div>
  );
}

export function MobileShell({
  onOpenAgents,
  onOpenSettings,
}: {
  onOpenAgents: () => void;
  onOpenSettings: () => void;
}) {
  return (
    <div className="flex h-full flex-col overflow-hidden">
      <Routes>
        <Route path="/" element={<MobileChannels />} />
        <Route path="/c/:channelId" element={<MobileChannel />} />
        <Route path="/c/:channelId/m/:messageId/lavoro" element={<MobileWork />} />
        <Route path="/c/:channelId/m/:messageId/thread" element={<MobileThread />} />
        <Route path="/attivita" element={<MobileActivity />} />
        <Route path="/alveare" element={<OpenSheet run={onOpenAgents} />} />
        <Route path="/tu" element={<OpenSheet run={onOpenSettings} />} />
        <Route path="*" element={<MobileChannels />} />
      </Routes>
    </div>
  );
}

/**
 * Alveare e Tu non hanno ancora una schermata propria: aprono i fogli che
 * esistono già.
 *
 * Non disegna niente. La prima versione mostrava una schermata vuota con un
 * bottone «Apri», che è un passaggio in più per non fare nulla: qui il foglio
 * sale subito e l'indirizzo torna all'elenco, così chiudendolo ci si ritrova
 * dove si era. La rotta resta perché un link deve poter portare qui.
 */
function OpenSheet({ run }: { run: () => void }) {
  const navigate = useNavigate();
  const opened = useRef(false);
  useEffect(() => {
    // Una volta sola: i gestori arrivano come funzioni nuove a ogni render del
    // guscio, e senza questo l'effetto ripartirebbe a ogni giro.
    if (opened.current) return;
    opened.current = true;
    run();
    navigate('/', { replace: true });
  }, [run, navigate]);
  return null;
}
