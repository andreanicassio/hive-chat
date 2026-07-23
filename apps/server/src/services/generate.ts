import { and, eq } from 'drizzle-orm';
import { env } from '../env.js';
import { db, schema } from '../db/index.js';
import { decryptSecret } from '../lib/crypto.js';
import { toolById } from '@hive/shared';
import type { AgentKind } from '@hive/shared';

/**
 * Generazione assistita di skill per un agente.
 *
 * Chiamiamo l'API direttamente via fetch invece di passare da un SDK: è una
 * singola richiesta con output strutturato, non serve un harness agentico.
 * Funziona sia su Anthropic sia su OpenRouter, così la funzione è disponibile
 * anche a chi ha configurato solo una delle due chiavi.
 */

export interface GeneratedSkill {
  name: string;
  description: string;
  body: string;
}

const SKILL_SCHEMA = {
  type: 'object',
  properties: {
    skills: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          name: {
            type: 'string',
            description: 'identificatore in minuscolo con trattini, es. "analisi-ticket"',
          },
          description: {
            type: 'string',
            description:
              'Una frase che dice QUANDO usare la skill. È ciò che il modello legge per decidere se caricarla.',
          },
          body: {
            type: 'string',
            description:
              'Il corpo della skill in Markdown: procedura operativa, criteri, esempi.',
          },
        },
        required: ['name', 'description', 'body'],
        additionalProperties: false,
      },
    },
  },
  required: ['skills'],
  additionalProperties: false,
} as const;

function buildPrompt(args: {
  purpose: string;
  kind: AgentKind;
  toolIds: string[];
  count: number;
}): string {
  const tools = args.toolIds
    .map((id) => toolById.get(id))
    .filter((t): t is NonNullable<typeof t> => Boolean(t))
    .map((t) => `- ${t.label}: ${t.description}`)
    .join('\n');

  return [
    `Devi scrivere ${args.count} "skill" per un agente AI che lavora dentro un'app di chat di squadra.`,
    '',
    "SCOPO DELL'AGENTE:",
    args.purpose,
    '',
    `TIPO: ${args.kind === 'developer' ? 'agente sviluppatore, lavora su un repository di codice con shell e filesystem' : 'agente assistente, non tocca il codice, lavora tramite tool e API'}`,
    '',
    tools ? `TOOL A DISPOSIZIONE:\n${tools}` : 'Nessun tool specifico configurato.',
    '',
    "Una skill è un file Markdown che l'agente carica da solo quando la situazione lo richiede.",
    'Regole per scriverle bene:',
    '- `description` deve dire QUANDO serve la skill, non cosa fa l\'agente in generale.',
    '  È l\'unica cosa che il modello legge per decidere se aprirla: se è vaga, non verrà mai caricata.',
    '- `body` deve contenere procedure concrete e verificabili, non incoraggiamenti generici.',
    '  Preferisci passi numerati, criteri di completamento e casi limite.',
    '- Ogni skill copre UN compito ricorrente e distinto. Niente sovrapposizioni fra skill.',
    '- Scrivi in italiano.',
    '- Non inventare tool che non sono nella lista.',
  ].join('\n');
}

/** Estrae il primo oggetto JSON valido da una risposta che potrebbe avere del testo attorno. */
function extractJson(text: string): unknown {
  const trimmed = text.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    /* prova a scavare */
  }
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced?.[1]) {
    try {
      return JSON.parse(fenced[1]);
    } catch {
      /* continua */
    }
  }
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start !== -1 && end > start) {
    return JSON.parse(trimmed.slice(start, end + 1));
  }
  throw new Error('la risposta del modello non conteneva JSON valido');
}

function normalize(raw: unknown, count: number): GeneratedSkill[] {
  const obj = raw as { skills?: unknown };
  if (!Array.isArray(obj.skills)) throw new Error('risposta senza campo "skills"');

  const out: GeneratedSkill[] = [];
  const seen = new Set<string>();
  for (const item of obj.skills) {
    const s = item as Partial<GeneratedSkill>;
    if (!s.name || !s.description || !s.body) continue;
    const name = s.name
      .toLowerCase()
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 48);
    if (!name || seen.has(name)) continue;
    seen.add(name);
    out.push({
      name,
      description: s.description.slice(0, 500),
      body: s.body.slice(0, 50_000),
    });
    if (out.length >= count) break;
  }
  if (out.length === 0) throw new Error('il modello non ha prodotto nessuna skill valida');
  return out;
}

/** Errore parlante quando manca la configurazione, invece di un 500 opaco. */
export class NoModelKeyError extends Error {
  constructor(message?: string) {
    super(
      message ??
        'Per generare le skill serve una chiave API. Aprila in Impostazioni → Credenziali e ' +
          'incolla una chiave OpenRouter oppure una API key Anthropic.',
    );
    this.name = 'NoModelKeyError';
  }
}

