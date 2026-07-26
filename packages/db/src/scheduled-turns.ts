import { and, asc, eq, isNull } from 'drizzle-orm';
import type { Database } from './index.js';
import * as schema from './schema.js';

/**
 * Prenotare un turno futuro.
 *
 * Sta qui e non nel server perché serve a entrambi: il worker importa questo
 * modulo direttamente, e il runner locale ci arriva passando dal server. Le
 * regole di sicurezza — quanto in là, quanti pendenti, quanti risvegli di
 * fila — devono essere le stesse su tutte e due le strade, e l'unico modo
 * perché lo restino è che esistano in un posto solo.
 */

/** Sotto il minuto non è una prenotazione, è un ciclo. */
const MIN_DELAY_MIN = 1;
/** Oltre la settimana il contesto è vecchio: meglio che lo richieda un umano. */
const MAX_DELAY_MIN = 7 * 24 * 60;
/** Prenotazioni pendenti per agente e canale. */
const MAX_PENDING = 3;
/**
 * Risvegli consecutivi senza che nessuno abbia scritto in mezzo.
 *
 * È il freno contro l'agente che si riprenota all'infinito: cinque giri sono
 * abbastanza per seguire una build o un deploy, troppo pochi per lasciar
 * girare qualcosa che nessuno ha più chiesto.
 */
const MAX_DEPTH = 5;

export interface ScheduleArgs {
  workspaceId: string;
  channelId: string;
  agentId: string;
  inMinutes: number;
  note: string;
  /** Il turno che sta prenotando: serve a contare la catena di risvegli. */
  fromRunId?: string | null;
  /** Chi aveva iniziato: il risveglio eredita l'attribuzione, e i controlli. */
  triggeredByUserId?: string | null;
}

/**
 * Da quanti risvegli di fila viene questo turno.
 *
 * Se il turno che sta prenotando è nato a sua volta da un risveglio, la
 * catena continua; se l'ha innescato una persona, si riparte da zero. È il
 * conteggio che rende il freno onesto: parlare con qualcuno azzera il
 * sospetto di ciclo.
 */
async function chainDepth(db: Database, fromRunId: string | null | undefined): Promise<number> {
  if (!fromRunId) return 0;
  const rows = await db
    .select({ depth: schema.scheduledTurns.depth })
    .from(schema.scheduledTurns)
    .where(eq(schema.scheduledTurns.createdByRunId, fromRunId))
    .limit(1);
  // Nessuna riga: questo turno non è nato da un risveglio.
  return rows[0]?.depth ?? 0;
}

export async function scheduleTurn(db: Database, args: ScheduleArgs): Promise<{ id: string; runAt: Date }> {
  const minutes = Math.round(args.inMinutes);
  if (!Number.isFinite(minutes) || minutes < MIN_DELAY_MIN || minutes > MAX_DELAY_MIN) {
    throw new Error(`Il risveglio deve stare fra ${MIN_DELAY_MIN} minuto e 7 giorni.`,
    );
  }
  const note = args.note.trim();
  if (!note) throw new Error('Serve una nota: al risveglio è tutto ciò che avrai.');

  const pending = await db
    .select({ id: schema.scheduledTurns.id })
    .from(schema.scheduledTurns)
    .where(
      and(
        eq(schema.scheduledTurns.agentId, args.agentId),
        eq(schema.scheduledTurns.channelId, args.channelId),
        isNull(schema.scheduledTurns.firedAt),
        isNull(schema.scheduledTurns.cancelledAt),
      ),
    );
  if (pending.length >= MAX_PENDING) {
    throw new Error(`Hai già ${pending.length} risvegli prenotati in questo canale: annulla o aspetta.`,
    );
  }

  const depth = (await chainDepth(db, args.fromRunId)) + 1;
  if (depth > MAX_DEPTH) {
    throw new Error(`Sono ${MAX_DEPTH} risvegli di fila senza che nessuno abbia scritto. ` +
        `Se serve continuare, chiedilo a una persona.`,
    );
  }

  const runAt = new Date(Date.now() + minutes * 60_000);
  const inserted = await db
    .insert(schema.scheduledTurns)
    .values({
      workspaceId: args.workspaceId,
      channelId: args.channelId,
      agentId: args.agentId,
      runAt,
      note,
      depth,
      createdByRunId: args.fromRunId ?? null,
      triggeredByUserId: args.triggeredByUserId ?? null,
    })
    .returning({ id: schema.scheduledTurns.id });

  return { id: inserted[0]!.id, runAt };
}

