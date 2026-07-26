import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Quanto abbonamento Claude Code è già stato consumato.
 *
 * Il dato lo tiene Anthropic e Claude Code lo chiede a `/api/oauth/usage` con
 * le credenziali salvate sulla macchina. Ha senso leggerlo QUI e non sul
 * server: il tetto è di chi esegue davvero i turni, cioè di questa macchina.
 * Un runner su un altro computer ha un altro abbonamento e altri numeri.
 *
 * Questo file finisce nel bundle del runner, quindi non importa niente: solo
 * `fetch` e i moduli di Node. È la regola che ho già violato una volta oggi
 * tirandoci dentro Redis, e il runner non partiva più.
 */

export interface UsageWindow {
  /** Percentuale consumata, 0-100. */
  utilization: number;
  /** Quando riparte da zero. */
  resetsAt: string | null;
}

export interface SubscriptionUsage {
  fiveHour: UsageWindow | null;
  sevenDay: UsageWindow | null;
  /** Quando l'abbiamo chiesto: serve a non far sembrare fresco un dato vecchio. */
  at: string;
}

/**
 * Un minuto di cache.
 *
 * Il battito parte ogni dieci secondi: chiamare Anthropic a ogni giro sarebbe
 * sei volte al minuto per un numero che si muove piano, e per giunta sulla
 * stessa quota che stiamo misurando.
 */
const TTL_MS = 60_000;

let cached: { at: number; value: SubscriptionUsage } | null = null;
let inFlight: Promise<SubscriptionUsage | null> | null = null;

function readWindow(raw: unknown): UsageWindow | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as { utilization?: unknown; resets_at?: unknown };
  if (typeof o.utilization !== 'number') return null;
  return {
    utilization: o.utilization,
    resetsAt: typeof o.resets_at === 'string' ? o.resets_at : null,
  };
}

async function fetchUsage(): Promise<SubscriptionUsage | null> {
  let token: string;
  try {
    const raw = await readFile(join(homedir(), '.claude', '.credentials.json'), 'utf8');
    const creds = JSON.parse(raw) as { claudeAiOauth?: { accessToken?: string } };
    if (!creds.claudeAiOauth?.accessToken) return null;
    token = creds.claudeAiOauth.accessToken;
  } catch {
    // Nessuna credenziale: questa macchina va ad API key, e allora non c'è
    // nessun abbonamento da misurare.
    return null;
  }

  try {
    const res = await fetch('https://api.anthropic.com/api/oauth/usage', {
      headers: {
        authorization: `Bearer ${token}`,
        'anthropic-beta': 'oauth-2025-04-20',
        'content-type': 'application/json',
      },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as Record<string, unknown>;
    return {
      fiveHour: readWindow(data.five_hour),
      sevenDay: readWindow(data.seven_day),
      at: new Date().toISOString(),
    };
  } catch {
    return null;
  }
}

/**
 * L'uso corrente, con cache.
 *
 * Non lancia mai: se il dato non c'è si restituisce `null` e chi chiama non
 * mostra niente. Un contatore che sbaglia è peggio di un contatore assente —
 * su questo si prendono decisioni («faccio partire questo lavoro adesso?»).
 */
export async function subscriptionUsage(): Promise<SubscriptionUsage | null> {
  if (cached && Date.now() - cached.at < TTL_MS) return cached.value;
  if (inFlight) return inFlight;

  inFlight = fetchUsage()
    .then((value) => {
      if (value) cached = { at: Date.now(), value };
      return value ?? cached?.value ?? null;
    })
    .finally(() => {
      inFlight = null;
    });
  return inFlight;
}