/**
 * Chiave da usare per la generazione delle skill.
 *
 * La generazione è una singola chiamata HTTP con output strutturato, quindi
 * serve una API key vera. Il token dell'abbonamento Claude NON va bene qui:
 * è pensato per il loop dell'Agent SDK e, su una chiamata diretta
 * all'endpoint messages, viene sistematicamente respinto con 429.
 *
 * Ordine di ricerca (dal più specifico): segreti del progetto, poi env del
 * server. A parità, preferiamo OpenRouter perché una sua chiave copre anche
 * i modelli non-Claude.
 */
async function resolveGenerationKey(
  workspaceId: string,
): Promise<{ provider: 'anthropic' | 'openrouter'; key: string } | null> {
  const [wsOpenRouter, wsAnthropic] = await Promise.all([
    workspaceSecret(workspaceId, 'OPENROUTER_API_KEY'),
    workspaceSecret(workspaceId, 'ANTHROPIC_API_KEY'),
  ]);

  if (wsOpenRouter) return { provider: 'openrouter', key: wsOpenRouter };
  if (env.OPENROUTER_API_KEY) return { provider: 'openrouter', key: env.OPENROUTER_API_KEY };
  if (wsAnthropic) return { provider: 'anthropic', key: wsAnthropic };
  if (env.ANTHROPIC_API_KEY) return { provider: 'anthropic', key: env.ANTHROPIC_API_KEY };
  return null;
}

/** Legge e decifra un segreto del workspace. */
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

export async function generateSkills(args: {
  workspaceId: string;
  purpose: string;
  kind: AgentKind;
  toolIds: string[];
  count: number;
}): Promise<GeneratedSkill[]> {
  const prompt = buildPrompt(args);

  const cred = await resolveGenerationKey(args.workspaceId);
  if (!cred) {
    // Distinguiamo il caso "hai solo l'abbonamento": è la configurazione più
    // probabile di chi ci casca, e merita una spiegazione precisa.
    const hasSubscriptionOnly =
      Boolean(env.CLAUDE_CODE_OAUTH_TOKEN) &&
      !env.ANTHROPIC_API_KEY &&
      !env.OPENROUTER_API_KEY;
    throw new NoModelKeyError(
      hasSubscriptionOnly
        ? 'Gli agenti girano sul tuo abbonamento, ma la generazione delle skill ha bisogno ' +
            'di una API key vera (l’abbonamento non è utilizzabile per questa chiamata). ' +
            'Aggiungi una chiave OpenRouter o Anthropic in Impostazioni → Credenziali.'
        : undefined,
    );
  }

  return cred.provider === 'openrouter'
    ? generateViaOpenRouter(prompt, args.count, cred.key)
    : generateViaAnthropic(prompt, args.count, cred.key);
}

async function generateViaAnthropic(
  prompt: string,
  count: number,
  apiKey: string,
): Promise<GeneratedSkill[]> {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    signal: AbortSignal.timeout(120_000),
    headers: {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-opus-4-8',
      max_tokens: 16000,
      thinking: { type: 'adaptive' },
      output_config: {
        effort: 'medium',
        format: { type: 'json_schema', schema: SKILL_SCHEMA },
      },
      messages: [{ role: 'user', content: prompt }],
    }),
  });

  if (!res.ok) {
    throw new Error(`Anthropic ha risposto ${res.status}: ${(await res.text()).slice(0, 300)}`);
  }

  const data = (await res.json()) as {
    content?: Array<{ type: string; text?: string }>;
    stop_reason?: string;
  };
  if (data.stop_reason === 'refusal') {
    throw new Error('Il modello ha rifiutato la richiesta. Riformula lo scopo dell’agente.');
  }
  const text = (data.content ?? []).find((b) => b.type === 'text')?.text ?? '';
  return normalize(extractJson(text), count);
}

async function generateViaOpenRouter(
  prompt: string,
  count: number,
  apiKey: string,
): Promise<GeneratedSkill[]> {
  const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    signal: AbortSignal.timeout(120_000),
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${apiKey}`,
      'HTTP-Referer': env.PUBLIC_ORIGIN,
      'X-Title': 'Hive',
    },
    body: JSON.stringify({
      model: 'anthropic/claude-opus-4.8',
      messages: [{ role: 'user', content: prompt }],
      response_format: {
        type: 'json_schema',
        json_schema: { name: 'skills', strict: true, schema: SKILL_SCHEMA },
      },
    }),
  });

  if (!res.ok) {
    throw new Error(`OpenRouter ha risposto ${res.status}: ${(await res.text()).slice(0, 300)}`);
  }

  const data = (await res.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  const text = data.choices?.[0]?.message?.content ?? '';
  return normalize(extractJson(text), count);
}
