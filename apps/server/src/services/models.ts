import { and, asc, desc, eq, isNull, lt, sql as raw } from 'drizzle-orm';
import { db, schema } from '../db/index.js';
import { env } from '../env.js';
import type { AgentRuntime, CatalogModel } from '@hive/shared';

const OPENROUTER_MODELS_URL = 'https://openrouter.ai/api/v1/models';

/* ---------------------------------------------------------------------------
 * Mappatura degli id fra OpenRouter e l'API Anthropic
 * ------------------------------------------------------------------------ */

/**
 * OpenRouter identifica i Claude con i punti (`anthropic/claude-opus-4.8`),
 * l'API Anthropic con i trattini (`claude-opus-4-8`). Il Claude Agent SDK
 * vuole la seconda forma, quindi convertiamo.
 *
 * Il suffisso `-fast` di OpenRouter corrisponde alla fast mode, che sull'SDK
 * non si esprime nel nome del modello: lo togliamo e lo segnaliamo a parte.
 */
export function toAnthropicModelId(catalogId: string): {
  model: string;
  fast: boolean;
} {
  let id = catalogId.startsWith('anthropic/') ? catalogId.slice('anthropic/'.length) : catalogId;
  const fast = id.endsWith('-fast');
  if (fast) id = id.slice(0, -'-fast'.length);
  // 4.8 → 4-8, ma senza toccare i trattini già presenti.
  id = id.replace(/\./g, '-');
  return { model: id, fast };
}

/** Vero se il modello può reggere l'harness di Claude Code. */
export function isClaudeModel(catalogId: string): boolean {
  return catalogId.startsWith('anthropic/');
}

/* ---------------------------------------------------------------------------
 * Modelli messi in evidenza
 * ------------------------------------------------------------------------ */

/**
 * Prefissi delle famiglie che mettiamo in cima al selettore.
 * È solo un ordinamento: tutti gli altri restano comunque selezionabili
 * dalla ricerca, quindi un modello nuovo non è mai irraggiungibile.
 */
const FEATURED_PREFIXES = [
  'anthropic/claude-opus',
  'anthropic/claude-sonnet',
  'anthropic/claude-fable',
  'google/gemini-3',
  'openai/gpt-5',
  'deepseek/deepseek-v',
  'moonshotai/kimi',
  'qwen/qwen3',
  'x-ai/grok-4',
  'meta-llama/llama-4',
  'mistralai/mistral-large',
];

function isFeatured(id: string): boolean {
  return FEATURED_PREFIXES.some((p) => id.startsWith(p));
}

/* ---------------------------------------------------------------------------
 * Sincronizzazione
 * ------------------------------------------------------------------------ */

interface OpenRouterModel {
  id: string;
  name?: string;
  context_length?: number;
  created?: number;
  pricing?: { prompt?: string; completion?: string };
  supported_parameters?: string[];
}

/**
 * Scarica il catalogo da OpenRouter e lo riversa su DB.
 * L'endpoint è pubblico: non serve la chiave per elencare i modelli,
 * quindi il selettore è popolato anche prima che l'utente ne configuri una.
 */
