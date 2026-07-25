import { z } from 'zod';
import { resolveOpenRouterKey } from '../auth.js';
import { buildHiveTools } from '../tools/hive-tools.js';
import { env } from '../env.js';
import { mentionedHandles, type AgentToolGrant } from '@hive/shared';
import type { Runner, RunnerInput, RunnerResult } from './types.js';

/**
 * Runner generico su OpenRouter.
 *
 * Serve gli agenti assistente su modelli non-Claude (Gemini, GPT, Kimi,
 * Qwen…). Implementa il ciclo tool-calling a mano sull'API compatibile
 * OpenAI, e riusa esattamente le stesse definizioni di tool del runner
 * Claude Code: la logica dei tool è scritta una volta sola.
 *
 * Niente filesystem né shell: questo runtime è solo per gli assistenti.
 */

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
const MAX_ITERATIONS = 12;

interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_calls?: Array<{
    id: string;
    type: 'function';
    function: { name: string; arguments: string };
  }>;
  tool_call_id?: string;
}

export class OpenRouterRunner implements Runner {
  readonly id = 'openrouter-tools';

  async run(input: RunnerInput): Promise<RunnerResult> {
    const { agent, context, emitter } = input;
    const apiKey = await resolveOpenRouterKey(input.workspaceId);
    const grants = (agent.tools as AgentToolGrant[]) ?? [];

    const hiveTools = buildHiveTools({
      workspaceId: input.workspaceId,
      channelId: input.channelId,
      agentId: agent.id,
      agentHandle: agent.handle,
      runId: input.runId,
      grants,
      emitter,
    });

    const byName = new Map(hiveTools.map((t) => [t.name, t]));

    // Le stesse definizioni, tradotte nel formato function-calling.
    const toolSpecs = hiveTools.map((t) => ({
      type: 'function' as const,
      function: {
        name: t.name,
        description: t.description,
        parameters: stripSchemaMeta(
          z.toJSONSchema(z.object(t.inputSchema as z.ZodRawShape), { io: 'input' }),
        ),
      },
    }));

    const messages: ChatMessage[] = [
      { role: 'system', content: context.systemPrompt },
      { role: 'user', content: context.prompt },
    ];

    await emitter.status('thinking', null);

    let finalText = '';
    let turns = 0;
    let inputTokens = 0;
    let outputTokens = 0;
    let costUsd: number | null = null;

    for (let i = 0; i < MAX_ITERATIONS; i++) {
      if (input.signal.aborted) break;
      turns++;
      await emitter.bumpTurns();

      const res = await fetch(OPENROUTER_URL, {
        method: 'POST',
        signal: input.signal,
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${apiKey}`,
          // OpenRouter li usa per l'attribuzione nelle sue classifiche.
          'HTTP-Referer': env.PUBLIC_ORIGIN,
          'X-Title': 'Hive',
        },
        body: JSON.stringify({
          model: agent.model,
          messages,
          ...(toolSpecs.length > 0 ? { tools: toolSpecs } : {}),
          stream: true,
          usage: { include: true },
        }),
      });

      if (!res.ok || !res.body) {
        const detail = await res.text().catch(() => '');
        throw new Error(
          `OpenRouter ha risposto ${res.status}: ${detail.slice(0, 300) || 'nessun dettaglio'}`,
        );
      }

      const turn = await this.consumeStream(res.body, emitter);
      inputTokens += turn.inputTokens;
      outputTokens += turn.outputTokens;
      if (turn.costUsd != null) costUsd = (costUsd ?? 0) + turn.costUsd;

      // Nessun tool richiesto: è la risposta finale.
      if (turn.toolCalls.length === 0) {
        finalText = turn.text;
        break;
      }

      // Qui il modello ha scritto qualcosa e poi ha chiesto uno strumento:
      // quel testo è ragionamento concluso. Il corpo del messaggio verrà
      // sovrascritto dalla risposta finale, quindi lo salviamo come evento.
      const reasoning = turn.text.trim();
      if (reasoning) await emitter.event({ type: 'text.block', text: reasoning });

      messages.push({
        role: 'assistant',
        content: turn.text || null,
        tool_calls: turn.toolCalls.map((c) => ({
          id: c.id,
          type: 'function' as const,
          function: { name: c.name, arguments: c.arguments },
        })),
      });

      for (const call of turn.toolCalls) {
        const def = byName.get(call.name);
        const label = `Usa ${call.name.replace(/_/g, ' ')}`;
        await emitter.status('working', label);
        await emitter.event({
          type: 'tool.start',
          toolUseId: call.id,
          name: call.name,
          label,
          input: safeParse(call.arguments),
        });

        let resultText: string;
        let isError = false;
        if (!def) {
          resultText = `Tool sconosciuto: ${call.name}`;
          isError = true;
        } else {
          try {
            const args = z
              .object(def.inputSchema as z.ZodRawShape)
              .parse(safeParse(call.arguments) ?? {});
            const out = await def.handler(args as never, {});
            resultText = (out.content ?? [])
              .map((c) => (c.type === 'text' ? c.text : ''))
              .join('\n');
            isError = Boolean(out.isError);
          } catch (err) {
            resultText = `Errore eseguendo il tool: ${err instanceof Error ? err.message : String(err)}`;
            isError = true;
          }
        }

        await emitter.event({
          type: 'tool.end',
          toolUseId: call.id,
          isError,
          summary: resultText.split('\n')[0]?.slice(0, 120) ?? 'fatto',
        });

        messages.push({ role: 'tool', tool_call_id: call.id, content: resultText });
      }
    }

    const text = finalText || emitter.text;
    return {
      finalText: text,
      numTurns: turns,
      costUsd,
      inputTokens: inputTokens || null,
      outputTokens: outputTokens || null,
      // OpenRouter è sempre a consumo: qui i dollari sono spesa vera.
      usesSubscription: false,
      // OpenRouter non ha un concetto di sessione ripristinabile: il filo lo
      // ricostruiamo ogni volta dallo storico del canale.
      sessionId: null,
      handoffs: mentionedHandles(text).filter((h) => h !== agent.handle),
    };
  }

  /** Consuma lo stream SSE accumulando testo, tool call e consumi. */
  private async consumeStream(
    body: ReadableStream<Uint8Array>,
    emitter: RunnerInput['emitter'],
  ): Promise<{
    text: string;
    toolCalls: Array<{ id: string; name: string; arguments: string }>;
    inputTokens: number;
    outputTokens: number;
    costUsd: number | null;
  }> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let text = '';
    let inputTokens = 0;
    let outputTokens = 0;
    let costUsd: number | null = null;
    // Le tool call arrivano a pezzi: si accumulano per indice.
    const calls = new Map<number, { id: string; name: string; arguments: string }>();

    let firstText = true;

    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('data:')) continue;
        const payload = trimmed.slice(5).trim();
        if (payload === '[DONE]') continue;

        let chunk: {
          choices?: Array<{
            delta?: {
              content?: string;
              tool_calls?: Array<{
                index: number;
                id?: string;
                function?: { name?: string; arguments?: string };
              }>;
            };
          }>;
          usage?: { prompt_tokens?: number; completion_tokens?: number; cost?: number };
        };
        try {
          chunk = JSON.parse(payload);
        } catch {
          continue;
        }

        const delta = chunk.choices?.[0]?.delta;
        if (delta?.content) {
          if (firstText) {
            firstText = false;
            await emitter.status('working', null);
          }
          text += delta.content;
          await emitter.delta(delta.content);
        }

        for (const tc of delta?.tool_calls ?? []) {
          const existing = calls.get(tc.index) ?? { id: '', name: '', arguments: '' };
          if (tc.id) existing.id = tc.id;
          if (tc.function?.name) existing.name += tc.function.name;
          if (tc.function?.arguments) existing.arguments += tc.function.arguments;
          calls.set(tc.index, existing);
        }

        if (chunk.usage) {
          inputTokens = chunk.usage.prompt_tokens ?? inputTokens;
          outputTokens = chunk.usage.completion_tokens ?? outputTokens;
          if (typeof chunk.usage.cost === 'number') costUsd = chunk.usage.cost;
        }
      }
    }

    return {
      text,
      toolCalls: [...calls.values()].filter((c) => c.name),
      inputTokens,
      outputTokens,
      costUsd,
    };
  }
}

function safeParse(json: string): unknown {
  try {
    return JSON.parse(json);
  } catch {
    return {};
  }
}

/**
 * OpenRouter rifiuta gli schemi con `$schema`; alcuni provider inciampano
 * anche su `additionalProperties` assente, quindi lo mettiamo esplicito.
 */
function stripSchemaMeta(schema: Record<string, unknown>): Record<string, unknown> {
  const { $schema, ...rest } = schema;
  return { ...rest, additionalProperties: false };
}
