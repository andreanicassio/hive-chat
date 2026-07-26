import { useNavigate } from 'react-router-dom';
import clsx from 'clsx';
import { Square, X } from 'lucide-react';
import { useStore, type RunState } from '../store.js';
import { api } from '../lib/api.js';
import { Avatar } from '../components/Avatar.js';
import { useTicker, totalDuration } from '../components/Chat.js';
import { RunConfig } from '../components/ChannelAside.js';
import { MobileHeader, WithTabs } from './Shell.js';

/* ==========================================================================
   05 — Attività

   Controllare e fermare gli agenti che stanno girando. Niente «Pausa»: non
   esiste nel codice, e un bottone che non fa niente è peggio di un bottone
   in meno.
   ======================================================================== */

function ActiveCard({ messageId, run }: { messageId: string; run: RunState }) {
  const navigate = useNavigate();
  const agents = useStore((s) => s.agents);
  const channels = useStore((s) => s.channels);
  const agent = agents.find((a) => a.id === run.agentId);
  const channel = channels.find((c) => c.id === run.channelId);
  // In coda non è al lavoro: niente cronometro, perché non è cominciato
  // niente. Vederlo scorrere su un turno fermo fa sembrare lento qualcosa
  // che sta solo aspettando il suo turno.
  const queued = run.status === 'queued';
  const now = useTicker(!queued);
  const seconds = run.startedAt ? Math.floor((now - run.startedAt) / 1000) : 0;

  let note: string | null = null;
  let current: string | null = null;
  for (let i = run.events.length - 1; i >= 0; i--) {
    const e = run.events[i]!.event;
    if (!current && e.type === 'tool.start') current = e.label;
    if (!note && e.type === 'text.block') note = e.text.trim().replace(/\s+/g, ' ').slice(0, 160);
    if (note && current) break;
  }

  return (
    <div className="rounded-[14px] bg-[var(--color-card)] p-3.5 shadow-[var(--shadow-panel)]">
      <div className="flex items-center gap-2.5">
        <Avatar
          name={agent?.name ?? 'Agente'}
          emoji={agent?.avatarEmoji}
          color={agent?.avatarColor}
          size={40}
          isAgent
        />
        <div className="min-w-0 flex-1">
          <div className="truncate text-[17px] font-semibold">{agent?.name ?? 'Agente'}</div>
          <div className="truncate text-[12.5px] text-[var(--color-ink-faint)]">
            {channel ? `#${channel.name}` : 'canale sconosciuto'}
            {run.numTurns > 0 && ` · passaggio ${run.numTurns}`}
          </div>
        </div>
        {queued ? (
          <span className="shrink-0 rounded-full bg-[var(--color-sunken)] px-2.5 py-1 text-[12px] font-medium text-[var(--color-ink-faint)]">
            in coda
          </span>
        ) : (
          <span className="shrink-0 text-[14px] font-semibold text-[var(--color-honey)] tabular-nums">
            {Math.floor(seconds / 60)}:{String(seconds % 60).padStart(2, '0')}
          </span>
        )}
      </div>

      <RunConfig run={run} agentId={run.agentId} />

      {note && <p className="mt-2.5 text-[13.5px] leading-[1.45] text-[var(--color-ink)]">{note}</p>}

      <div
        className={clsx(
          'mt-2.5 rounded-[10px] bg-[var(--color-panel-alt)] px-2.5 py-2',
          // La luce che scorre dice «sta succedendo qualcosa»: su un turno
          // fermo direbbe il falso, quindi non c'è.
          !queued && 'sweep',
        )}
      >
        <div className="mb-1 flex items-center gap-1.5">
          <span
            className={clsx(
              'h-[7px] w-[7px] rounded-full',
              queued
                ? 'queued-pulse bg-[var(--color-ink-faint)]'
                : 'animate-pulse bg-[var(--color-online)]',
            )}
          />
          <span
            className={clsx(
              'text-[10.5px] font-semibold tracking-[0.06em] uppercase',
              queued ? 'text-[var(--color-ink-faint)]' : 'text-[var(--color-honey)]',
            )}
          >
            {queued ? 'In attesa' : 'In corso'}
          </span>
        </div>
        <p className="font-mono text-[12px] break-all text-[var(--color-ink-soft)]">
          {queued ? 'non ancora cominciato' : (current ?? 'sta ragionando…')}
        </p>
      </div>

      <div className="mt-2.5 flex gap-2">
        {run.channelId && (
          <button
            onClick={() => navigate(`/c/${run.channelId}/m/${messageId}/lavoro`)}
            className="h-11 flex-1 rounded-[12px] bg-[var(--color-sunken)] text-[14px] font-medium"
          >
            Vedi il lavoro
          </button>
        )}
        <button
          onClick={() => void api.cancelRun(run.runId).catch(() => {})}
          className="flex h-11 flex-1 items-center justify-center gap-1.5 rounded-[12px] bg-[color-mix(in_oklab,var(--color-error)_12%,transparent)] text-[14px] font-medium text-[var(--color-error)]"
        >
          {queued ? (
            <>
              <X size={12} strokeWidth={3} /> Annulla
            </>
          ) : (
            <>
              <Square size={11} strokeWidth={3} /> Interrompi
            </>
          )}
        </button>
      </div>
    </div>
  );
}

