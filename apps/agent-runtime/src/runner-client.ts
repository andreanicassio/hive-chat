import { query, createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import type { Options, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hostname } from 'node:os';
import { z } from 'zod';
import {
  dangerousToolNames,
  grantedHiveToolNames,
  type AgentToolGrant,
  type EffortLevel,
} from '@hive/shared';
import { toAnthropicModelId } from './models.js';
import { RemoteEmitter } from './remote-emitter.js';

/**
 * Runner LOCALE a token.
 *
 * Gira sul computer di una persona: si autentica col token via HTTPS, fa il
 * poll dei turni dal server, esegue Claude Code IN LOCALE (sul codice e con le
 * credenziali di quella macchina) e ristreamma gli eventi al server. Non tocca
 * mai il database né i segreti del server — per questo qui non importiamo nulla
 * che dipenda dal DB.
 */

interface Config {
  serverUrl: string;
  token: string;
  workdir: string;
  name: string;
}

function readConfig(): Config {
  const serverUrl = (process.env.HIVE_SERVER_URL ?? '').replace(/\/+$/, '');
  const token = process.env.HIVE_RUNNER_TOKEN ?? '';
  const workdir = process.env.HIVE_RUNNER_WORKDIR ?? process.cwd();
  const name = process.env.HIVE_RUNNER_NAME || 'runner';
  if (!serverUrl) throw new Error('HIVE_SERVER_URL non impostato');
  if (!token.startsWith('hrt_')) throw new Error('HIVE_RUNNER_TOKEN non valido');
  return { serverUrl, token, workdir, name };
}

/** Credenziali Claude LOCALI: token d'ambiente, o il file ~/.claude via CLI. */
function localAuthEnv(): Record<string, string> {
  if (process.env.CLAUDE_CODE_OAUTH_TOKEN)
    return { CLAUDE_CODE_OAUTH_TOKEN: process.env.CLAUDE_CODE_OAUTH_TOKEN };
  if (process.env.ANTHROPIC_API_KEY)
    return { ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY };
  return {}; // la CLI legge ~/.claude/.credentials.json da sola
}

/* --- traduzione eventi SDK → etichette leggibili (come nel runtime server) --- */
function describeTool(name: string, input: unknown): string {
  const i = (input ?? {}) as Record<string, unknown>;
  const path = typeof i.file_path === 'string' ? basename(i.file_path) : null;
  switch (name) {
    case 'Read':
      return path ? `Legge ${path}` : 'Legge un file';
    case 'Write':
      return path ? `Scrive ${path}` : 'Scrive un file';
    case 'Edit':
      return path ? `Modifica ${path}` : 'Modifica un file';
    case 'Bash': {
      const cmd = typeof i.command === 'string' ? i.command : '';
      return cmd ? `Esegue \`${cmd.slice(0, 70)}\`` : 'Esegue un comando';
    }
    case 'Glob':
      return `Cerca file ${typeof i.pattern === 'string' ? `(${i.pattern})` : ''}`.trim();
    case 'Grep':
      return `Cerca nel codice ${typeof i.pattern === 'string' ? `"${String(i.pattern).slice(0, 40)}"` : ''}`.trim();
    case 'WebSearch':
      return `Cerca sul web${typeof i.query === 'string' ? `: ${i.query.slice(0, 50)}` : ''}`;
    case 'WebFetch':
      return `Apre ${typeof i.url === 'string' ? String(i.url).slice(0, 60) : 'una pagina'}`;
    case 'TodoWrite':
      return 'Aggiorna il piano di lavoro';
    default:
      return `Usa ${name}`;
  }
}

function summarizeResult(content: unknown): string {
  const text =
    typeof content === 'string'
      ? content
      : Array.isArray(content)
        ? content
            .map((c) =>
              typeof c === 'object' && c && 'text' in c ? String((c as { text: unknown }).text) : '',
            )
            .join('\n')
        : '';
  const trimmed = text.trim();
  if (!trimmed) return 'fatto';
  const lines = trimmed.split('\n');
  const first = lines[0]!.slice(0, 120);
  return lines.length > 1 ? `${first} (+${lines.length - 1} righe)` : first;
}

/** Titolo + dettaglio della card di conferma. */
function describeApproval(name: string, input: unknown): { title: string; detail: string } {
  const i = (input ?? {}) as Record<string, unknown>;
  if (name === 'Bash') {
    const cmd = typeof i.command === 'string' ? i.command : JSON.stringify(i);
    return { title: 'Vuole eseguire un comando', detail: cmd };
  }
  if (name === 'Write' || name === 'Edit' || name === 'MultiEdit') {
    const p = typeof i.file_path === 'string' ? basename(i.file_path) : 'un file';
    return { title: `Vuole modificare ${p}`, detail: JSON.stringify(input, null, 2).slice(0, 4000) };
  }
  return { title: `Vuole usare ${name}`, detail: JSON.stringify(input, null, 2).slice(0, 4000) };
}

/** Chiede conferma inline in chat al server e aspetta la decisione. */
async function askApproval(
  cfg: Config,
  runId: string,
  toolName: string,
  title: string,
  detail: string,
  input: unknown,
): Promise<{ allowed: boolean; reason: string | null }> {
  const headers = { 'content-type': 'application/json', authorization: `Bearer ${cfg.token}` };
  try {
    const res = await fetch(`${cfg.serverUrl}/api/runner/approval`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ runId, toolName, title, detail, input }),
    });
    if (!res.ok) return { allowed: false, reason: 'approvazione non disponibile' };
    const { approvalId } = (await res.json()) as { approvalId: string };
    // Long-poll finché qualcuno decide in chat.
    for (;;) {
      const p = await fetch(`${cfg.serverUrl}/api/runner/approval/${approvalId}`, { headers });
      if (!p.ok) return { allowed: false, reason: 'errore approvazione' };
      const d = (await p.json()) as { decided: boolean; allowed?: boolean; reason?: string | null };
      if (d.decided) return { allowed: Boolean(d.allowed), reason: d.reason ?? null };
    }
  } catch {
    return { allowed: false, reason: 'errore di rete durante l’approvazione' };
  }
}

