import { initials } from '@hive/shared';
import clsx from 'clsx';

/**
 * Avatar circolare, come nella reference.
 * Senza emoji ripiega sulle iniziali su fondo colorato: mai un
 * segnaposto grigio anonimo.
 */
export function Avatar({
  name,
  emoji,
  color,
  size = 36,
  online,
  isAgent,
  className,
}: {
  name: string;
  emoji?: string | null;
  color?: string | null;
  size?: number;
  online?: boolean;
  isAgent?: boolean;
  className?: string;
}) {
  const bg = color ?? '#8A8A80';
  return (
    <div className={clsx('relative shrink-0', className)} style={{ width: size, height: size }}>
      <div
        className="flex h-full w-full items-center justify-center overflow-hidden font-semibold text-white select-none"
        style={{
          background: emoji ? `color-mix(in oklab, ${bg} 18%, transparent)` : bg,
          borderRadius: '50%',
          fontSize: size * 0.4,
        }}
        aria-hidden="true"
      >
        {emoji ? <span style={{ fontSize: size * 0.55 }}>{emoji}</span> : initials(name)}
      </div>

      {/* Pallino di presenza: solo per le persone, gli agenti sono sempre lì. */}
      {online !== undefined && !isAgent && (
        <span
          className="absolute rounded-full ring-2"
          style={{
            width: size * 0.3,
            height: size * 0.3,
            right: -1,
            bottom: -1,
            background: online ? 'var(--color-online)' : 'var(--color-ink-faint)',
            // L'anello riprende il fondo così il pallino sembra ritagliato.
            ['--tw-ring-color' as string]: 'var(--color-panel)',
          }}
          title={online ? 'Online' : 'Non in linea'}
        />
      )}
    </div>
  );
}
