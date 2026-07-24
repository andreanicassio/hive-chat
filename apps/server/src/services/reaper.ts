import { and, eq, inArray, lt, isNotNull } from 'drizzle-orm';
import { db, schema } from '../db/index.js';
import { hub } from '../realtime/hub.js';
import { serializeMessage } from './serialize.js';
import { redisPub } from '../lib/redis.js';
import { flushPendingPrompts } from './messages.js';

/**
 * Raccoglitore dei turni rimasti appesi.
 *
 * Un run può bloccarsi per cause fuori dal nostro controllo: la macchina di
 * un runner che muore dopo aver preso il lavoro, un processo ucciso, una
 * conferma che nessuno decide. Senza questo, la bolla in chat resta a girare
 * per sempre e l'agente sembra morto.
 *
 * Le soglie sono larghe di proposito: i turni veri durano meno di un minuto e
 * l'SDK si interrompe da solo dopo 20, quindi qui interveniamo solo su casi
 * che sono senza dubbio morti.
 */

const CHECK_EVERY_MS = 60_000;

/** Minuti oltre i quali un run in un certo stato è considerato perso. */
const LIMITS = {
  /** In coda: nessuna macchina l'ha raccolto. */
  queued: 10,
  /** In esecuzione: oltre il timeout di 20 minuti dell'SDK. */
  running: 25,
  /** In attesa di conferma: le approvazioni scadono a 30 minuti. */
  awaiting_approval: 35,
} as const;

const NOTES: Record<keyof typeof LIMITS, string> = {
  queued:
    '_Nessuna macchina ha raccolto questo turno. Se l’agente gira su un runner, ' +
    'controlla che sia acceso e riprova._',
  running:
    '_Questo turno si è interrotto senza completarsi: la macchina che lo stava ' +
    'eseguendo non ha più dato segno di vita. Riprova._',
  awaiting_approval:
    '_Nessuno ha confermato l’azione richiesta entro il tempo previsto, quindi il ' +
    'turno è stato chiuso. Riprova quando puoi seguirlo._',
};

async function reapState(state: keyof typeof LIMITS): Promise<number> {
  const cutoff = new Date(Date.now() - LIMITS[state] * 60_000);
  const stale = await db
    .select()
    .from(schema.agentRuns)
    .where(
      and(
        eq(schema.agentRuns.status, state),
        lt(schema.agentRuns.queuedAt, cutoff),
        isNotNull(schema.agentRuns.responseMessageId),
      ),
    )
    .limit(50);
  if (stale.length === 0) return 0;

  const ids = stale.map((r) => r.id);
  await db
    .update(schema.agentRuns)
    .set({ status: 'error', error: `abbandonato in stato ${state}`, endedAt: new Date() })
    .where(inArray(schema.agentRuns.id, ids));

  for (const run of stale) {
    const messageId = run.responseMessageId!;
    // Sostituiamo la bolla vuota con una spiegazione, invece di lasciarla
    // girare all'infinito.
    await db
      .update(schema.messages)
      .set({ body: NOTES[state] })
      .where(eq(schema.messages.id, messageId));

    const rows = await db
      .select()
      .from(schema.messages)
      .where(eq(schema.messages.id, messageId))
      .limit(1);
    if (rows[0]) {
      const message = await serializeMessage(rows[0], null);
      await hub.publish(run.workspaceId, {
        packet: { t: 'message.updated', message },
        channelId: run.channelId,
      });
    }
    await hub.publish(run.workspaceId, {
      packet: {
        t: 'run.status',
        runId: run.id,
        messageId,
        status: 'error',
        error: 'turno abbandonato',
      },
      channelId: run.channelId,
    });
    // L'agente potrebbe essere rimasto marcato "al lavoro".
    await db
      .update(schema.agents)
      .set({ status: 'idle', statusLabel: null })
      .where(eq(schema.agents.id, run.agentId));
  }
  return stale.length;
}

/** Code di messaggi rimaste in attesa senza più un turno attivo. */
async function sweepPendingQueues(): Promise<void> {
  const keys = await redisPub.keys('hive:pending:*');
  for (const key of keys) {
    const [, , agentId, channelId] = key.split(':');
    if (!agentId || !channelId) continue;
    const active = await db
      .select({ id: schema.agentRuns.id })
      .from(schema.agentRuns)
      .where(
        and(
          eq(schema.agentRuns.agentId, agentId),
          eq(schema.agentRuns.channelId, channelId),
          inArray(schema.agentRuns.status, ['queued', 'running', 'awaiting_approval']),
        ),
      )
      .limit(1);
    if (active.length === 0) await flushPendingPrompts(agentId, channelId).catch(() => {});
  }
}

export function startRunReaper(): void {
  const tick = async () => {
    try {
      let total = 0;
      for (const state of ['queued', 'running', 'awaiting_approval'] as const) {
        total += await reapState(state);
      }
      if (total > 0) console.log(`[reaper] chiusi ${total} turni rimasti appesi`);
      // Rete di sicurezza: se un segnale di fine si è perso, i messaggi in
      // coda ripartono comunque entro un minuto invece di restare fermi.
      await sweepPendingQueues();
    } catch (err) {
      console.error('[reaper] giro fallito:', (err as Error).message);
    }
  };
  // Un primo giro all'avvio ripulisce ciò che è rimasto da un riavvio brusco.
  void tick();
  const timer = setInterval(() => void tick(), CHECK_EVERY_MS);
  timer.unref();
}