/**
 * Tool hive proxati sul server via HTTPS col token.
 *
 * Il runner non ha il DB: gli strumenti "hive" (per ora i Documenti, la base
 * di conoscenza del progetto) chiamano gli endpoint del server, che eseguono
 * l'operazione col contesto del run. Così l'agente locale ha gli stessi tool
 * di quello sul server.
 */
function buildHiveProxyServer(cfg: Config, runId: string, grants: AgentToolGrant[]) {
  const granted = grantedHiveToolNames(grants);
  const headers = { 'content-type': 'application/json', authorization: `Bearer ${cfg.token}` };
  const ok = (text: string) => ({ content: [{ type: 'text' as const, text }] });
  const call = async (op: string, body: Record<string, unknown>): Promise<string> => {
    try {
      const res = await fetch(`${cfg.serverUrl}/api/runner/documents/${op}`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ runId, ...body }),
      });
      if (!res.ok) return `Operazione non riuscita (HTTP ${res.status}).`;
      return (await res.json()) as never;
    } catch {
      return 'Errore di rete verso il server.';
    }
  };

  const tools = [];
  if (granted.has('list_documents')) {
    tools.push(
      tool(
        'list_documents',
        'Elenca la base di conoscenza del progetto: cartelle e file (note markdown, PDF ' +
          'caricati). Mostra solo l’indice — apri i file con read_document.',
        {},
        async () => {
          const r = (await call('list', {})) as unknown as { tree?: string } | string;
          const tree = typeof r === 'object' ? r.tree : r;
          return ok(tree ? `Documenti del progetto:\n\n${tree}` : 'Nessun documento ancora.');
        },
      ),
    );
  }
  if (granted.has('read_document')) {
    tools.push(
      tool(
        'read_document',
        'Apre un documento del progetto e ne restituisce il contenuto (per i PDF, il testo ' +
          'estratto). Percorso come in list_documents, es. "specs/auth.md".',
        { path: z.string().min(1).describe('Percorso del file') },
        async ({ path }) => {
          const r = (await call('read', { path })) as unknown as { text?: string } | string;
          return ok(typeof r === 'object' ? (r.text ?? '') : r);
        },
      ),
    );
  }
  if (granted.has('write_document')) {
    tools.push(
      tool(
        'write_document',
        'Crea o aggiorna una nota di progetto (markdown), creando le cartelle mancanti. Per ' +
          'conservare specifiche, decisioni, guide: restano nell’indice visibile a tutti gli agenti.',
        {
          path: z.string().min(1).describe('Percorso del file, es. specs/auth.md'),
          content: z.string().max(200_000).describe('Contenuto markdown completo'),
          description: z.string().max(300).optional().describe('Riga di sintesi per l’indice'),
        },
        async ({ path, content, description }) => {
          const r = (await call('write', { path, content, description })) as unknown as
            | { text?: string }
            | string;
          return ok(typeof r === 'object' ? (r.text ?? 'Fatto.') : r);
        },
      ),
    );
  }
  if (tools.length === 0) return null;
  return createSdkMcpServer({ name: 'hive', version: '0.1.0', tools });
}