export async function syncModelCatalog(): Promise<{ synced: number; hidden: number }> {
  let payload: { data?: OpenRouterModel[] };
  try {
    const res = await fetch(OPENROUTER_MODELS_URL, {
      signal: AbortSignal.timeout(20_000),
      headers: { accept: 'application/json' },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    payload = (await res.json()) as { data?: OpenRouterModel[] };
  } catch (err) {
    // Non è fatale: se il catalogo è già popolato si continua con quello.
    console.warn(
      '[modelli] sincronizzazione da OpenRouter fallita:',
      err instanceof Error ? err.message : err,
    );
    await seedFallbackCatalog();
    return { synced: 0, hidden: 0 };
  }

  const models = payload.data ?? [];
  const now = new Date();
  const rows: Array<typeof schema.modelCatalog.$inferInsert> = [];

  for (const m of models) {
    const params = m.supported_parameters ?? [];
    // Un agente senza tool non serve a niente qui: scartiamo chi non li supporta.
    if (!params.includes('tools')) continue;
    // Gli pseudo-modelli di routing hanno prezzi fittizi: fuori.
    if (m.id.startsWith('openrouter/')) continue;

    const vendor = m.id.split('/')[0] ?? 'sconosciuto';
    const promptPrice = Number(m.pricing?.prompt ?? 0) * 1_000_000;
    const completionPrice = Number(m.pricing?.completion ?? 0) * 1_000_000;

    rows.push({
      id: m.id,
      runtime: (isClaudeModel(m.id)
        ? 'claude-code'
        : 'openrouter-tools') satisfies AgentRuntime,
      name: (m.name ?? m.id).slice(0, 200),
      vendor: vendor.slice(0, 64),
      contextLength: m.context_length ?? 0,
      pricePromptPerM: Number.isFinite(promptPrice) ? promptPrice.toFixed(4) : null,
      priceCompletionPerM: Number.isFinite(completionPrice)
        ? completionPrice.toFixed(4)
        : null,
      supportsTools: true,
      supportsReasoning: params.includes('reasoning') || params.includes('include_reasoning'),
      featured: isFeatured(m.id),
      devCapable: isClaudeModel(m.id),
      releasedAt: m.created ? new Date(m.created * 1000) : null,
      refreshedAt: now,
      hiddenAt: null,
    });
  }

  if (rows.length === 0) {
    await seedFallbackCatalog();
    return { synced: 0, hidden: 0 };
  }

  // Upsert a blocchi: 342 modelli in una sola query sono troppi parametri.
  const CHUNK = 100;
  for (let i = 0; i < rows.length; i += CHUNK) {
    await db
      .insert(schema.modelCatalog)
      .values(rows.slice(i, i + CHUNK))
      .onConflictDoUpdate({
        target: schema.modelCatalog.id,
        set: {
          name: raw`excluded.name`,
          vendor: raw`excluded.vendor`,
          contextLength: raw`excluded.context_length`,
          pricePromptPerM: raw`excluded.price_prompt_per_m`,
          priceCompletionPerM: raw`excluded.price_completion_per_m`,
          supportsTools: raw`excluded.supports_tools`,
          supportsReasoning: raw`excluded.supports_reasoning`,
          featured: raw`excluded.featured`,
          devCapable: raw`excluded.dev_capable`,
          releasedAt: raw`excluded.released_at`,
          refreshedAt: raw`excluded.refreshed_at`,
          hiddenAt: raw`null`,
        },
      });
  }

  // Chi non è più in listino viene nascosto, non cancellato: gli agenti
  // che lo usano continuano a funzionare e restano ispezionabili.
  const hiddenResult = await db
    .update(schema.modelCatalog)
    .set({ hiddenAt: now })
    // `lt()` invece di un template grezzo: passando una Date in un template
    // SQL, postgres.js non sa che tipo associarle e fallisce il bind.
    .where(and(lt(schema.modelCatalog.refreshedAt, now), isNull(schema.modelCatalog.hiddenAt)))
    .returning({ id: schema.modelCatalog.id });

  console.log(
    `[modelli] catalogo aggiornato: ${rows.length} disponibili, ${hiddenResult.length} ritirati`,
  );
  return { synced: rows.length, hidden: hiddenResult.length };
}

/**
 * Se OpenRouter non è raggiungibile al primo avvio, il selettore resterebbe
 * vuoto e non si potrebbe creare nessun agente. Seminiamo i Claude noti
 * così l'app è comunque utilizzabile.
 */
async function seedFallbackCatalog(): Promise<void> {
  const existing = await db
    .select({ n: raw<number>`count(*)::int` })
    .from(schema.modelCatalog);
  if ((existing[0]?.n ?? 0) > 0) return;

  const fallback = [
    { id: 'anthropic/claude-opus-4.8', name: 'Claude Opus 4.8', ctx: 1_000_000, inP: 5, outP: 25 },
    { id: 'anthropic/claude-sonnet-5', name: 'Claude Sonnet 5', ctx: 1_000_000, inP: 3, outP: 15 },
    { id: 'anthropic/claude-haiku-4.5', name: 'Claude Haiku 4.5', ctx: 200_000, inP: 1, outP: 5 },
  ];

  await db
    .insert(schema.modelCatalog)
    .values(
      fallback.map((f) => ({
        id: f.id,
        runtime: 'claude-code' as const,
        name: f.name,
        vendor: 'anthropic',
        contextLength: f.ctx,
        pricePromptPerM: f.inP.toFixed(4),
        priceCompletionPerM: f.outP.toFixed(4),
        supportsTools: true,
        supportsReasoning: true,
        featured: true,
        devCapable: true,
        releasedAt: null,
      })),
    )
    .onConflictDoNothing();

  console.log('[modelli] catalogo minimo seminato (OpenRouter non raggiungibile)');
}

/* ---------------------------------------------------------------------------
 * Lettura
 * ------------------------------------------------------------------------ */

export async function listModels(opts: {
  /** Solo modelli utilizzabili dagli agenti sviluppatore. */
  devOnly?: boolean;
  search?: string;
  limit?: number;
}): Promise<CatalogModel[]> {
  const conditions = [isNull(schema.modelCatalog.hiddenAt)];
  if (opts.devOnly) conditions.push(eq(schema.modelCatalog.devCapable, true));
  if (opts.search?.trim()) {
    const q = `%${opts.search.trim().toLowerCase()}%`;
    conditions.push(
      raw`(lower(${schema.modelCatalog.id}) like ${q} or lower(${schema.modelCatalog.name}) like ${q})`,
    );
  }

  const rows = await db
    .select()
    .from(schema.modelCatalog)
    .where(and(...conditions))
    // In evidenza prima, poi i più recenti: i modelli nuovi salgono da soli.
    .orderBy(
      desc(schema.modelCatalog.featured),
      desc(schema.modelCatalog.releasedAt),
      asc(schema.modelCatalog.id),
    )
    .limit(opts.limit ?? 400);

  return rows.map((r) => ({
    id: r.id,
    runtime: r.runtime as AgentRuntime,
    name: r.name,
    vendor: r.vendor,
    contextLength: r.contextLength,
    pricePromptPerM: r.pricePromptPerM == null ? null : Number(r.pricePromptPerM),
    priceCompletionPerM:
      r.priceCompletionPerM == null ? null : Number(r.priceCompletionPerM),
    supportsTools: r.supportsTools,
    supportsReasoning: r.supportsReasoning,
    featured: r.featured,
    devCapable: r.devCapable,
    releasedAt: r.releasedAt?.toISOString() ?? null,
  }));
}

export async function modelExists(id: string, devOnly: boolean): Promise<boolean> {
  const rows = await db
    .select({ id: schema.modelCatalog.id })
    .from(schema.modelCatalog)
    .where(
      and(
        eq(schema.modelCatalog.id, id),
        devOnly ? eq(schema.modelCatalog.devCapable, true) : raw`true`,
      ),
    )
    .limit(1);
  return rows.length > 0;
}

/** Avvia la risincronizzazione periodica in background. */
export function startModelSync(): NodeJS.Timeout {
  void syncModelCatalog().catch((e) => console.warn('[modelli]', e));
  const intervalMs = env.MODEL_SYNC_INTERVAL_HOURS * 3_600_000;
  const timer = setInterval(() => {
    void syncModelCatalog().catch((e) => console.warn('[modelli]', e));
  }, intervalMs);
  timer.unref();
  return timer;
}
