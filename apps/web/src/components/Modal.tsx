import { useEffect, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';

/**
 * Modale condiviso di Hive.
 *
 * Un solo posto per il comportamento che ci si aspetta da un pop-up:
 * si chiude con Esc o cliccando fuori, blocca lo scroll dietro, restituisce
 * il focus a chi l'ha aperto e si impila correttamente se ne apri un altro
 * sopra. Così ogni pannello ha lo stesso aspetto e le stesse scorciatoie.
 */

/** Stack dei modali aperti: solo quello in cima reagisce a Esc / click fuori. */
const stack: string[] = [];
let seq = 0;

const SIZES = {
  sm: 'max-w-[420px]',
  md: 'max-w-[560px]',
  lg: 'max-w-[680px]',
  xl: 'max-w-[900px]',
} as const;

export interface ModalProps {
  onClose: () => void;
  /** Titolo in intestazione. Ometti per un modale senza header. */
  title?: ReactNode;
  subtitle?: ReactNode;
  /** Elemento a sinistra del titolo (avatar, icona). */
  icon?: ReactNode;
  /** Azioni a destra, prima della X. */
  headerRight?: ReactNode;
  /** Barra fissa in fondo. */
  footer?: ReactNode;
  size?: keyof typeof SIZES;
  /** Altezza fissa: utile per liste lunghe che scorrono dentro. */
  tall?: boolean;
  /** Disattiva la chiusura cliccando sullo sfondo (es. form con dati non salvati). */
  dismissable?: boolean;
  children: ReactNode;
  /** Rimuove il padding dal corpo, per liste a tutta larghezza. */
  flush?: boolean;
}

export function Modal({
  onClose,
  title,
  subtitle,
  icon,
  headerRight,
  footer,
  size = 'md',
  tall = false,
  dismissable = true,
  flush = false,
  children,
}: ModalProps) {
  const id = useRef(`m${++seq}`).current;
  const panelRef = useRef<HTMLDivElement>(null);
  // Se il mousedown parte DENTRO il pannello (es. selezione di testo che
  // finisce fuori), non è un click sullo sfondo: non chiudiamo.
  const downOnBackdrop = useRef(false);

  useEffect(() => {
    stack.push(id);
    const previouslyFocused = document.activeElement as HTMLElement | null;

    // Blocca lo scroll della pagina dietro, senza far "saltare" il layout.
    const prevOverflow = document.body.style.overflow;
    const prevPad = document.body.style.paddingRight;
    const gap = window.innerWidth - document.documentElement.clientWidth;
    document.body.style.overflow = 'hidden';
    if (gap > 0) document.body.style.paddingRight = `${gap}px`;

    // Il focus entra nel modale: il primo campo, altrimenti il pannello.
    const focusTarget =
      panelRef.current?.querySelector<HTMLElement>(
        'input:not([type=hidden]), textarea, [data-autofocus]',
      ) ?? panelRef.current;
    focusTarget?.focus({ preventScroll: true });

    function onKey(e: KeyboardEvent) {
      if (e.key !== 'Escape') return;
      if (stack[stack.length - 1] !== id) return; // solo il modale in cima
      e.stopPropagation();
      onClose();
    }
    document.addEventListener('keydown', onKey);

    return () => {
      document.removeEventListener('keydown', onKey);
      const i = stack.indexOf(id);
      if (i >= 0) stack.splice(i, 1);
      if (stack.length === 0) {
        document.body.style.overflow = prevOverflow;
        document.body.style.paddingRight = prevPad;
      }
      previouslyFocused?.focus?.({ preventScroll: true });
    };
  }, [id, onClose]);

  const depth = Math.max(0, stack.indexOf(id));

  return createPortal(
    <div
      className="modal-backdrop"
      style={{ zIndex: 50 + depth * 10 }}
      onMouseDown={(e) => {
        downOnBackdrop.current = e.target === e.currentTarget;
      }}
      onMouseUp={(e) => {
        if (!dismissable) return;
        if (downOnBackdrop.current && e.target === e.currentTarget) onClose();
        downOnBackdrop.current = false;
      }}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        tabIndex={-1}
        className={`modal-panel ${SIZES[size]} ${tall ? 'h-[76vh]' : 'max-h-[88vh]'}`}
        onMouseDown={(e) => e.stopPropagation()}
      >
        {(title || icon) && (
          <header className="flex shrink-0 items-center gap-3 px-5 py-4">
            {icon}
            <div className="min-w-0 flex-1">
              <h2 className="truncate text-[16.5px] font-semibold tracking-[-0.01em]">{title}</h2>
              {subtitle && (
                <p className="truncate text-[13px] text-[var(--color-ink-soft)]">{subtitle}</p>
              )}
            </div>
            {headerRight}
            <button
              onClick={onClose}
              aria-label="Chiudi"
              className="shrink-0 rounded-lg p-1.5 text-[var(--color-ink-faint)] transition-colors hover:bg-[var(--color-sunken)] hover:text-[var(--color-ink)]"
            >
              <X size={17} />
            </button>
          </header>
        )}

        <div className={`min-h-0 flex-1 overflow-y-auto ${flush ? '' : 'px-5 pb-5'}`}>
          {children}
        </div>

        {footer && (
          <footer className="flex shrink-0 items-center gap-2 border-t border-[var(--color-line)] px-5 py-3">
            {footer}
          </footer>
        )}
      </div>
    </div>,
    document.body,
  );
}

/* -------------------------------------------------------------------------- */
/*  Pezzi ricorrenti nei modali a elenco                                       */
/* -------------------------------------------------------------------------- */

/** Campo di ricerca in cima a un elenco. */
export function ModalSearch({
  value,
  onChange,
  placeholder,
  right,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
  right?: ReactNode;
}) {
  return (
    <div className="px-5 pb-3">
      <div className="modal-search">
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" className="shrink-0 opacity-45">
          <circle cx="11" cy="11" r="7" stroke="currentColor" strokeWidth="2.2" />
          <path d="m20 20-3.5-3.5" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
        </svg>
        <input
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          className="min-w-0 flex-1 bg-transparent text-[14px] outline-none placeholder:text-[var(--color-ink-faint)]"
        />
        {right}
      </div>
    </div>
  );
}

/** Barra di linguette (Tutti / Iscritti / Archiviati…). */
export function ModalTabs<T extends string>({
  tabs,
  active,
  onChange,
}: {
  tabs: Array<{ id: T; label: string }>;
  active: T;
  onChange: (id: T) => void;
}) {
  return (
    <div className="flex gap-4 border-b border-[var(--color-line)] px-5">
      {tabs.map((t) => (
        <button
          key={t.id}
          onClick={() => onChange(t.id)}
          className={
            'relative -mb-px border-b-2 pb-2 text-[13.5px] transition-colors ' +
            (active === t.id
              ? 'border-[var(--color-ink)] font-medium text-[var(--color-ink)]'
              : 'border-transparent text-[var(--color-ink-soft)] hover:text-[var(--color-ink)]')
          }
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}

/** Riga di elenco: titolo + riga di dettaglio, con hover pieno. */
export function ModalRow({
  onClick,
  leading,
  title,
  meta,
  trailing,
  active = false,
}: {
  onClick?: () => void;
  leading?: ReactNode;
  title: ReactNode;
  meta?: ReactNode;
  trailing?: ReactNode;
  active?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      data-active={active || undefined}
      className="modal-row group"
    >
      {leading && <span className="shrink-0">{leading}</span>}
      <span className="min-w-0 flex-1 text-left">
        <span className="block truncate text-[14px] font-medium">{title}</span>
        {meta && (
          <span className="mt-0.5 block truncate text-[12.5px] text-[var(--color-ink-faint)]">
            {meta}
          </span>
        )}
      </span>
      {trailing && <span className="shrink-0">{trailing}</span>}
    </button>
  );
}
