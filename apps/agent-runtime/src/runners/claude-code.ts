import { query } from '@anthropic-ai/claude-agent-sdk';
import type {
  CanUseTool,
  Options,
  PermissionResult,
  SDKMessage,
} from '@anthropic-ai/claude-agent-sdk';
import { basename } from 'node:path';
import { resolveClaudeAuth } from '../auth.js';
import { requestApproval } from '../approvals.js';
import { materializeSkills } from '../skills.js';
import { buildHiveMcpServer } from '../tools/hive-tools.js';
import { sandboxFor } from '../workspace.js';
import { env } from '../env.js';
import {
  assistantDeniedTools,
  dangerousToolNames,
  mentionedHandles,
  resolveAllowedTools,
  resolveDisallowedTools,
  type AgentToolGrant,
  type EffortLevel,
} from '@hive/shared';
import type { Runner, RunnerInput, RunnerResult } from './types.js';
import { toAnthropicModelId } from '../models.js';

/**
 * Runner basato sul Claude Agent SDK: è Claude Code eseguito come libreria.
 *
 * Da qui passano tutti gli agenti sviluppatore e gli assistenti che girano
 * su un modello Claude. Lo stream di messaggi dell'SDK viene tradotto negli
 * eventi normalizzati che la chat sa disegnare.
 */

/** Etichetta leggibile per un uso di tool, da mostrare in chat. */
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
    case 'Agent':
      return 'Delega a un subagent';
    case 'TodoWrite':
      return 'Aggiorna il piano di lavoro';
    default:
      if (name.startsWith('mcp__hive__')) {
        return `Usa ${name.replace('mcp__hive__', '').replace(/_/g, ' ')}`;
      }
      if (name.startsWith('mcp__')) {
        const [, server, tool] = name.split('__');
        return `Usa ${tool ?? name} (${server ?? 'mcp'})`;
      }
      return `Usa ${name}`;
  }
}

/** Riassume il risultato di un tool senza riversare in chat output enormi. */
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

/** Titolo e dettaglio della card di conferma per le azioni pericolose. */
function describeApproval(
  name: string,
  input: unknown,
): { title: string; detail: string } {
  const i = (input ?? {}) as Record<string, unknown>;
  if (name === 'mcp__hive__git_push' || name === 'Bash') {
    const cmd = typeof i.command === 'string' ? i.command : JSON.stringify(i);
    return { title: 'Vuole eseguire un comando che modifica il remoto', detail: cmd };
  }
  if (name === 'mcp__hive__open_pull_request') {
    return {
      title: `Vuole aprire una pull request: ${String(i.title ?? '')}`.slice(0, 200),
      detail: String(i.body ?? ''),
    };
  }
  if (name === 'mcp__hive__deploy') {
    return {
      title: `Vuole lanciare un deploy su ${String(i.environment ?? 'production')}`,
      detail: String(i.command ?? ''),
    };
  }
  return {
    title: `Vuole usare ${name}`,
    detail: JSON.stringify(input, null, 2).slice(0, 4000),
  };
}

export class ClaudeCodeRunner implements Runner {
  readonly id = 'claude-code';

