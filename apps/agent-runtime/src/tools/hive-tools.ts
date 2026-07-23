import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { and, desc, eq, ilike, isNull, or } from 'drizzle-orm';
import { schema } from '@hive/db';
import { db } from '../db.js';
import { decryptSecret } from '../crypto.js';
import type { RunEmitter } from '../emitter.js';
import { grantedHiveToolNames, toolById, type AgentToolGrant } from '@hive/shared';

/**
 * Tool custom di Hive, esposti all'agente come server MCP in-process.
 *
 * Girano dentro il processo del runtime, non in un sottoprocesso: hanno
 * quindi accesso diretto al database e ai segreti, che non escono mai verso
 * il modello. L'agente vede solo il risultato dell'operazione.
 */

export interface HiveToolContext {
  workspaceId: string;
  channelId: string;
  agentId: string;
  agentHandle: string;
  runId: string;
  grants: AgentToolGrant[];
  emitter: RunEmitter;
}

const ok = (text: string) => ({ content: [{ type: 'text' as const, text }] });
const fail = (text: string) => ({
  content: [{ type: 'text' as const, text }],
  isError: true,
});

/** Config del tool così come l'ha salvata chi ha creato l'agente. */
function configFor(ctx: HiveToolContext, toolId: string): Record<string, unknown> | null {
  const grant = ctx.grants.find((g) => g.toolId === toolId);
  return grant ? (grant.config ?? {}) : null;
}

async function workspaceSecret(workspaceId: string, key: string): Promise<string | null> {
  const rows = await db
    .select({ value: schema.workspaceSecrets.valueEncrypted })
    .from(schema.workspaceSecrets)
    .where(
      and(
        eq(schema.workspaceSecrets.workspaceId, workspaceId),
        eq(schema.workspaceSecrets.key, key),
      ),
    )
    .limit(1);
  const enc = rows[0]?.value;
  if (!enc) return null;
  try {
    return decryptSecret(enc);
  } catch {
    return null;
  }
}

/**
 * Costruisce le definizioni dei tool.
 *
 * Restituisce l'array grezzo invece del solo server MCP perché il runner
 * OpenRouter riusa le stesse identiche definizioni: legge `inputSchema` per
 * generare lo schema JSON e chiama `handler` direttamente. Un tool si scrive
 * una volta sola e funziona su entrambi gli harness.
 */
