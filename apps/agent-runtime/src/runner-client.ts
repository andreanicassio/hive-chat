import { query } from '@anthropic-ai/claude-agent-sdk';
import type { Options, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { mkdir } from 'node:fs/promises';
import { basename } from 'node:path';
import { dangerousToolNames, type AgentToolGrant, type EffortLevel } from '@hive/shared';
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

interface PollResult {
  job: { runId: string; workspaceId: string; channelId: string; agentId: string };
  agent: Record<string, unknown>;
  context: { systemPrompt: string; prompt: string };
  resumeSessionId: string | null;
}

async function runOne(cfg: Config, data: PollResult): Promise<void> {
  const { job, agent, context, resumeSessionId } = data;
  const emitter = new RemoteEmitter(cfg.serverUrl, cfg.token, job.runId);
  const grants = (agent.tools as AgentToolGrant[]) ?? [];
  const kind = (agent.kind as 'assistant' | 'developer') ?? 'developer';
  const { model } = toAnthropicModelId(String(agent.model));

  await mkdir(cfg.workdir, { recursive: true });
  await emitter.markStarted();

  // Piena capacità di Claude Code: l'agente gira SUL computer dell'utente, nel
  // suo perimetro di fiducia — non limitiamo gli strumenti. Le sole azioni che
  // chiedono conferma inline in chat sono quelle che l'agente ha marcato come
  // "richiede approvazione".
  // In `bypass` l'agente ha autonomia totale: non chiediamo mai conferma
  // (come `claude --dangerously-skip-permissions`). Altrimenti chiedono
  // conferma solo gli strumenti marcati "richiede approvazione".
  const bypass = agent.permissionMode === 'bypass';
  const needApproval = bypass ? new Set<string>() : dangerousToolNames(grants);

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
    mcpServers: {},
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
      sdkSessionId: sessionId,
    });
  } catch (err) {
    await emitter.finish({ status: 'error', error: err instanceof Error ? err.message : String(err) });
  } finally {
    clearTimeout(timeout);
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
      body: JSON.stringify({ name: cfg.name }),
    });
    if (!hello.ok) throw new Error(`hello ${hello.status}`);
    console.log('[runner] collegato ✓ — in attesa di lavoro');
  } catch (err) {
    console.error('[runner] impossibile collegarsi:', (err as Error).message);
  }

  // Loop di poll.
  for (;;) {
    try {
      const res = await fetch(
        `${cfg.serverUrl}/api/runner/poll?name=${encodeURIComponent(cfg.name)}`,
        { headers: { authorization: `Bearer ${cfg.token}` } },
      );
      if (res.status === 204) continue;
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