interface PollAttachment {
  id: string;
  filename: string;
  mime: string;
  size: number;
  /** Dove va scritto, relativo alla cartella di lavoro. */
  relPath: string;
}

interface PollResult {
  job: { runId: string; workspaceId: string; channelId: string; agentId: string };
  agent: Record<string, unknown>;
  context: { systemPrompt: string; prompt: string };
  attachments?: PollAttachment[];
  resumeSessionId: string | null;
}

/**
 * Porta nella cartella di lavoro i file condivisi nel canale.
 *
 * Sul server lo fa il worker copiandoli da disco; qui siamo su un'altra
 * macchina, quindi li scarichiamo via HTTPS. Va fatto PRIMA di far partire il
 * turno: il contesto dice all'agente che i file sono già lì, e se non ci sono
 * l'agente prova ad aprirli, fallisce, e riporta un errore che sembra suo.
 */
async function downloadAttachments(
  cfg: Config,
  runId: string,
  items: PollAttachment[],
): Promise<number> {
  let done = 0;
  for (const item of items) {
    const dest = join(cfg.workdir, item.relPath);
    try {
      const res = await fetch(
        `${cfg.serverUrl}/api/runner/files/${item.id}?runId=${encodeURIComponent(runId)}`,
        { headers: { authorization: `Bearer ${cfg.token}` } },
      );
      if (!res.ok) continue;
      await mkdir(dirname(dest), { recursive: true });
      await writeFile(dest, Buffer.from(await res.arrayBuffer()));
      done++;
    } catch {
      // Un allegato che non arriva non deve far saltare il turno: l'agente
      // se ne accorgerà aprendo il file, ed è comunque meglio che non partire.
    }
  }
  return done;
}

