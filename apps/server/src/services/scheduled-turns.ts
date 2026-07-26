import { and, asc, eq, isNull, lte } from 'drizzle-orm';
import { scheduleTurn as scheduleShared, type ScheduleArgs } from '@hive/db';
import { db, schema } from '../db/index.js';
import { enqueueRun } from './messages.js';

/** Le regole stanno in `@hive/db`: qui si passa solo la connessione. */
export function scheduleTurn(args: ScheduleArgs) {
  return scheduleShared(db, args);
}

/**
 * Turni che un agente si prenota per il futuro.
 *
 * Fino a ieri un agente poteva parlare solo se interpellato: il turno finiva
 * e con lui moriva tutto quello che aveva avviato, quindi «ti faccio sapere
 * quando è pronto» era una frase senza nessuno dietro. Qui la promessa
 * diventa una riga a database, e a mantenerla è il raccoglitore che gira già
 * ogni minuto.
 */

/**
 * Fa partire i risvegli scaduti.
 *
 * Lo chiama il raccoglitore, che gira già ogni minuto: non serve un altro
 * processo, e un processo in meno è un processo che non può morire in
 * silenzio — che è esattamente il guasto che questa funzione esiste per
 * evitare.
 */
export async function fireDueTurns(): Promise<number> {
  const due = await db
    .select()
    .from(schema.scheduledTurns)
    .where(
      and(
        isNull(schema.scheduledTurns.firedAt),
        isNull(schema.scheduledTurns.cancelledAt),
        lte(schema.scheduledTurns.runAt, new Date()),
      ),
    )
    .orderBy(asc(schema.scheduledTurns.runAt))
    .limit(20);

  let fired = 0;
  for (const row of due) {
    // Marcato PRIMA di partire: se l'enqueue esplode, il risveglio resta
    // bruciato invece di ripartire a ogni giro del raccoglitore per sempre.
    const claimed = await db
      .update(schema.scheduledTurns)
      .set({ firedAt: new Date() })
      .where(and(eq(schema.scheduledTurns.id, row.id), isNull(schema.scheduledTurns.firedAt)))
      .returning({ id: schema.scheduledTurns.id });
    if (claimed.length === 0) continue;

    try {
      await enqueueRun({
        workspaceId: row.workspaceId,
        agentId: row.agentId,
        channelId: row.channelId,
        triggerMessageId: null,
        prompt:
          `[risveglio programmato] Te l'eri prenotato tu. Nota che avevi lasciato:\n\n` +
          `${row.note}\n\n` +
          `Se non c'è niente da riferire, dillo in una riga: un risveglio a vuoto ` +
          `che produce un messaggio lungo è peggio del silenzio.`,
        hop: 0,
        fromAgentHandle: null,
        // Il risveglio eredita chi aveva iniziato: senza, la prenotazione
        // sarebbe un modo per far girare un agente su una macchina altrui
        // aggirando il controllo.
        triggeredByUserId: row.triggeredByUserId,
      });
      fired++;
    } catch (err) {
      console.error('[risvegli] avvio fallito:', (err as Error).message);
    }
  }
  return fired;
}

/** Le prenotazioni ancora in piedi, per mostrarle e per poterle annullare. */
export async function pendingTurns(channelId: string) {
  return db
    .select()
    .from(schema.scheduledTurns)
    .where(
      and(
        eq(schema.scheduledTurns.channelId, channelId),
        isNull(schema.scheduledTurns.firedAt),
        isNull(schema.scheduledTurns.cancelledAt),
      ),
    )
    .orderBy(asc(schema.scheduledTurns.runAt));
}

export async function cancelScheduled(id: string): Promise<boolean> {
  const rows = await db
    .update(schema.scheduledTurns)
    .set({ cancelledAt: new Date() })
    .where(and(eq(schema.scheduledTurns.id, id), isNull(schema.scheduledTurns.firedAt)))
    .returning({ id: schema.scheduledTurns.id });
  return rows.length > 0;
}

export type ScheduledTurn = typeof schema.scheduledTurns.$inferSelect;
