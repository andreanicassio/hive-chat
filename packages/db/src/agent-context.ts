import { and, desc, eq, isNull, ne } from 'drizzle-orm';
import { toPlainText } from '@hive/shared';
import * as schema from './schema.js';
import { renderDocumentTree } from './documents-index.js';
import { channelAttachments, describeAttachments } from './attachments.js';
import type { Database } from './index.js';

/**
 * Costruzione del contesto che un agente vede a ogni turno — condivisa fra il
 * worker del server e i runner. Prende il `db` come parametro così può girare
 * ovunque ci sia una connessione (server o runtime agenti).
 */

export interface AgentContext {
  systemPrompt: string;
  prompt: string;
  agentHandles: Map<string, string>;
}

const HISTORY_LIMIT = 40;

/**
 * Quante righe di canale dare come sfondo quando il turno vive in un thread.
 * Un thread nasce quasi sempre da qualcosa detto poco prima nel canale: senza
 * quelle righe i riferimenti («come dicevo sopra») restano appesi. Poche, però:
 * la conversazione vera è il thread.
 */
const THREAD_BACKGROUND_LIMIT = 10;

export async function buildAgentContext(
  db: Database,
  args: {
    workspaceId: string;
    channelId: string;
    agentId: string;
    triggerMessageId: string | null;
    /** Thread in cui si svolge il turno, `null` se si parla nel canale. */
    threadRootId: string | null;
    rawPrompt: string;
    fromAgentHandle: string | null;
  },
): Promise<AgentContext> {
  const [agentRows, wsRows, ctxRows, channelRows, agentRoster, memberRows] = await Promise.all([
    db.select().from(schema.agents).where(eq(schema.agents.id, args.agentId)).limit(1),
    db.select().from(schema.workspaces).where(eq(schema.workspaces.id, args.workspaceId)).limit(1),
    db
      .select()
      .from(schema.workspaceContext)
      .where(eq(schema.workspaceContext.workspaceId, args.workspaceId))
      .limit(1),
    db.select().from(schema.channels).where(eq(schema.channels.id, args.channelId)).limit(1),
    db
      .select({
        id: schema.agents.id,
        handle: schema.agents.handle,
        name: schema.agents.name,
        description: schema.agents.description,
        kind: schema.agents.kind,
      })
      .from(schema.agents)
      .where(
        and(
          eq(schema.agents.workspaceId, args.workspaceId),
          isNull(schema.agents.archivedAt),
          ne(schema.agents.id, args.agentId),
        ),
      ),
    db
      .select({ name: schema.users.name, handle: schema.users.handle })
      .from(schema.workspaceMembers)
      .innerJoin(schema.users, eq(schema.users.id, schema.workspaceMembers.userId))
      .where(eq(schema.workspaceMembers.workspaceId, args.workspaceId)),
  ]);

  const agent = agentRows[0];
  if (!agent) throw new Error('agente non trovato');
  const workspace = wsRows[0];
  const channel = channelRows[0];
  const wsContext = ctxRows[0];

  const channels = await db
    .select({ name: schema.channels.name, topic: schema.channels.topic })
    .from(schema.channels)
    .where(
      and(eq(schema.channels.workspaceId, args.workspaceId), isNull(schema.channels.archivedAt)),
    );

  const inThread = Boolean(args.threadRootId);

  // Il canale mostra solo le radici: le risposte dei thread stanno in un filo
  // loro, e mescolarle qui produceva una trascrizione dove discorsi diversi si
  // accavallavano riga per riga.
  const channelHistory = await db
    .select()
    .from(schema.messages)
    .where(
      and(
        eq(schema.messages.channelId, args.channelId),
        isNull(schema.messages.deletedAt),
        isNull(schema.messages.threadRootId),
      ),
    )
    .orderBy(desc(schema.messages.createdAt))
    .limit(inThread ? THREAD_BACKGROUND_LIMIT : HISTORY_LIMIT);
  channelHistory.reverse();

  // Dentro un thread la conversazione è la radice più le sue risposte.
  let threadHistory: typeof channelHistory = [];
  if (args.threadRootId) {
    const [rootRows, replyRows] = await Promise.all([
      db
        .select()
        .from(schema.messages)
        .where(eq(schema.messages.id, args.threadRootId))
        .limit(1),
      db
        .select()
        .from(schema.messages)
        .where(
          and(
            eq(schema.messages.threadRootId, args.threadRootId),
            isNull(schema.messages.deletedAt),
          ),
        )
        .orderBy(desc(schema.messages.createdAt))
        .limit(HISTORY_LIMIT),
    ]);
    replyRows.reverse();
    threadHistory = [...rootRows.filter((r) => !r.deletedAt), ...replyRows];
  }

  const userByHandle = new Map(memberRows.map((m) => [m.handle, m.name]));
  const agentByHandle = new Map(agentRoster.map((a) => [a.handle, a.name]));
  agentByHandle.set(agent.handle, agent.name);

  const resolve = (kind: 'user' | 'channel', handle: string): string | null => {
    if (kind === 'channel') return `#${handle}`;
    const name = agentByHandle.get(handle) ?? userByHandle.get(handle);
    return name ? `@${name}` : null;
  };

  const nameById = new Map<string, string>();
  for (const m of memberRows) nameById.set(`user:${m.handle}`, m.name);
  const userIdRows = await db
    .select({ id: schema.users.id, name: schema.users.name })
    .from(schema.users);
  for (const u of userIdRows) nameById.set(`user:${u.id}`, u.name);
  for (const a of agentRoster) nameById.set(`agent:${a.id}`, a.name);
  nameById.set(`agent:${agent.id}`, agent.name);

  const renderTranscript = (rows: typeof channelHistory): string =>
    rows
      .filter((m) => m.body.trim().length > 0)
      .map((m) => {
        const who =
          m.authorType === 'system'
            ? 'Sistema'
            : (nameById.get(`${m.authorType}:${m.authorId}`) ?? 'Sconosciuto');
        const marker = m.authorType === 'agent' ? ' (agente)' : '';
        return `${who}${marker}: ${toPlainText(m.body, resolve)}`;
      })
      .join('\n');

  const channelTranscript = renderTranscript(channelHistory);
  const threadTranscript = renderTranscript(threadHistory);

  const roster = agentRoster
    .map(
      (a) =>
        `- @${a.handle} — ${a.name}${a.description ? `: ${a.description}` : ''} ` +
        `[${a.kind === 'developer' ? 'sviluppatore' : 'assistente'}]`,
    )
    .join('\n');

  const channelList = channels
    .map((c) => `- #${c.name}${c.topic ? ` — ${c.topic}` : ''}`)
    .join('\n');

  const sections: string[] = [];

  sections.push(
    `Sei ${agent.name}, un agente che lavora dentro Hive, una chat di squadra.`,
    `Il tuo handle è @${agent.handle}: gli altri ti chiamano taggandoti così.`,
  );

  if (agent.purpose) sections.push(`\n## Il tuo compito\n${agent.purpose}`);
  if (agent.systemPrompt) sections.push(`\n## Istruzioni specifiche\n${agent.systemPrompt}`);

  sections.push(
    `\n## Dove ti trovi`,
    `Progetto: ${workspace?.name ?? 'senza nome'}`,
    `Canale corrente: #${channel?.name ?? '?'}${channel?.topic ? ` — ${channel.topic}` : ''}`,
  );
  if (channel?.purpose) sections.push(`Scopo del canale: ${channel.purpose}`);
  if (channelList) sections.push(`\n### Canali del progetto\n${channelList}`);

  const contextParts: string[] = [];
  if (wsContext?.manualNotes?.trim()) contextParts.push(wsContext.manualNotes.trim());
  if (wsContext?.autoSummary?.trim()) contextParts.push(wsContext.autoSummary.trim());
  if (contextParts.length > 0) {
    sections.push(`\n## Contesto condiviso del progetto\n${contextParts.join('\n\n')}`);
  }

  if (roster) {
    sections.push(
      `\n### Altri agenti del progetto\n${roster}`,
      `Puoi passare il lavoro a uno di loro taggandolo nella tua risposta, ` +
        `ma fallo solo se il compito è chiaramente di sua competenza.`,
    );
  }

  if (channelTranscript) {
    sections.push(
      inThread
        ? `\n## Sfondo: ultimi messaggi nel canale #${channel?.name ?? '?'} (fuori dal thread)`
        : `\n## Conversazione recente in #${channel?.name ?? '?'}`,
      channelTranscript,
    );
  }

  if (threadTranscript) {
    sections.push(
      `\n## Il thread in cui stai rispondendo`,
      `La prima riga è il messaggio che ha aperto il thread, poi le risposte.`,
      threadTranscript,
      `La tua risposta finisce dentro questo thread, non nel canale: sta su questo ` +
        `discorso, il resto del canale è solo sfondo.`,
    );
  }

  if (args.fromAgentHandle) {
    sections.push(
      `\n## Nota\nQuesto turno nasce da un passaggio di consegne da un altro agente. ` +
        `Non rimbalzare il lavoro indietro senza aver fatto la tua parte.`,
    );
  }

  const grants = (agent.tools as Array<{ toolId: string }> | null) ?? [];

  // Indice dei Documenti del progetto: solo l'albero (percorsi + descrizioni),
  // MAI il contenuto — l'agente apre i file on-demand con read_document.
  if (grants.some((g) => g.toolId === 'hive.documents')) {
    const docs = await db
      .select({
        id: schema.documents.id,
        parentId: schema.documents.parentId,
        kind: schema.documents.kind,
        name: schema.documents.name,
        description: schema.documents.description,
        mime: schema.documents.mime,
      })
      .from(schema.documents)
      .where(eq(schema.documents.workspaceId, args.workspaceId))
      .limit(1000);
    const tree = renderDocumentTree(docs);
    if (tree) {
      sections.push(
        `\n## Documenti del progetto`,
        `Questa è la base di conoscenza del progetto. Qui sotto vedi solo l'INDICE: ` +
          `apri un file quando ti serve con \`read_document(percorso)\` — non serve (e non ` +
          `puoi) tenere tutto in testa. Per aggiungere o aggiornare una nota usa ` +
          `\`write_document(percorso, contenuto)\`; per rivedere l'elenco aggiornato ` +
          `\`list_documents\`.\n\n${tree}`,
      );
    } else {
      sections.push(
        `\n## Documenti del progetto`,
        `La base di conoscenza è vuota. Se produci qualcosa che vale la pena conservare ` +
          `(specifiche, decisioni, guide), salvalo con \`write_document(percorso, contenuto)\`.`,
      );
    }
  }

  if (grants.some((g) => g.toolId === 'hive.artifacts')) {
    sections.push(
      `\n## Checklist e documenti`,
      `Hai gli strumenti per creare e aggiornare checklist (to-do) e documenti che ` +
        `compaiono nel pannello accanto alla chat. Quando ti chiedono una to-do, una ` +
        `lista di task, un piano o un documento condiviso, USA questi strumenti ` +
        `(create_artifact, add_checklist_item, check_item, update_artifact) invece di ` +
        `scrivere la lista dentro il messaggio. Mentre lavori, spunta le voci man mano ` +
        `con check_item, così il team vede i progressi in tempo reale. Prima di ` +
        `modificarne uno esistente usa list_artifacts per prendere gli id giusti. ` +
        `Nel messaggio di chat scrivi solo una riga di conferma, non ricopiare la lista.`,
    );
  }

  // File condivisi in chat: l'agente deve sapere che ci sono e dove stanno.
  const attachments = await channelAttachments(db, args.channelId);
  if (attachments.length > 0) sections.push(describeAttachments(attachments));

  sections.push(
    `\n## Come rispondere`,
    `- Vai al punto, niente preamboli.`,
    `- Rispondi nella lingua di chi ti ha scritto.`,
    `- Se ti mancano informazioni per procedere, chiedile invece di inventarle.`,
    `- Usa il markdown per liste e codice, ma senza appesantire.`,
  );

  return {
    systemPrompt: sections.join('\n'),
    prompt: toPlainText(args.rawPrompt, resolve),
    agentHandles: new Map(agentRoster.map((a) => [a.handle, a.id])),
  };
}