async function runOne(cfg: Config, data: PollResult): Promise<void> {
  const { job, agent, context, resumeSessionId } = data;
  const emitter = new RemoteEmitter(cfg.serverUrl, cfg.token, job.runId);
  const grants = (agent.tools as AgentToolGrant[]) ?? [];
  const kind = (agent.kind as 'assistant' | 'developer') ?? 'developer';
  const { model } = toAnthropicModelId(String(agent.model));

  await mkdir(cfg.workdir, { recursive: true });
  await emitter.markStarted();

  if (data.attachments?.length) {
    const n = await downloadAttachments(cfg, job.runId, data.attachments);
    if (n > 0) console.log(`[runner] ${n} allegat${n === 1 ? 'o' : 'i'} pronti per l'agente`);
  }

  // Piena capacità di Claude Code: l'agente gira SUL computer dell'utente, nel
  // suo perimetro di fiducia — non limitiamo gli strumenti. Le sole azioni che
  // chiedono conferma inline in chat sono quelle che l'agente ha marcato come
  // "richiede approvazione".
  // In `bypass` l'agente ha autonomia totale: non chiediamo mai conferma
  // (come `claude --dangerously-skip-permissions`). Altrimenti chiedono
  // conferma solo gli strumenti marcati "richiede approvazione".
  const bypass = agent.permissionMode === 'bypass';
  const needApproval = bypass ? new Set<string>() : dangerousToolNames(grants);

  // Tool hive proxati (Documenti): l'agente locale li usa via HTTPS sul server.
  const hiveServer = buildHiveProxyServer(cfg, job.runId, grants);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20 * 60_000);

  const options: Options = {
    cwd: cfg.workdir,
    model,
    effort: (agent.effort as EffortLevel) ?? 'high',
    systemPrompt:
      kind === 'developer'
        ? { type: 'preset', preset: 'claude_code', append: context.systemPrompt }
        : context.systemPrompt,
    sandbox: { enabled: false }, // il computer dell'utente È il perimetro
    // In `bypass` togliamo anche la policy interna dell'SDK sui comandi (es.
    // niente redirezioni/scritture): è l'equivalente di
    // `--dangerously-skip-permissions`. In `ask` restiamo su default e il gate
    // umano passa dall'hook qui sotto.
    ...(bypass ? { permissionMode: 'bypassPermissions' as const } : {}),
    // Gate delle azioni via hook PreToolUse: passa tutto, tranne gli strumenti
    // marcati "richiede approvazione" → card di conferma inline in chat.
    hooks: {
      PreToolUse: [
        {
          hooks: [
            async (input) => {
              const i = input as unknown as { tool_name?: string; tool_input?: unknown };
              const toolName = i.tool_name ?? '';
              if (!needApproval.has(toolName)) return { continue: true };
              const { title, detail } = describeApproval(toolName, i.tool_input);
              await emitter.status('waiting', `In attesa di conferma: ${title}`);
              const outcome = await askApproval(cfg, job.runId, toolName, title, detail, i.tool_input);
              await emitter.status('working', null);
              return {
                hookSpecificOutput: {
                  hookEventName: 'PreToolUse',
                  permissionDecision: outcome.allowed ? 'allow' : 'deny',
                  permissionDecisionReason:
                    outcome.reason ?? (outcome.allowed ? 'approvato' : 'rifiutato in chat'),
                },
              };
            },
          ],
        },
      ],
    },
    mcpServers: hiveServer ? { hive: hiveServer } : {},
    // Parità totale con Claude Code da terminale su questa macchina: carica
    // CLAUDE.md, skill, server MCP e impostazioni dell'utente e del progetto.
    settingSources: ['user', 'project', 'local'],
    includePartialMessages: true,
    maxTurns: kind === 'developer' ? 60 : 20,
    abortController: controller,
    env: { ...process.env, ...localAuthEnv() } as Record<string, string>,
    ...(resumeSessionId ? { resume: resumeSessionId } : {}),
    stderr: (d: string) => {
      if (d.trim()) console.error('[claude-code]', d.trim().slice(0, 300));
    },
  };

  let finalText = '';
  let numTurns = 0;
  let costUsd: number | null = null;
  let inputTokens: number | null = null;
  let outputTokens: number | null = null;
  let sessionId: string | null = resumeSessionId;
  let thinkingOpen = false;

  await emitter.status('thinking', null);
  try {
    for await (const message of query({ prompt: context.prompt, options })) {
      const msg = message as SDKMessage & Record<string, unknown>;
      switch (msg.type) {
        case 'system':
          if ((msg as { subtype?: string }).subtype === 'init')
            sessionId = (msg as { session_id?: string }).session_id ?? sessionId;
          break;
        case 'stream_event': {
          const ev = (msg as { event?: { type?: string; delta?: { type?: string; text?: string; thinking?: string } } }).event;
          if (ev?.type === 'content_block_delta') {
            if (ev.delta?.type === 'text_delta' && ev.delta.text) {
              if (thinkingOpen) {
                thinkingOpen = false;
                await emitter.event({ type: 'thinking.end' });
                await emitter.status('working', null);
              }
              await emitter.delta(ev.delta.text);
            } else if (ev.delta?.type === 'thinking_delta' && ev.delta.thinking) {
              if (!thinkingOpen) {
                thinkingOpen = true;
                await emitter.event({ type: 'thinking.start' });
                await emitter.status('thinking', 'Sta ragionando');
              }
              await emitter.event({ type: 'thinking.delta', text: ev.delta.thinking });
            }
          }
          break;
        }
        case 'assistant': {
          numTurns++;
          const content = (msg as { message?: { content?: unknown[] } }).message?.content ?? [];
          for (const block of content) {
            const b = block as { type?: string; id?: string; name?: string; input?: unknown };
            if (b.type === 'tool_use' && b.id && b.name) {
              const label = describeTool(b.name, b.input);
              await emitter.status('working', label);
              await emitter.event({ type: 'tool.start', toolUseId: b.id, name: b.name, label, input: b.input });
            }
          }
          break;
        }
        case 'user': {
          const content = (msg as { message?: { content?: unknown[] } }).message?.content ?? [];
          for (const block of content) {
            const b = block as { type?: string; tool_use_id?: string; is_error?: boolean; content?: unknown };
            if (b.type === 'tool_result' && b.tool_use_id) {
              await emitter.event({
                type: 'tool.end',
                toolUseId: b.tool_use_id,
                isError: Boolean(b.is_error),
                summary: summarizeResult(b.content),
              });
            }
          }
          break;
        }
        case 'result': {
          const r = msg as {
            result?: string;
            is_error?: boolean;
            num_turns?: number;
            total_cost_usd?: number;
            session_id?: string;
            usage?: { input_tokens?: number; output_tokens?: number };
          };
          if (typeof r.result === 'string') finalText = r.result;
          if (typeof r.num_turns === 'number') numTurns = r.num_turns;
          if (typeof r.total_cost_usd === 'number') costUsd = r.total_cost_usd;
          if (r.session_id) sessionId = r.session_id;
          inputTokens = r.usage?.input_tokens ?? null;
          outputTokens = r.usage?.output_tokens ?? null;
          break;
        }
      }
    }
    if (thinkingOpen) await emitter.event({ type: 'thinking.end' });
    await emitter.finish({
      status: 'done',
      finalText: finalText || emitter.text,
      numTurns,
      costUsd,
      inputTokens,
      outputTokens,
      // Su questa macchina si va di abbonamento, a meno che non ci sia una
      // API key impostata apposta: solo allora i dollari sono spesa vera.
      usesSubscription: !localAuthEnv().ANTHROPIC_API_KEY,
      sdkSessionId: sessionId,
    });
  } catch (err) {
    await emitter.finish({ status: 'error', error: err instanceof Error ? err.message : String(err) });
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Loop dei comandi "fuori turno": il server chiede di leggere o scrivere file
 * su questa macchina (per ora il CLAUDE.md del progetto) senza far partire un
 * turno dell'agente. Gira in parallelo al poll dei turni.
 */
async function commandLoop(cfg: Config): Promise<void> {
  const headers = { authorization: `Bearer ${cfg.token}` };
  const claudeMdPath = join(cfg.workdir, 'CLAUDE.md');

  for (;;) {
    try {
      const res = await fetch(`${cfg.serverUrl}/api/runner/commands`, { headers });
      if (res.status !== 200) {
        await new Promise((r) => setTimeout(r, res.status === 204 ? 200 : 3000));
        continue;
      }
      const { command } = (await res.json()) as {
        command: { id: string; op: string; content?: string };
      };
      let result: Record<string, unknown>;
      try {
        if (command.op === 'claudeMd.read') {
          let content = '';
          let exists = true;
          try {
            content = await readFile(claudeMdPath, 'utf8');
          } catch {
            exists = false;
          }
          result = { ok: true, content, path: claudeMdPath, exists };
        } else if (command.op === 'claudeMd.write') {
          await writeFile(claudeMdPath, command.content ?? '', 'utf8');
          console.log(`[runner] CLAUDE.md aggiornato (${claudeMdPath})`);
          result = { ok: true, path: claudeMdPath, exists: true };
        } else {
          result = { ok: false, error: `Comando sconosciuto: ${command.op}` };
        }
      } catch (err) {
        result = { ok: false, error: (err as Error).message };
      }
      await fetch(`${cfg.serverUrl}/api/runner/command-result`, {
        method: 'POST',
        headers: { ...headers, 'content-type': 'application/json' },
        body: JSON.stringify({ commandId: command.id, ...result }),
      }).catch(() => {});
    } catch {
      await new Promise((r) => setTimeout(r, 3000));
    }
  }
}

/**
 * C'è una versione più nuova pubblicata sul server?
 *
 * L'aggiornamento vero lo fa `run.sh`, ma solo *fra* un'esecuzione e l'altra:
 * finché questo processo vive, non viene mai controllato nulla. E questo
 * processo, di suo, non finisce mai. Quindi il pezzo mancante è qui: ci
 * accorgiamo noi che c'è una versione nuova e usciamo puliti, così lo script
 * che ci avvolge scarica e riparte. Senza questo, un runner acceso resta sulla
 * versione che aveva il giorno che l'hanno acceso.
 */
async function newerVersionPublished(serverUrl: string): Promise<string | null> {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const [local, res] = await Promise.all([
      readFile(join(here, 'VERSION'), 'utf8').catch(() => ''),
      fetch(`${serverUrl}/download/runner-version`, { signal: AbortSignal.timeout(5000) }),
    ]);
    if (!res.ok) return null;
    const remote = (await res.text()).trim();
    const current = local.trim();
    // Senza un VERSION locale non sappiamo da dove veniamo: meglio restare su
    // quello che gira che riavviarsi in cerchio a ogni giro di poll.
    if (!remote || !current || remote === current) return null;
    return remote;
  } catch {
    return null;
  }
}

