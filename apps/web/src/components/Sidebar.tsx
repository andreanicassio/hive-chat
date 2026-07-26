import { useMemo, useState } from 'react';
import clsx from 'clsx';
import {
  Hash,
  Lock,
  Plus,
  Search,
  Inbox,
  Bot,
  ChevronDown,
  Settings2,
  Pencil,
  Trash2,
} from 'lucide-react';
import { useStore } from '../store.js';
import { api, ApiError } from '../lib/api.js';
import { Avatar } from './Avatar.js';
import { BuildTag } from './BuildTag.js';
import { ClaudeMeter } from './ClaudeMeter.js';
import type { Channel } from '@hive/shared';

/* Misure della voce di barra. `.rail-item` vive in index.css: qui si aggiunge
   solo quello che il design chiede e che il foglio condiviso non fissa. */
const RAIL = 'rail-item h-[31px] tracking-[-0.005em]';

/** A parità di posizione decide il nome: così l'ordine non balla mai. */
function byPosition(list: Channel[]): Channel[] {
  return list.slice().sort((a, b) => a.position - b.position || a.name.localeCompare(b.name));
}

/* La pillola del canale attivo vive in index.css, su
   `.rail-item[data-active='true']`: è uno stato della voce, non una variante
   locale, e lì non serve scavalcare niente con `!important`. */

/**
 * Barra laterale.
 *
 * Gruppi di canali con intestazione discreta, canale attivo su pillola chiara,
 * non letti resi con il peso del testo (le menzioni, quelle sì, con un badge).
 * In fondo l'utente corrente.
 */
