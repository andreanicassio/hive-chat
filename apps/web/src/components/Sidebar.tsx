import { useMemo, useState } from 'react';
import clsx from 'clsx';
import { Hash, Lock, Plus, Search, Inbox, Bot, ChevronDown, Settings2 } from 'lucide-react';
import { useStore } from '../store.js';
import { Avatar } from './Avatar.js';
import type { Channel } from '@hive/shared';

/**
 * Barra laterale.
 *
 * Ricalca la reference: gruppi di canali con intestazione discreta, canale
 * attivo evidenziato da un riquadro morbido, non letti resi con il peso del
 * testo invece che con un badge. In fondo l'utente corrente.
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
  const groups = useStore((s) => s.groups);
  const channels = useStore((s) => s.channels);
  const agents = useStore((s) => s.agents);
  const user = useStore((s) => s.user);
  const activeChannelId = useStore((s) => s.activeChannelId);
  const openChannel = useStore((s) => s.openChannel);
  const connected = useStore((s) => s.connected);

  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

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
      .map((g) => ({ id: g.id, name: g.name, emoji: g.emoji, channels: byGroup.get(g.id) ?? [] }))
      .filter((s) => s.channels.length > 0);

    if (loose.length > 0) {
      ordered.push({ id: '__loose', name: 'Canali', emoji: null, channels: loose });
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
    <aside className="flex h-full w-[236px] shrink-0 flex-col">
      {/* --- ricerca --- */}
      <div className="px-3 pt-3 pb-2">
        <button
          onClick={onSearch}
          className="flex w-full items-center gap-2 rounded-[9px] border border-[color-mix(in_oklab,var(--color-ink)_8%,transparent)] bg-[color-mix(in_oklab,#ffffff_38%,transparent)] px-2.5 py-[7px] text-[13.5px] text-[var(--color-ink-faint)] transition-colors hover:bg-[color-mix(in_oklab,#ffffff_60%,transparent)]"
        >
          <Search size={14} strokeWidth={2.2} />
          <span className="flex-1 text-left">Cerca ovunque</span>
          <kbd className="font-sans text-[11px] tracking-wide opacity-70">⌘K</kbd>
        </button>
      </div>

      {/* --- collegamenti fissi --- */}
      <nav className="px-3 pb-1">
        <button className="rail-item">
          <Inbox size={15.5} strokeWidth={2} />
          <span>In arrivo</span>
        </button>
        <button className="rail-item" onClick={onOpenAgents}>
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
                className="group mb-0.5 flex w-full items-center gap-1.5 px-1.5 py-0.5 text-[12.5px] font-medium text-[var(--color-ink-faint)] transition-colors hover:text-[var(--color-ink-soft)]"
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
                  return (
                    <button
                      key={channel.id}
                      className="rail-item"
                      data-active={active}
                      data-unread={unread && !active}
                      onClick={() => void openChannel(channel.id)}
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
                        <span className="ml-auto rounded-full bg-[var(--color-clay)] px-1.5 text-[11px] font-semibold text-white tabular-nums">
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
          className="rail-item text-[var(--color-ink-faint)] hover:text-[var(--color-ink)]"
        >
          <Plus size={14} strokeWidth={2.4} />
          <span>Aggiungi canale</span>
        </button>
      </div>

      {/* --- utente corrente --- */}
      <div className="flex items-center gap-2.5 px-3 py-3">
        <Avatar
          name={user?.name ?? '?'}
          emoji={user?.avatarEmoji}
          color={user?.avatarColor}
          size={30}
          online={connected}
        />
        <div className="min-w-0 flex-1">
          <div className="truncate text-[13.5px] font-medium leading-tight">{user?.name}</div>
          <div className="flex items-center gap-1 truncate text-[12px] text-[var(--color-ink-faint)]">
            <span>{workspace?.iconEmoji}</span>
            <span className="truncate">{workspace?.name}</span>
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
          className="shrink-0 rounded-lg p-1.5 text-[var(--color-ink-faint)] transition-colors hover:bg-[color-mix(in_oklab,var(--color-ink)_7%,transparent)] hover:text-[var(--color-ink)]"
          title="Impostazioni del progetto"
        >
          <Settings2 size={15} strokeWidth={2.1} />
        </button>
      </div>
    </aside>
  );
}