export async function startRunnerClient(): Promise<void> {
  const cfg = readConfig();
  console.log(`[runner] «${cfg.name}» → ${cfg.serverUrl}\n[runner] cartella di lavoro: ${cfg.workdir}`);

  // Annuncio iniziale.
  try {
    const hello = await fetch(`${cfg.serverUrl}/api/runner/hello`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${cfg.token}` },
      body: JSON.stringify({ name: cfg.name, host: hostname(), workdir: cfg.workdir }),
    });
    if (!hello.ok) throw new Error(`hello ${hello.status}`);
    console.log('[runner] collegato ✓ — in attesa di lavoro');
  } catch (err) {
    console.error('[runner] impossibile collegarsi:', (err as Error).message);
  }

  // Battito indipendente dal poll: mentre il runner ESEGUE un turno non fa
  // richieste di poll, quindi la sua presenza (TTL 30s) scadeva e il server
  // lo dava per spento — i messaggi che arrivavano durante un lavoro lungo
  // fallivano con «runner offline» pur essendo la macchina accesa e attiva.
  const heartbeat = setInterval(() => {
    void fetch(`${cfg.serverUrl}/api/runner/hello`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${cfg.token}` },
      body: JSON.stringify({ name: cfg.name, host: hostname(), workdir: cfg.workdir }),
    }).catch(() => {});
  }, 10_000);
  heartbeat.unref();

  // Comandi fuori turno (lettura/scrittura file) in parallelo ai turni.
  void commandLoop(cfg);

  // Ogni quanto guardare se è uscita una versione nuova, e quando l'abbiamo
  // guardata l'ultima volta.
  const UPDATE_CHECK_MS = 5 * 60 * 1000;
  let lastUpdateCheck = Date.now();

  // Loop di poll.
  for (;;) {
    try {
      const res = await fetch(
        `${cfg.serverUrl}/api/runner/poll?name=${encodeURIComponent(cfg.name)}`,
        { headers: { authorization: `Bearer ${cfg.token}` } },
      );
      if (res.status === 204) {
        // 204 = nessun turno da fare: è l'unico momento in cui possiamo
        // uscire senza interrompere il lavoro di qualcuno.
        if (Date.now() - lastUpdateCheck >= UPDATE_CHECK_MS) {
          lastUpdateCheck = Date.now();
          const next = await newerVersionPublished(cfg.serverUrl);
          if (next) {
            console.log(`[runner] disponibile la versione ${next}: mi riavvio per prenderla`);
            // `return` non basta: il loop dei comandi gira in parallelo e
            // tiene vivo il processo, che resta appeso senza più prendere
            // turni (e quindi risulta «offline» pur essendo acceso).
            // Usciamo davvero: allo script wrapper tocca riavviarci.
            process.exit(0);
          }
        }
        continue;
      }
      if (res.status === 401) {
        console.error('[runner] token rifiutato. Controlla HIVE_RUNNER_TOKEN.');
        await new Promise((r) => setTimeout(r, 10_000));
        continue;
      }
      if (!res.ok) {
        await new Promise((r) => setTimeout(r, 3000));
        continue;
      }
      const data = (await res.json()) as PollResult;
      console.log(`[runner] turno per @${data.agent.handle} (run ${data.job.runId.slice(0, 8)})`);
      await runOne(cfg, data).catch((e) => console.error('[runner] errore nel turno:', e));
    } catch (err) {
      console.error('[runner] poll fallito:', (err as Error).message);
      await new Promise((r) => setTimeout(r, 3000));
    }
  }
}