export function buildHiveTools(ctx: HiveToolContext) {
  // Nomi dei tool hive effettivamente concessi a questo agente.
  const granted = grantedHiveToolNames(ctx.grants);
  const tools = [];

  /* ------------------------------------------------ cerca nei messaggi */
  tools.push(
    tool(
      'search_messages',
      'Cerca nello storico delle conversazioni del progetto. Usalo quando ti serve ' +
        'ricostruire una decisione presa in passato o ritrovare un dettaglio già discusso.',
      {
        query: z.string().min(2).describe('Testo da cercare'),
        channel: z
          .string()
          .optional()
          .describe('Limita la ricerca a un canale, senza il cancelletto'),
        limit: z.number().int().min(1).max(30).default(10),
      },
      async ({ query, channel, limit }) => {
        const conditions = [
          eq(schema.channels.workspaceId, ctx.workspaceId),
          isNull(schema.messages.deletedAt),
          ilike(schema.messages.body, `%${query}%`),
        ];
        if (channel) conditions.push(eq(schema.channels.name, channel.replace(/^#/, '')));

        const rows = await db
          .select({
            body: schema.messages.body,
            createdAt: schema.messages.createdAt,
            channelName: schema.channels.name,
            authorType: schema.messages.authorType,
            authorId: schema.messages.authorId,
          })
          .from(schema.messages)
          .innerJoin(schema.channels, eq(schema.channels.id, schema.messages.channelId))
          .where(and(...conditions))
          .orderBy(desc(schema.messages.createdAt))
          .limit(limit);

        if (rows.length === 0) return ok(`Nessun risultato per "${query}".`);

        const lines = rows.map(
          (r) =>
            `[#${r.channelName} · ${r.createdAt.toISOString().slice(0, 16).replace('T', ' ')}] ` +
            r.body.slice(0, 300),
        );
        return ok(`${rows.length} risultati per "${query}":\n\n${lines.join('\n\n')}`);
      },
    ),
  );

  /* --------------------------------------------------- leggi un canale */
  tools.push(
    tool(
      'read_channel',
      'Legge i messaggi recenti di un canale del progetto, per farti il contesto ' +
        'di una conversazione a cui non stai partecipando.',
      {
        channel: z.string().describe('Nome del canale, senza il cancelletto'),
        limit: z.number().int().min(1).max(60).default(25),
      },
      async ({ channel, limit }) => {
        const chRows = await db
          .select({ id: schema.channels.id, topic: schema.channels.topic })
          .from(schema.channels)
          .where(
            and(
              eq(schema.channels.workspaceId, ctx.workspaceId),
              eq(schema.channels.name, channel.replace(/^#/, '')),
            ),
          )
          .limit(1);
        const ch = chRows[0];
        if (!ch) return fail(`Il canale #${channel} non esiste in questo progetto.`);

        const rows = await db
          .select()
          .from(schema.messages)
          .where(and(eq(schema.messages.channelId, ch.id), isNull(schema.messages.deletedAt)))
          .orderBy(desc(schema.messages.createdAt))
          .limit(limit);
        rows.reverse();

        if (rows.length === 0) return ok(`#${channel} è vuoto.`);
        const lines = rows
          .filter((r) => r.body.trim())
          .map((r) => `${r.authorType === 'agent' ? '[agente]' : '[utente]'} ${r.body.slice(0, 400)}`);
        return ok(`Ultimi messaggi di #${channel}:\n\n${lines.join('\n')}`);
      },
    ),
  );

  /* ------------------------------------------------- scrivi in un canale */
  tools.push(
    tool(
      'post_message',
      'Pubblica un messaggio in un altro canale del progetto. Non serve per ' +
        'rispondere qui: la tua risposta finale finisce già nel canale corrente.',
      {
        channel: z.string().describe('Canale di destinazione, senza il cancelletto'),
        body: z.string().min(1).max(8000),
      },
      async ({ channel, body }) => {
        const chRows = await db
          .select({ id: schema.channels.id })
          .from(schema.channels)
          .where(
            and(
              eq(schema.channels.workspaceId, ctx.workspaceId),
              eq(schema.channels.name, channel.replace(/^#/, '')),
            ),
          )
          .limit(1);
        const ch = chRows[0];
        if (!ch) return fail(`Il canale #${channel} non esiste.`);

        await db.insert(schema.messages).values({
          channelId: ch.id,
          authorType: 'agent',
          authorId: ctx.agentId,
          body,
          mentions: [],
          runId: ctx.runId,
        });
        return ok(`Messaggio pubblicato in #${channel}.`);
      },
    ),
  );

  /* ------------------------------------------- memoria di progetto (lettura) */
  tools.push(
    tool(
      'read_memory',
      'Legge il contesto condiviso del progetto: le note che tutti gli agenti vedono.',
      {},
      async () => {
        const rows = await db
          .select()
          .from(schema.workspaceContext)
          .where(eq(schema.workspaceContext.workspaceId, ctx.workspaceId))
          .limit(1);
        const row = rows[0];
        const parts = [row?.manualNotes, row?.autoSummary].filter(
          (p): p is string => Boolean(p?.trim()),
        );
        return ok(parts.length > 0 ? parts.join('\n\n---\n\n') : 'La memoria di progetto è vuota.');
      },
    ),
  );

  /* ------------------------------------------ memoria di progetto (scrittura) */
  tools.push(
    tool(
      'write_memory',
      'Aggiunge una nota alla memoria condivisa del progetto, visibile a tutti gli ' +
        'agenti nei turni futuri. Usalo per decisioni stabili e fatti duraturi, ' +
        'non per appunti temporanei.',
      {
        note: z.string().min(3).max(2000).describe('La nota da aggiungere'),
      },
      async ({ note }) => {
        const rows = await db
          .select()
          .from(schema.workspaceContext)
          .where(eq(schema.workspaceContext.workspaceId, ctx.workspaceId))
          .limit(1);
        const existing = rows[0]?.autoSummary ?? '';
        const stamp = new Date().toISOString().slice(0, 10);
        const line = `- [${stamp}, da @${ctx.agentHandle}] ${note.trim()}`;
        // Teniamo la memoria limitata: le note più vecchie escono in coda.
        const merged = [existing, line].filter(Boolean).join('\n').split('\n').slice(-120).join('\n');

        await db
          .insert(schema.workspaceContext)
          .values({
            workspaceId: ctx.workspaceId,
            autoSummary: merged,
            autoUpdatedAt: new Date(),
          })
          .onConflictDoUpdate({
            target: schema.workspaceContext.workspaceId,
            set: { autoSummary: merged, autoUpdatedAt: new Date() },
          });
        return ok('Nota aggiunta alla memoria di progetto.');
      },
    ),
  );

  /* ------------------------------------------------- passa a un altro agente */
  tools.push(
    tool(
      'handoff',
      "Affida il seguito del lavoro a un altro agente del progetto. Usalo solo " +
        'quando il compito è chiaramente di sua competenza, non per evitare di lavorare.',
      {
        agent: z.string().describe("Handle dell'agente, senza la chiocciola"),
        task: z.string().min(5).max(2000).describe('Cosa deve fare, in modo autosufficiente'),
      },
      async ({ agent, task }) => {
        const handle = agent.replace(/^@/, '').toLowerCase();
        const rows = await db
          .select({ id: schema.agents.id, name: schema.agents.name })
          .from(schema.agents)
          .where(
            and(
              eq(schema.agents.workspaceId, ctx.workspaceId),
              eq(schema.agents.handle, handle),
              isNull(schema.agents.archivedAt),
            ),
          )
          .limit(1);
        const target = rows[0];
        if (!target) return fail(`Non esiste un agente con handle @${handle}.`);
        if (target.id === ctx.agentId) return fail('Non puoi passare il lavoro a te stesso.');

        await ctx.emitter.event({ type: 'handoff', toAgentHandle: handle });
        // Il passaggio vero avviene a fine turno: il worker legge le menzioni
        // nella risposta e accoda il run, rispettando il limite di rimbalzi.
        return ok(
          `Ho segnalato il passaggio a ${target.name}. ` +
            `Includi <@${handle}> nella risposta finale così viene attivato, ` +
            `e riassumigli il compito: ${task.slice(0, 200)}`,
        );
      },
    ),
  );

  /* -------------------------------------------------------- chiamata HTTP */
  const httpConfig = configFor(ctx, 'http.request');
  if (httpConfig) {
    const allowedHosts = (httpConfig.allowedHosts as string[] | undefined) ?? [];
    const methods = (httpConfig.methods as string[] | undefined) ?? ['GET'];
    const credentialKey = (httpConfig.credentialKey as string | null) ?? null;
    const credentialHeader = (httpConfig.credentialHeader as string) ?? 'Authorization';
    const credentialPrefix = (httpConfig.credentialPrefix as string) ?? 'Bearer ';

    tools.push(
      tool(
        'http_request',
        `Chiama una API esterna. Host consentiti: ${allowedHosts.join(', ') || 'nessuno'}. ` +
          `Metodi: ${methods.join(', ')}. Le credenziali le aggiunge il server: non ` +
          'devi (e non puoi) vederle.',
        {
          url: z.string().url(),
          method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']).default('GET'),
          body: z.string().optional().describe('Corpo JSON come stringa'),
          headers: z.record(z.string(), z.string()).optional(),
        },
        async ({ url, method, body, headers }) => {
          if (!methods.includes(method)) {
            return fail(`Il metodo ${method} non è consentito a questo agente.`);
          }
          let parsed: URL;
          try {
            parsed = new URL(url);
          } catch {
            return fail('URL non valido.');
          }
          // Confronto sull'host esatto o su un sottodominio autorizzato.
          const allowed = allowedHosts.some(
            (h) => parsed.hostname === h || parsed.hostname.endsWith(`.${h}`),
          );
          if (!allowed) {
            return fail(
              `L'host ${parsed.hostname} non è fra quelli autorizzati (${allowedHosts.join(', ')}).`,
            );
          }

          const finalHeaders: Record<string, string> = {
            accept: 'application/json',
            ...(headers ?? {}),
          };
          if (body) finalHeaders['content-type'] ??= 'application/json';
          if (credentialKey) {
            const secret = await workspaceSecret(ctx.workspaceId, credentialKey);
            if (!secret) {
              return fail(
                `Manca il segreto ${credentialKey} nella configurazione del progetto.`,
              );
            }
            finalHeaders[credentialHeader] = `${credentialPrefix}${secret}`;
          }

          try {
            const res = await fetch(parsed.toString(), {
              method,
              headers: finalHeaders,
              body: body ?? undefined,
              signal: AbortSignal.timeout(30_000),
            });
            const text = await res.text();
            // Tronchiamo: una risposta enorme riempirebbe il contesto.
            const shown = text.length > 8000 ? `${text.slice(0, 8000)}\n…(troncato)` : text;
            return ok(`HTTP ${res.status} ${res.statusText}\n\n${shown}`);
          } catch (err) {
            return fail(
              `Chiamata fallita: ${err instanceof Error ? err.message : String(err)}`,
            );
          }
        },
      ),
    );
  }

  /* -------------------------------------------- azioni che richiedono conferma */
  // Questi tool esistono solo se concessi. L'esecuzione vera è gated da
  // `canUseTool`: quando l'agente li chiama, in chat compare una card.
  if (configFor(ctx, 'code.push')) {
    tools.push(
      tool(
        'git_push',
        'Pubblica il lavoro sul remoto. Ogni push richiede la conferma di una ' +
          'persona in chat: spiega bene cosa stai pubblicando.',
        {
          branch: z.string().min(1).describe('Branch di destinazione'),
          message: z.string().min(1).describe('Cosa contiene questo push'),
        },
        async ({ branch, message }) =>
          ok(
            `Push su ${branch} approvato ed eseguito.\n` +
              `Riepilogo: ${message}\n\n` +
              `(l'esecuzione del comando git avviene nel container del progetto)`,
          ),
      ),
    );
  }

  if (configFor(ctx, 'code.deploy')) {
    const deployConfig = configFor(ctx, 'code.deploy')!;
    tools.push(
      tool(
        'deploy',
        `Lancia il deploy su ${String(deployConfig.environment ?? 'production')}. ` +
          'Richiede sempre la conferma di una persona in chat.',
        { reason: z.string().min(3).describe('Perché stai facendo il deploy adesso') },
        async ({ reason }) =>
          ok(`Deploy approvato. Motivo registrato: ${reason}`),
      ),
    );
  }

  // Teniamo solo i tool che l'agente ha davvero ricevuto: così il modello
  // non vede (e non prova) quelli che gli sono negati.
  return tools.filter((t) => granted.has(t.name));
}

/** Impacchetta i tool come server MCP in-process per il Claude Agent SDK. */
export function buildHiveMcpServer(ctx: HiveToolContext) {
  return createSdkMcpServer({
    name: 'hive',
    version: '0.1.0',
    instructions:
      'Tool per interagire con il progetto Hive: conversazioni, memoria condivisa ' +
      'e integrazioni configurate dal team.',
    tools: buildHiveTools(ctx),
  });
}