export function MobileActivity() {
  const navigate = useNavigate();
  const runs = useStore((s) => s.runs);
  const agents = useStore((s) => s.agents);
  const channels = useStore((s) => s.channels);
  const approvals = useStore((s) => s.approvals);

  const entries = [...runs.entries()].map(([messageId, run]) => ({ messageId, run }));
  const active = entries.filter(
    ({ run }) => run.status === 'running' || run.status === 'queued',
  );
  const recent = entries
    .filter(({ run }) => run.status !== 'running' && run.status !== 'queued')
    .sort((a, b) => (b.run.startedAt ?? 0) - (a.run.startedAt ?? 0))
    .slice(0, 10);

  return (
    <WithTabs>
      <MobileHeader
        title="Attività"
        subtitle={
          active.length === 0 && approvals.length === 0
            ? 'Nessun agente al lavoro'
            : `${active.length} al lavoro${approvals.length > 0 ? ` · ${approvals.length} attende te` : ''}`
        }
        large
      />

      <div data-tabs className="screen-scroll h-full overflow-y-auto px-3">
        <div className="mt-3 flex flex-col gap-2.5">
          {active.map(({ messageId, run }) => (
            <ActiveCard key={run.runId} messageId={messageId} run={run} />
          ))}
        </div>

        {active.length === 0 && (
          <p className="mt-8 px-6 text-center text-[14px] leading-[1.5] text-[var(--color-ink-faint)]">
            Nessun agente sta lavorando adesso. Taggane uno in un canale e comparirà qui.
          </p>
        )}

        {recent.length > 0 && (
          <>
            <h2 className="px-1 pt-5 pb-1.5 text-[11.5px] font-semibold tracking-[0.06em] text-[var(--color-ink-faint)] uppercase">
              Turni recenti
            </h2>
            <div className="divide-y divide-[var(--color-line)] overflow-hidden rounded-[14px] bg-[var(--color-card)]">
              {recent.map(({ messageId, run }) => {
                const agent = agents.find((a) => a.id === run.agentId);
                const channel = channels.find((c) => c.id === run.channelId);
                const ms = run.startedAt && run.endedAt ? run.endedAt - run.startedAt : null;
                return (
                  <button
                    key={run.runId}
                    onClick={() =>
                      run.channelId && navigate(`/c/${run.channelId}/m/${messageId}/lavoro`)
                    }
                    className="flex min-h-[52px] w-full items-center gap-2.5 px-3.5 py-2.5 text-left"
                  >
                    <span
                      className="h-[7px] w-[7px] shrink-0 rounded-full"
                      style={{
                        background:
                          run.status === 'error'
                            ? 'var(--color-error)'
                            : 'var(--color-ink-faint)',
                      }}
                    />
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-[13.5px] font-semibold">
                        {agent?.name ?? 'Agente'}
                        {channel && (
                          <span className="ml-1.5 font-normal text-[var(--color-ink-faint)]">
                            #{channel.name}
                          </span>
                        )}
                      </div>
                      {run.status === 'cancelled' && (
                        <span className="text-[11.5px] text-[var(--color-ink-faint)]">
                          interrotto
                        </span>
                      )}
                    </div>
                    {ms !== null && (
                      <span className="shrink-0 text-[11.5px] text-[var(--color-ink-faint)] tabular-nums">
                        {totalDuration(ms)}
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
          </>
        )}
      </div>
    </WithTabs>
  );
}
