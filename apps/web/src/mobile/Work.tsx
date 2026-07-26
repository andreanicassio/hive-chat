import { useEffect } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import clsx from 'clsx';
import { Check, X } from 'lucide-react';
import { useStore } from '../store.js';
import {
  MessageBody,
  buildSteps,
  shortDuration,
  totalDuration,
  toolChipName,
  type WorkStep,
} from '../components/Chat.js';
import { MobileHeader } from './Shell.js';

/* ==========================================================================
   03 — Lavoro svolto

   Tutto quello che l'agente ha fatto, ma in una schermata sua: nel canale
   sarebbe un muro che rende illeggibile la conversazione.
   ======================================================================== */

export function MobileWork() {
  const { channelId, messageId } = useParams<{ channelId: string; messageId: string }>();
  const navigate = useNavigate();
  const run = useStore((s) => (messageId ? s.runs.get(messageId) : undefined));
  const agents = useStore((s) => s.agents);
  const loadRunEvents = useStore((s) => s.loadRunEvents);
  const agent = agents.find((a) => a.id === run?.agentId);

  // Da un link diretto la traccia non è in memoria: si carica arrivando qui.
  useEffect(() => {
    if (messageId && run && !run.eventsLoaded) void loadRunEvents(messageId);
  }, [messageId, run, loadRunEvents]);

  const back = () => navigate(channelId ? `/c/${channelId}` : '/');

  if (!run) {
    return (
      <div className="flex h-full flex-col">
        <MobileHeader title="Lavoro svolto" onBack={back} />
        <div className="flex flex-1 items-center justify-center px-8 text-center text-[14px] text-[var(--color-ink-faint)]">
          La traccia di questo turno non è più disponibile.
        </div>
      </div>
    );
  }

  const steps = buildSteps(run);
  const tools = steps.filter((s): s is Extract<WorkStep, { kind: 'tool' }> => s.kind === 'tool');
  const notes = steps.filter((s): s is Extract<WorkStep, { kind: 'text' }> => s.kind === 'text');
  const stepCount = Math.max(run.numTurns, tools.length);
  const elapsed = run.startedAt && run.endedAt ? run.endedAt - run.startedAt : null;
  const endedAt = run.endedAt ?? Date.now();

  return (
    <div className="relative flex h-full min-h-0 flex-col bg-[var(--color-panel)]">
      <MobileHeader
        title="Lavoro svolto"
        subtitle={`${agent?.avatarEmoji ?? '🤖'} ${agent?.name ?? 'agente'} · ${stepCount} ${
          stepCount === 1 ? 'passaggio' : 'passaggi'
        }${elapsed !== null ? ` · ${totalDuration(elapsed)}` : ''}`}
        onBack={back}
      />

      <div className="screen-scroll min-h-0 flex-1 overflow-y-auto px-3 pb-10">
        {/* In sintesi: se leggi una cosa sola, leggi questa. Sono parole sue,
            non un riassunto dedotto dai nomi dei comandi. */}
        {notes.length > 0 && (
          <section className="mt-3 rounded-[14px] bg-[var(--color-card)] p-3.5">
            <h2 className="mb-1.5 text-[11.5px] font-semibold tracking-[0.06em] text-[var(--color-ink-faint)] uppercase">
              In sintesi
            </h2>
            <MessageBody body={notes[0]!.text} className="msg-body-work" />
          </section>
        )}

        {tools.length > 0 && (
          <section className="mt-3 overflow-hidden rounded-[14px] bg-[var(--color-card)]">
            <h2 className="px-3.5 pt-3.5 pb-1.5 text-[11.5px] font-semibold tracking-[0.06em] text-[var(--color-ink-faint)] uppercase">
              Passaggi
            </h2>
            {tools.map((step, i) => {
              const ms = Math.max(0, (step.endedAt ?? endedAt) - step.startedAt);
              return (
                <div
                  key={step.key}
                  className={clsx(
                    'grid grid-cols-[22px_minmax(0,1fr)] gap-2 px-3.5 py-2.5',
                    i % 2 === 1 && 'bg-[var(--color-panel-alt)]',
                  )}
                >
                  {step.done ? (
                    step.error ? (
                      <X size={13} strokeWidth={3} className="mt-0.5 text-[var(--color-error)]" />
                    ) : (
                      <Check size={13} strokeWidth={3} className="mt-0.5 text-[var(--color-online)]" />
                    )
                  ) : (
                    <span className="mt-1.5 h-[7px] w-[7px] animate-pulse rounded-full bg-[var(--color-online)]" />
                  )}
                  <div className="min-w-0">
                    <div className="flex items-baseline gap-2">
                      <span className="font-mono text-[12px] font-medium text-[var(--color-honey)]">
                        {toolChipName(step.name)}
                      </span>
                      <span className="flex-1" />
                      <span className="font-mono text-[11.5px] text-[var(--color-ink-faint)] tabular-nums">
                        {shortDuration(ms)}
                      </span>
                    </div>
                    <p className="mt-0.5 font-mono text-[12px] break-all text-[var(--color-ink-soft)]">
                      {step.label}
                    </p>
                  </div>
                </div>
              );
            })}
          </section>
        )}

        {notes.length > 1 && (
          <section className="mt-3 rounded-[14px] bg-[var(--color-card)] p-3.5">
            <h2 className="mb-1.5 text-[11.5px] font-semibold tracking-[0.06em] text-[var(--color-ink-faint)] uppercase">
              Ragionamento
            </h2>
            <div className="flex flex-col gap-3">
              {notes.slice(1).map((n) => (
                <MessageBody key={n.key} body={n.text} className="msg-body-work" />
              ))}
            </div>
          </section>
        )}

        {steps.length === 0 && (
          <p className="mt-6 text-center text-[13.5px] text-[var(--color-ink-faint)]">
            Nessuna traccia per questo turno.
          </p>
        )}

        <button
          onClick={() => {
            navigate(`/c/${channelId}`);
            // Il canale si monta dopo: la messa a fuoco va rimandata di un giro.
            setTimeout(() => {
              const el = document.getElementById(`msg-${messageId}`);
              el?.scrollIntoView({ block: 'center' });
              el?.classList.add('flash-highlight');
              setTimeout(() => el?.classList.remove('flash-highlight'), 1200);
            }, 120);
          }}
          className="mt-4 flex h-11 w-full items-center justify-center rounded-[12px] bg-[var(--color-ink)] text-[15px] font-semibold text-[var(--color-panel)]"
        >
          Vai alla risposta
        </button>
      </div>
    </div>
  );
}
