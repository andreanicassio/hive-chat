import { useMemo, useState } from 'react';
import clsx from 'clsx';
import { Users, Plus, X, Bot, Terminal, Zap } from 'lucide-react';
import { useStore } from '../store.js';
import { api } from '../lib/api.js';
import { Avatar } from './Avatar.js';
import { Modal, ModalRow, ModalSearch } from './Modal.js';

/**
 * Chi c'è in questo canale.
 *
 * Gli agenti si aggiungono canale per canale: nessuno parla ovunque per
 * default. Da qui si aggancia, si sgancia e si decide se un agente deve
 * intervenire da solo o solo quando lo tagghi — impostazione che vale
 * *in questo canale*, non per l'agente in generale.
 */
export function ChannelMembers({
  channelId,
  onClose,
}: {
  channelId: string;
  onClose: () => void;
}) {
  const agents = useStore((s) => s.agents);
  const members = useStore((s) => s.members);
  const channels = useStore((s) => s.channels);
  const channel = channels.find((c) => c.id === channelId);

  const [adding, setAdding] = useState(false);
  const [q, setQ] = useState('');
  const [busy, setBusy] = useState<string | null>(null);

  const inChannel = useMemo(
    () => agents.filter((a) => (a.channelIds ?? []).includes(channelId)),
    [agents, channelId],
  );
  const available = useMemo(() => {
    const out = agents.filter((a) => !(a.channelIds ?? []).includes(channelId));
    const needle = q.trim().toLowerCase();
    if (!needle) return out;
    return out.filter(
      (a) => a.name.toLowerCase().includes(needle) || a.handle.toLowerCase().includes(needle),
    );
  }, [agents, channelId, q]);

  async function attach(agentId: string) {
    setBusy(agentId);
    try {
      await api.attachAgent(agentId, channelId, false);
    } finally {
      setBusy(null);
    }
  }

  /** Accende o spegne l'auto-risposta di questo agente IN QUESTO canale. */
  async function toggleAuto(agentId: string, next: boolean) {
    setBusy(agentId);
    try {
      // La stessa rotta che aggancia l'agente al canale: qui il legame c'è
      // già, quindi aggiorna solo l'impostazione. Il server ripubblica
      // l'agente, e l'elenco si aggiorna da sé.
      await api.attachAgent(agentId, channelId, next);
    } finally {
      setBusy(null);
    }
  }

  async function detach(agentId: string) {
    setBusy(agentId);
    try {
      await api.detachAgent(agentId, channelId);
    } finally {
      setBusy(null);
    }
  }

  return (
    <Modal
      onClose={onClose}
      size="md"
      tall
      flush
      icon={<Users size={18} strokeWidth={2.1} />}
      title={adding ? 'Aggiungi un agente' : `Membri di #${channel?.name ?? ''}`}
      headerRight={
        adding ? (
          <button className="btn btn-ghost btn-sm" onClick={() => setAdding(false)}>
            Fatto
          </button>
        ) : (
          <button className="btn btn-primary btn-sm" onClick={() => setAdding(true)}>
            <Plus size={13} strokeWidth={2.4} /> Aggiungi agente
          </button>
        )
      }
    >
      {adding ? (
        <>
          <ModalSearch value={q} onChange={setQ} placeholder="Cerca un agente del progetto…" />
          {available.length === 0 ? (
            <p className="px-6 py-10 text-center text-[13.5px] text-[var(--color-ink-faint)]">
              {agents.length === 0
                ? 'Non hai ancora creato nessun agente.'
                : 'Tutti gli agenti sono già in questo canale.'}
            </p>
          ) : (
            available.map((a) => (
              <ModalRow
                key={a.id}
                onClick={() => void attach(a.id)}
                leading={
                  <Avatar name={a.name} emoji={a.avatarEmoji} color={a.avatarColor} size={30} isAgent />
                }
                title={
                  <span className="flex items-center gap-2">
                    {a.name}
                    <span className="text-[12.5px] font-normal text-[var(--color-ink-faint)]">
                      @{a.handle}
                    </span>
                    {a.kind === 'developer' && (
                      <Terminal size={10} className="text-[var(--color-ink-faint)]" />
                    )}
                  </span>
                }
                meta={a.description ?? 'Nessuna descrizione'}
                trailing={
                  <span className="text-[12.5px] text-[var(--color-ink-faint)]">
                    {busy === a.id ? '…' : 'Aggiungi'}
                  </span>
                }
              />
            ))
          )}
        </>
      ) : (
        <>
          <div className="px-5 pt-1 pb-2 text-[11.5px] font-semibold tracking-wide text-[var(--color-ink-faint)] uppercase">
            Agenti · {inChannel.length}
          </div>
          {inChannel.length === 0 ? (
            <p className="px-6 pb-4 text-[13px] text-[var(--color-ink-faint)]">
              Nessun agente in questo canale. Aggiungine uno: risponderà solo qui dentro, non
              negli altri canali.
            </p>
          ) : (
            inChannel.map((a) => {
              // L'auto-risposta è una proprietà del legame agente-canale: lo
              // stesso agente può servire qui e disturbare altrove.
              const auto = (a.autoRespondChannelIds ?? []).includes(channelId);
              return (
                <div
                  key={a.id}
                  className="group flex items-start gap-2.5 px-5 py-2.5 transition-colors hover:bg-[var(--color-sunken)]"
                >
                  <Avatar
                    name={a.name}
                    emoji={a.avatarEmoji}
                    color={a.avatarColor}
                    size={30}
                    isAgent
                  />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="text-[14px] font-medium">{a.name}</span>
                      <span className="text-[12.5px] text-[var(--color-ink-faint)]">
                        @{a.handle}
                      </span>
                    </div>

                    <button
                      onClick={() => void toggleAuto(a.id, !auto)}
                      disabled={busy === a.id}
                      className="mt-1.5 flex items-center gap-2 text-left"
                    >
                      <span
                        className={clsx(
                          'flex h-[18px] w-[30px] shrink-0 items-center rounded-full px-[2px] transition-colors',
                          auto
                            ? 'bg-[var(--color-honey)]'
                            : 'bg-[var(--color-line-strong)]',
                        )}
                      >
                        <span
                          className={clsx(
                            'h-[14px] w-[14px] rounded-full bg-[var(--color-panel)] transition-transform',
                            auto && 'translate-x-[12px]',
                          )}
                        />
                      </span>
                      <span className="text-[12.5px] text-[var(--color-ink-soft)]">
                        {auto ? (
                          <>
                            <Zap size={10} className="mr-0.5 inline" />
                            Risponde a ogni messaggio, qui
                          </>
                        ) : (
                          `Risponde solo se taggato con @${a.handle}`
                        )}
                      </span>
                    </button>
                  </div>

                  <button
                    onClick={() => void detach(a.id)}
                    disabled={busy === a.id}
                    title="Togli dal canale"
                    className="mt-1 rounded-md p-1 text-[var(--color-ink-faint)] opacity-0 transition-all group-hover:opacity-100 hover:bg-[var(--color-sunken)] hover:text-[var(--color-error)]"
                  >
                    <X size={14} strokeWidth={2.2} />
                  </button>
                </div>
              );
            })
          )}

          <div className="mt-2 px-5 pt-3 pb-2 text-[11.5px] font-semibold tracking-wide text-[var(--color-ink-faint)] uppercase">
            Persone · {members.length}
          </div>
          {members.map((m) => (
            <ModalRow
              key={m.id}
              leading={
                <Avatar name={m.name} emoji={m.avatarEmoji} color={m.avatarColor} size={30} />
              }
              title={m.name}
              meta={`@${m.handle} · ${m.role}`}
            />
          ))}

          <p className="px-5 pt-3 pb-1 text-[12px] leading-relaxed text-[var(--color-ink-faint)]">
            <Bot size={11} className="mr-1 inline" />
            Ogni agente sta solo nei canali in cui lo metti: fuori da qui non legge e non
            risponde.
          </p>
        </>
      )}
    </Modal>
  );
}