export function Sidebar({
  onOpenAgents,
  onNewChannel,
  onSearch,
  onOpenSettings,
}: {
  onOpenAgents: () => void;
  onNewChannel: () => void;
  onSearch: () => void;
  onOpenSettings: () => void;
}) {
  const workspace = useStore((s) => s.workspace);
  const workspaces = useStore((s) => s.workspaces);
  const groups = useStore((s) => s.groups);
  const channels = useStore((s) => s.channels);
  const reorderLocally = useStore((s) => s.reorderLocally);
  const agents = useStore((s) => s.agents);
  const user = useStore((s) => s.user);
  const activeChannelId = useStore((s) => s.activeChannelId);
  const openChannel = useStore((s) => s.openChannel);
  const switchWorkspace = useStore((s) => s.switchWorkspace);
  const createWorkspace = useStore((s) => s.createWorkspace);
  const connected = useStore((s) => s.connected);

  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [wsMenu, setWsMenu] = useState(false);
  /* Rinomina in linea e menu contestuale dei canali. */
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');

  /* Trascinamento: cosa si sta spostando, e dove finirebbe. */
  const [dragId, setDragId] = useState<string | null>(null);
  const [dropAt, setDropAt] = useState<{ id: string; below: boolean } | null>(null);

  /**
   * Sposta un canale prima o dopo un altro, dentro il suo gruppo.
   *
   * Al server va l'elenco completo e ordinato del gruppo, non lo spostamento:
   * è lui a riscrivere le posizioni da zero, così non restano buchi. Intanto
   * l'ordine si aggiorna qui, altrimenti il canale tornerebbe al suo posto per
   * il tempo di un giro di rete.
   */
  async function moveChannel(sourceId: string, targetId: string, below: boolean) {
    const source = channels.find((c) => c.id === sourceId);
    const target = channels.find((c) => c.id === targetId);
    if (!source || !target || sourceId === targetId) return;

    const groupId = target.groupId ?? null;
    const siblings = byPosition(channels.filter((c) => c.kind !== 'dm' && (c.groupId ?? null) === groupId));
    const without = siblings.filter((c) => c.id !== sourceId);
    const at = without.findIndex((c) => c.id === targetId);
    if (at === -1) return;
    const ids = without.map((c) => c.id);
    ids.splice(below ? at + 1 : at, 0, sourceId);

    reorderLocally(groupId, ids);
    try {
      await api.reorderChannels(groupId, ids);
    } catch (err) {
      alert(err instanceof ApiError ? err.message : 'Non sono riuscito a spostare il canale.');
    }
  }
  const [menuFor, setMenuFor] = useState<
    { id: string; name: string; x: number; y: number } | null
  >(null);

  async function commitRename(channelId: string, previous: string) {
    const name = renameValue.trim().replace(/^-+|-+$/g, '');
    setRenamingId(null);
    if (!name || name === previous) return;
    try {
      await api.updateChannel(channelId, { name });
    } catch (err) {
      alert(err instanceof ApiError ? err.message : 'Rinomina non riuscita.');
    }
  }

  async function archive(channelId: string, name: string) {
    setMenuFor(null);
    if (!confirm(`Eliminare #${name}? Sparisce dall'elenco; i messaggi restano archiviati.`)) return;
    try {
      await api.archiveChannel(channelId);
    } catch (err) {
      alert(err instanceof ApiError ? err.message : 'Eliminazione non riuscita.');
    }
  }

  // Canali raggruppati; quelli senza gruppo finiscono in coda sotto "Canali".
  const sections = useMemo(() => {
    const byGroup = new Map<string, Channel[]>();
    const loose: Channel[] = [];
    for (const c of channels) {
      if (c.kind === 'dm') continue;
      if (c.groupId) {
        const list = byGroup.get(c.groupId) ?? [];
        list.push(c);
        byGroup.set(c.groupId, list);
      } else {
        loose.push(c);
      }
    }
    const ordered = groups
      .slice()
      .sort((a, b) => a.position - b.position)
      .map((g) => ({
        id: g.id,
        name: g.name,
        emoji: g.emoji,
        // Dentro un gruppo comanda `position`: è quella che il trascinamento
        // riscrive, e senza questo ordinamento spostare un canale non si
        // vedrebbe finché non si ricarica.
        channels: byPosition(byGroup.get(g.id) ?? []),
      }))
      .filter((s) => s.channels.length > 0);

    if (loose.length > 0) {
      ordered.push({ id: '__loose', name: 'Canali', emoji: null, channels: byPosition(loose) });
    }
    return ordered;
  }, [channels, groups]);

  const toggle = (id: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <>
    <aside className="flex h-full w-[236px] shrink-0 flex-col">
      {/*
        Il progetto in cima, grande quanto un titolo.
        Prima stava in fondo, sotto il nome dell'utente, in dodici pixel di
        grigio: era la cosa che dice DOVE SEI, scritta più in piccolo di ogni
        canale. Chi ha due progetti non trovava come cambiarli, e chi ne ha
        uno solo non sapeva di essere dentro qualcosa.
      */}
      <div className="relative px-3 pt-3">
        <button
          onClick={() => setWsMenu((v) => !v)}
          className="group/ws flex w-full items-center gap-2 rounded-[9px] px-1.5 py-1.5 text-left transition-colors duration-[120ms] hover:bg-[color-mix(in_oklab,var(--color-ink)_5%,transparent)]"
          title="Cambia progetto"
        >
          <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-[8px] bg-[var(--color-glass)] text-[15px]">
            {workspace?.iconEmoji ?? '🐝'}
          </span>
          <span className="min-w-0 flex-1 truncate text-[15px] font-bold tracking-[-0.02em]">
            {workspace?.name ?? 'Progetto'}
          </span>
          <ChevronDown
            size={14}
            strokeWidth={2.4}
            className="shrink-0 text-[var(--color-ink-faint)] transition-colors group-hover/ws:text-[var(--color-ink)]"
          />
        </button>

        {wsMenu && (
          <>
            <div className="fixed inset-0 z-30" onClick={() => setWsMenu(false)} />
            <div className="absolute top-full right-3 left-3 z-40 mt-1 overflow-hidden rounded-[11px] border border-[var(--color-line)] bg-[var(--color-panel)] shadow-[var(--shadow-pop)]">
              <div className="px-3 pt-2 pb-1 text-[11px] font-semibold tracking-wide text-[var(--color-ink-faint)] uppercase">
                I tuoi progetti
              </div>
              {workspaces.map((w) => (
                <button
                  key={w.id}
                  onClick={() => {
                    setWsMenu(false);
                    if (w.id !== workspace?.id) void switchWorkspace(w.id);
                  }}
                  className={clsx(
                    'flex w-full items-center gap-2 px-3 py-1.5 text-left text-[14px] transition-colors',
                    w.id === workspace?.id
                      ? 'bg-[color-mix(in_oklab,var(--color-honey)_12%,transparent)] font-medium'
                      : 'hover:bg-[color-mix(in_oklab,var(--color-ink)_5%,transparent)]',
                  )}
                >
                  <span>{w.iconEmoji}</span>
                  <span className="min-w-0 flex-1 truncate">{w.name}</span>
                  {w.id === workspace?.id && (
                    <span className="h-1.5 w-1.5 rounded-full bg-[var(--color-honey)]" />
                  )}
                </button>
              ))}
              <button
                onClick={() => {
                  setWsMenu(false);
                  const name = prompt('Nome del nuovo progetto');
                  if (name?.trim()) void createWorkspace(name.trim(), '🐝');
                }}
                className="flex w-full items-center gap-2 border-t border-[var(--color-line)] px-3 py-1.5 text-left text-[13.5px] text-[var(--color-ink-soft)] transition-colors hover:bg-[var(--color-sunken)]"
              >
                <Plus size={13} strokeWidth={2.4} /> Nuovo progetto
              </button>
            </div>
          </>
        )}
      </div>

      {/* --- ricerca --- */}
      <div className="px-3 pt-2 pb-2">
        <button
          onClick={onSearch}
          className="flex h-[32px] w-full items-center gap-2 rounded-[9px] border border-[rgba(28,34,40,0.15)] bg-[rgba(255,255,255,0.5)] px-2.5 text-[13.5px] text-[var(--color-ink-faint)] transition-colors duration-[120ms] hover:bg-[var(--color-glass)]"
        >
          <Search size={14} strokeWidth={2.2} />
          <span className="flex-1 text-left">Cerca ovunque</span>
          <kbd className="font-mono text-[11px] opacity-70">⌘K</kbd>
        </button>
      </div>

      {/* --- collegamenti fissi --- */}
      <nav className="px-3 pb-1">
        <button className={RAIL}>
          <Inbox size={15.5} strokeWidth={2} />
          <span>In arrivo</span>
        </button>
        <button className={RAIL} onClick={onOpenAgents}>
          <Bot size={15.5} strokeWidth={2} />
          <span>Agenti</span>
          {agents.length > 0 && (
            <span className="ml-auto text-[12px] tabular-nums text-[var(--color-ink-faint)]">
              {agents.length}
            </span>
          )}
        </button>
      </nav>

      {/* --- canali --- */}
      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-2">
        {sections.map((section) => {
          const isCollapsed = collapsed.has(section.id);
          return (
            <section key={section.id} className="mb-3">
              <button
                onClick={() => toggle(section.id)}
                className="group mb-0.5 flex w-full items-center gap-1.5 px-1.5 py-0.5 text-[11.5px] font-semibold tracking-[0.04em] text-[var(--color-ink-faint)] uppercase transition-colors duration-[120ms] hover:text-[var(--color-ink-soft)]"
              >
                <ChevronDown
                  size={12}
                  strokeWidth={2.5}
                  className={clsx('transition-transform', isCollapsed && '-rotate-90')}
                />
                {section.emoji && <span className="text-[13px]">{section.emoji}</span>}
                <span className="truncate">{section.name}</span>
              </button>

              {!isCollapsed &&
                section.channels.map((channel) => {
                  const unread = (channel.unreadCount ?? 0) > 0;
                  const active = channel.id === activeChannelId;
                  const channelAgents = agents.filter((a) =>
                    (a.channelIds ?? []).includes(channel.id),
                  );
                  // Rinomina in linea: doppio clic sul nome del canale.
                  if (renamingId === channel.id) {
                    return (
                      <div
                        key={channel.id}
                        className={RAIL}
                        data-active={active}
                      >
                        {channel.visibility === 'private' ? (
                          <Lock size={13.5} strokeWidth={2.2} className="opacity-65" />
                        ) : (
                          <Hash size={13.5} strokeWidth={2.4} className="opacity-65" />
                        )}
                        <input
                          autoFocus
                          value={renameValue}
                          onChange={(e) =>
                            setRenameValue(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, '-'))
                          }
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') void commitRename(channel.id, channel.name);
                            if (e.key === 'Escape') setRenamingId(null);
                          }}
                          onBlur={() => void commitRename(channel.id, channel.name)}
                          maxLength={48}
                          className="min-w-0 flex-1 rounded border border-[var(--color-honey)] bg-[var(--color-panel)] px-1 py-0.5 text-[13.5px] outline-none"
                        />
                      </div>
                    );
                  }
                  const marker =
                    dropAt?.id === channel.id && dragId && dragId !== channel.id
                      ? dropAt.below
                        ? 'after'
                        : 'before'
                      : null;
                  return (
                    <button
                      key={channel.id}
                      className={clsx(
                        RAIL,
                        'group relative',
                        dragId === channel.id && 'opacity-40',
                        // La riga di rilascio è un bordo, non un elemento in
                        // più: così non sposta niente mentre la si guarda.
                        marker === 'before' && 'before:absolute before:inset-x-1 before:top-0 before:h-[2px] before:rounded-full before:bg-[var(--color-honey)]',
                        marker === 'after' && 'after:absolute after:inset-x-1 after:bottom-0 after:h-[2px] after:rounded-full after:bg-[var(--color-honey)]',
                      )}
                      data-active={active}
                      data-unread={unread && !active}
                      draggable
                      onDragStart={(e) => {
                        setDragId(channel.id);
                        e.dataTransfer.effectAllowed = 'move';
                        // Firefox non avvia il trascinamento senza dati.
                        e.dataTransfer.setData('text/plain', channel.id);
                      }}
                      onDragEnd={() => {
                        setDragId(null);
                        setDropAt(null);
                      }}
                      onDragOver={(e) => {
                        if (!dragId || dragId === channel.id) return;
                        e.preventDefault();
                        e.dataTransfer.dropEffect = 'move';
                        // Sopra o sotto, deciso dalla metà della riga: è come
                        // ci si aspetta che funzioni, e non serve mirare.
                        const box = e.currentTarget.getBoundingClientRect();
                        setDropAt({ id: channel.id, below: e.clientY > box.top + box.height / 2 });
                      }}
                      onDragLeave={() => {
                        setDropAt((cur) => (cur?.id === channel.id ? null : cur));
                      }}
                      onDrop={(e) => {
                        e.preventDefault();
                        const source = dragId;
                        const below = dropAt?.below ?? false;
                        setDragId(null);
                        setDropAt(null);
                        if (source) void moveChannel(source, channel.id, below);
                      }}
                      onClick={() => void openChannel(channel.id)}
                      onDoubleClick={(e) => {
                        e.preventDefault();
                        setRenamingId(channel.id);
                        setRenameValue(channel.name);
                      }}
                      onContextMenu={(e) => {
                        e.preventDefault();
                        setMenuFor({ id: channel.id, name: channel.name, x: e.clientX, y: e.clientY });
                      }}
                      title="Doppio clic per rinominare · trascina per spostare · tasto destro per altre azioni"
                    >
                      {channel.visibility === 'private' ? (
                        <Lock size={13.5} strokeWidth={2.2} className="opacity-65" />
                      ) : (
                        <Hash size={13.5} strokeWidth={2.4} className="opacity-65" />
                      )}
                      <span className="min-w-0 flex-1 truncate">{channel.name}</span>

                      {/* Gli agenti del canale si vedono a colpo d'occhio. */}
                      {channelAgents.length > 0 && !unread && (
                        <span className="flex -space-x-1">
                          {channelAgents.slice(0, 3).map((a) => (
                            <span
                              key={a.id}
                              title={a.name}
                              className="text-[11px] leading-none"
                              style={{ filter: active ? 'none' : 'grayscale(0.35)' }}
                            >
                              {a.avatarEmoji}
                            </span>
                          ))}
                        </span>
                      )}

                      {channel.hasMention ? (
                        <span className="ml-auto inline-flex h-[17px] shrink-0 items-center rounded-full bg-[var(--color-honey)] px-1.5 text-[11px] leading-none font-semibold text-[var(--color-panel)] tabular-nums">
                          {channel.unreadCount}
                        </span>
                      ) : unread ? (
                        <span className="ml-auto h-[6px] w-[6px] rounded-full bg-[var(--color-ink-soft)]" />
                      ) : null}
                    </button>
                  );
                })}
            </section>
          );
        })}

        <button
          onClick={onNewChannel}
          className={clsx(RAIL, 'text-[var(--color-ink-faint)] hover:text-[var(--color-ink)]')}
        >
          <Plus size={14} strokeWidth={2.4} />
          <span>Aggiungi canale</span>
        </button>
      </div>

      {/* Quanto abbonamento resta e chi lo paga, poi quale versione sto
          eseguendo: sopra il profilo, sempre in vista. */}
      <div className="shrink-0 px-2.5 pt-1">
        <ClaudeMeter />
        <BuildTag />
      </div>

      {/* --- utente e progetto corrente --- */}
      <div className="relative flex items-center gap-2.5 px-3 pt-1 pb-3">
        <div className="relative shrink-0">
          <Avatar
            name={user?.name ?? '?'}
            emoji={user?.avatarEmoji}
            color={user?.avatarColor}
            size={34}
          />
          {/* Il pallino lo disegna la barra, non <Avatar>: l'anello di Avatar
              riprende --color-panel, quasi bianco, e qui il fondo è il
              gradiente freddo — si vedrebbe l'alone. */}
          <span
            className="absolute right-[-1px] bottom-[-1px] h-[11px] w-[11px] rounded-full"
            style={{
              background: connected ? 'var(--color-online)' : 'var(--color-ink-faint)',
              boxShadow: '0 0 0 2.5px var(--color-shell-deep)',
            }}
            title={connected ? 'Online' : 'Non in linea'}
          />
        </div>
        {/* Qui resta solo CHI sei: dove sei lo dice il titolo in cima. */}
        <div className="min-w-0 flex-1">
          <div className="truncate text-[13.5px] leading-tight font-semibold">{user?.name}</div>
          <div className="truncate text-[12px] text-[var(--color-ink-soft)]">
            {connected ? 'Online' : 'Non in linea'}
          </div>
        </div>
        {!connected && (
          <span
            className="h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--color-busy)]"
            title="Riconnessione in corso"
          />
        )}
        <button
          onClick={onOpenSettings}
          className="shrink-0 rounded-[8px] p-1.5 text-[var(--color-ink-faint)] transition-colors duration-[120ms] hover:bg-[var(--color-sunken)] hover:text-[var(--color-ink)]"
          title="Impostazioni del progetto"
        >
          <Settings2 size={15} strokeWidth={2.1} />
        </button>
      </div>
    </aside>

      {/* Menu contestuale del canale (tasto destro). */}
      {menuFor && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setMenuFor(null)} />
          <div
            className="fixed z-50 min-w-[180px] overflow-hidden rounded-[10px] border border-[var(--color-line)] bg-[var(--color-panel)] py-1 shadow-[var(--shadow-pop)]"
            style={{ left: menuFor.x, top: menuFor.y }}
          >
            <button
              className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[13px] transition-colors hover:bg-[var(--color-sunken)]"
              onClick={() => {
                setRenamingId(menuFor.id);
                setRenameValue(menuFor.name);
                setMenuFor(null);
              }}
            >
              <Pencil size={13} /> Rinomina
            </button>
            <button
              className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[13px] text-[var(--color-error)] transition-colors hover:bg-[var(--color-sunken)]"
              onClick={() => void archive(menuFor.id, menuFor.name)}
            >
              <Trash2 size={13} /> Elimina canale
            </button>
          </div>
        </>
      )}
    </>
  );
}
