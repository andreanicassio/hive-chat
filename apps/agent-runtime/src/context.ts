import { and, desc, eq, isNull, ne } from 'drizzle-orm';
import { schema } from '@hive/db';
import { db } from './db.js';
import { toPlainText } from '@hive/shared';

/**
 * Costruzione del contesto che un agente vede a ogni turno.
 *
 * Tre livelli, dal generale al puntuale:
 *   1. chi è e cosa deve fare (identità dell'agente)
 *   2. dov'è (progetto, contesto condiviso, colleghi umani e artificiali)
 *   3. cosa sta succedendo adesso (ultimi messaggi del canale)
 *
 * Il livello 2 è il "contesto base condiviso" fra tutti gli agenti del
 * progetto: nessuno deve configurarlo a mano, si compone da solo dai dati
 * del workspace più le note che un admin decide di fissare.
 */

export interface AgentContext {
  systemPrompt: string;
  /** Prompt del turno, già leggibile (menzioni risolte in nomi). */
  prompt: string;
  /** Handle → id, per capire a chi passare la palla. */
  agentHandles: Map<string, string>;
}

const HISTORY_LIMIT = 40;

export async function buildContext(args: {
  workspaceId: string;
  channelId: string;
  agentId: string;
  triggerMessageId: string | null;
  rawPrompt: string;
  fromAgentHandle: string | null;
}): Promise<AgentContext> {
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

  // Elenco canali, per orientarsi e per sapere dove può scrivere.
  const channels = await db
    .select({ name: schema.channels.name, topic: schema.channels.topic })
    .from(schema.channels)
    .where(
      and(eq(schema.channels.workspaceId, args.workspaceId), isNull(schema.channels.archivedAt)),
    );

  // Storico recente del canale, in ordine cronologico.
  const historyRows = await db
    .select()
    .from(schema.messages)
    .where(and(eq(schema.messages.channelId, args.channelId), isNull(schema.messages.deletedAt)))
    .orderBy(desc(schema.messages.createdAt))
    .limit(HISTORY_LIMIT);
  historyRows.reverse();

  const userByHandle = new Map(memberRows.map((m) => [m.handle, m.name]));
  const agentByHandle = new Map(agentRoster.map((a) => [a.handle, a.name]));
  agentByHandle.set(agent.handle, agent.name);

  const resolve = (kind: 'user' | 'channel', handle: string): string | null => {
    if (kind === 'channel') return `#${handle}`;
    const name = agentByHandle.get(handle) ?? userByHandle.get(handle);
    return name ? `@${name}` : null;
  };

  // Nomi degli autori dello storico.
  const authorIds = historyRows.map((m) => ({ type: m.authorType, id: m.authorId }));
  const nameById = new Map<string, string>();
  for (const m of memberRows) nameById.set(`user:${m.handle}`, m.name);
  const userIdRows = await db
    .select({ id: schema.users.id, name: schema.users.name })
    .from(schema.users);
  for (const u of userIdRows) nameById.set(`user:${u.id}`, u.name);
  for (const a of agentRoster) nameById.set(`agent:${a.id}`, a.name);
  nameById.set(`agent:${agent.id}`, agent.name);

  const transcript = historyRows
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

  if (agent.purpose) {
    sections.push(`\n## Il tuo compito\n${agent.purpose}`);
  }
  if (agent.systemPrompt) {
    sections.push(`\n## Istruzioni specifiche\n${agent.systemPrompt}`);
  }

  sections.push(
    `\n## Dove ti trovi`,
    `Progetto: ${workspace?.name ?? 'senza nome'}`,
    `Canale corrente: #${channel?.name ?? '?'}${channel?.topic ? ` — ${channel.topic}` : ''}`,
  );
  if (channel?.purpose) sections.push(`Scopo del canale: ${channel.purpose}`);

  if (channelList) sections.push(`\n### Canali del progetto\n${channelList}`);

  // Il contesto condiviso: prima le note fissate a mano, poi il riassunto
  // generato. Le note manuali hanno la precedenza perché sono decisioni,
  // non osservazioni.
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

  if (transcript) {
    sections.push(
      `\n## Conversazione recente in #${channel?.name ?? '?'}`,
      transcript,
    );
  }

  if (args.fromAgentHandle) {
    sections.push(
      `\n## Nota\nQuesto turno nasce da un passaggio di consegne da un altro agente. ` +
        `Non rimbalzare il lavoro indietro senza aver fatto la tua parte.`,
    );
  }

  const grants = (agent.tools as Array<{ toolId: string }> | null) ?? [];
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