  async run(input: RunnerInput): Promise<RunnerResult> {
    const { agent, context, emitter } = input;
    const grants = (agent.tools as AgentToolGrant[]) ?? [];
    const kind = agent.kind as 'assistant' | 'developer';

    // Sul runner locale l'auth arriva dalle credenziali di quella macchina
    // (niente lettura dei segreti del workspace, che vivono nel DB del server).
    const auth = input.authEnvOverride
      ? { envVars: input.authEnvOverride }
      : await resolveClaudeAuth(input.workspaceId);
    const { model } = toAnthropicModelId(agent.model);

    // Le skill vivono nel DB: il runner locale non ce l'ha, quindi lì le
    // saltiamo (arriveranno via proxy in una versione successiva).
    const skillCount = input.disableHiveTools
      ? 0
      : await materializeSkills(agent.id, input.workDir);

    // Sul runner locale i tool hive (che richiedono il DB) non ci sono ancora:
    // l'agente usa gli strumenti di codice, che girano in locale.
    const allowedTools = resolveAllowedTools(grants, kind).filter(
      (t) => !input.disableHiveTools || !t.startsWith('mcp__hive__'),
    );
    const dangerous = dangerousToolNames(grants);

    // Neghiamo esplicitamente ogni tool built-in NON concesso, così l'SDK non
    // lo espone nemmeno al modello: senza questo l'agente prova tool che non
    // ha e li vede negati uno per uno. Per gli assistenti aggiungiamo anche
    // il blocco duro di filesystem e shell.
    const disallowedTools = [
      ...new Set([
        ...resolveDisallowedTools(grants, kind),
        ...(kind === 'assistant' ? assistantDeniedTools : []),
      ]),
    ];

    const hiveServer = input.disableHiveTools
      ? null
      : buildHiveMcpServer({
          workspaceId: input.workspaceId,
          channelId: input.channelId,
          agentId: agent.id,
          agentHandle: agent.handle,
          runId: input.runId,
          grants,
          emitter,
          workDir: input.workDir,
          repo: (agent.repo as import('@hive/shared').RepoConfig | null) ?? null,
        });

    /**
     * Gate umano. L'SDK lo invoca quando un tool non è pre-approvato.
     * Per i tool marcati pericolosi apriamo una card in chat e restiamo
     * fermi finché qualcuno decide.
     */
    const canUseTool: CanUseTool = async (toolName, toolInput): Promise<PermissionResult> => {
      if (!dangerous.has(toolName)) {
        // Non è nell'elenco dei pericolosi ma non era nemmeno pre-approvato:
        // vuol dire che non è stato concesso a questo agente.
        return {
          behavior: 'deny',
          message: `Il tool ${toolName} non è fra quelli concessi a questo agente.`,
        };
      }

      const { title, detail } = describeApproval(toolName, toolInput);
      const outcome = await requestApproval(
        {
          runId: input.runId,
          workspaceId: input.workspaceId,
          channelId: input.channelId,
          agentId: agent.id,
          toolName,
          title,
          detail,
          input: toolInput,
        },
        emitter,
      );

      if (outcome.allowed) return { behavior: 'allow', updatedInput: toolInput };
      return {
        behavior: 'deny',
        message: outcome.timedOut
          ? 'Nessuno ha confermato l’azione entro il tempo previsto. Prosegui senza, oppure spiega cosa serve.'
          : `Un umano ha rifiutato l’azione${outcome.reason ? `: ${outcome.reason}` : ''}. Non riprovare la stessa cosa.`,
      };
    };

    const options: Options = {
      cwd: input.workDir,
      model,
      effort: agent.effort as EffortLevel,
      // Il preset porta con sé le istruzioni operative di Claude Code;
      // il nostro contesto si aggiunge in coda.
      systemPrompt:
        kind === 'developer'
          ? { type: 'preset', preset: 'claude_code', append: context.systemPrompt }
          : context.systemPrompt,
      allowedTools,
      disallowedTools,
      canUseTool,
      // Isolamento a livello processo (bubblewrap su Linux): l'agente vede
      // solo la sua working directory e può contattare solo i domini permessi.
      sandbox: sandboxFor({
        kind,
        workDir: input.workDir,
        allowedDomains: [],
      }),
      mcpServers: hiveServer ? { hive: hiveServer } : {},
      // Le skill le scriviamo noi nella cwd: leggiamo solo quelle di progetto,
      // non la configurazione personale dell'utente che ospita il server.
      settingSources: skillCount > 0 ? ['project'] : [],
      includePartialMessages: true,
      maxTurns: kind === 'developer' ? 60 : 20,
      abortController: toController(input.signal),
      env: { ...process.env, ...auth.envVars } as Record<string, string>,
      ...(input.resumeSessionId ? { resume: input.resumeSessionId } : {}),
      stderr: (data: string) => {
        // Utile per capire perché un binario non parte; non va in chat.
        if (data.trim()) console.error('[claude-code]', data.trim().slice(0, 500));
      },
    };

    await emitter.status('thinking', null);

    let finalText = '';
    let numTurns = 0;
    let costUsd: number | null = null;
    let inputTokens: number | null = null;
    let outputTokens: number | null = null;
    let sessionId: string | null = null;
    const openTools = new Map<string, string>();
    let thinkingOpen = false;

    for await (const message of query({ prompt: context.prompt, options })) {
      if (input.signal.aborted) break;

      const msg = message as SDKMessage & Record<string, unknown>;

      switch (msg.type) {
        case 'system': {
          if ((msg as { subtype?: string }).subtype === 'init') {
            sessionId = (msg as { session_id?: string }).session_id ?? null;
          }
          break;
        }

        case 'stream_event': {
          // Streaming a token: è ciò che fa scorrere il testo in chat.
          const ev = (msg as { event?: { type?: string; delta?: { type?: string; text?: string; thinking?: string } } })
            .event;
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
          await emitter.bumpTurns();
          const content = (msg as { message?: { content?: unknown[] } }).message?.content ?? [];
          for (const block of content) {
            const b = block as { type?: string; id?: string; name?: string; input?: unknown };
            if (b.type === 'tool_use' && b.id && b.name) {
              const label = describeTool(b.name, b.input);
              openTools.set(b.id, label);
              await emitter.status('working', label);
              await emitter.event({
                type: 'tool.start',
                toolUseId: b.id,
                name: b.name,
                label,
                input: b.input,
              });
            }
          }
          break;
        }

        case 'user': {
          // I risultati dei tool tornano come messaggi utente.
          const content = (msg as { message?: { content?: unknown[] } }).message?.content ?? [];
          for (const block of content) {
            const b = block as {
              type?: string;
              tool_use_id?: string;
              is_error?: boolean;
              content?: unknown;
            };
            if (b.type === 'tool_result' && b.tool_use_id) {
              openTools.delete(b.tool_use_id);
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
            subtype?: string;
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
          if (r.is_error) {
            await emitter.event({
              type: 'error',
              message: r.result ?? 'esecuzione terminata con errore',
            });
          }
          break;
        }

        default:
          break;
      }
    }

    if (thinkingOpen) await emitter.event({ type: 'thinking.end' });

    const text = finalText || emitter.text;
    return {
      finalText: text,
      numTurns,
      costUsd,
      inputTokens,
      outputTokens,
      sessionId,
      handoffs: mentionedHandles(text).filter((h) => h !== agent.handle),
    };
  }
}

/** L'SDK vuole un AbortController; noi propaghiamo un AbortSignal esterno. */
function toController(signal: AbortSignal): AbortController {
  const controller = new AbortController();
  if (signal.aborted) controller.abort();
  else signal.addEventListener('abort', () => controller.abort(), { once: true });
  return controller;
}
