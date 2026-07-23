import type { MentionRef } from './domain.js';

/**
 * Le menzioni nel corpo del messaggio sono salvate in forma canonica:
 *   `<@handle>`  utente o agente
 *   `<#nome>`    canale
 *   `<!everyone>`
 * Così il testo resta leggibile anche fuori dall'app e non si rompe se
 * qualcuno cambia nome visualizzato.
 */

const MENTION_RE = /<@([a-z0-9][a-z0-9._-]*)>|<#([a-z0-9][a-z0-9-]*)>|<!(everyone)>/g;

export function parseMentions(body: string): Array<{ kind: 'user' | 'channel' | 'everyone'; handle: string }> {
  const out: Array<{ kind: 'user' | 'channel' | 'everyone'; handle: string }> = [];
  const seen = new Set<string>();
  for (const m of body.matchAll(MENTION_RE)) {
    let entry: { kind: 'user' | 'channel' | 'everyone'; handle: string };
    if (m[1]) entry = { kind: 'user', handle: m[1] };
    else if (m[2]) entry = { kind: 'channel', handle: m[2] };
    else entry = { kind: 'everyone', handle: 'everyone' };

    const key = `${entry.kind}:${entry.handle}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(entry);
  }
  return out;
}

/** Estrae gli handle degli agenti taggati, nell'ordine in cui compaiono. */
export function mentionedHandles(body: string): string[] {
  return parseMentions(body)
    .filter((m) => m.kind === 'user')
    .map((m) => m.handle);
}

/** Vero se il testo tagga esplicitamente questo handle. */
export function mentions(body: string, handle: string): boolean {
  return mentionedHandles(body).includes(handle.toLowerCase());
}

/**
 * Rende il corpo leggibile per un agente: le menzioni diventano @nome
 * così il modello non deve interpretare la sintassi interna.
 */
export function toPlainText(
  body: string,
  resolve: (kind: 'user' | 'channel', handle: string) => string | null,
): string {
  return body.replace(MENTION_RE, (full, user, channel, everyone) => {
    if (user) return resolve('user', user) ?? `@${user}`;
    if (channel) return resolve('channel', channel) ?? `#${channel}`;
    if (everyone) return '@tutti';
    return full;
  });
}

/** Genera un handle valido a partire da un nome libero. */
export function slugifyHandle(name: string): string {
  const base = name
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32);
  return base.length >= 2 ? base : `agente-${Math.random().toString(36).slice(2, 6)}`;
}

/**
 * Palette per gli avatar generati. Tonalità calde e desaturate,
 * coerenti con il resto dell'interfaccia.
 */
export const avatarPalette = [
  '#C6693F', // terracotta
  '#B8873B', // ocra
  '#7C8B4E', // oliva
  '#4E7C6B', // salvia scuro
  '#4A6D8C', // blu polvere
  '#7A5C8E', // prugna
  '#A65160', // rosa antico
  '#8A6A4F', // nocciola
] as const;

export function colorFor(seed: string): string {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  return avatarPalette[h % avatarPalette.length]!;
}

/** Iniziali per gli avatar senza emoji. */
export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase();
  return (parts[0]![0]! + parts[parts.length - 1]![0]!).toUpperCase();
}

/** Formatta i token in forma compatta per la UI (1.2k, 34k). */
export function formatTokens(n: number | null | undefined): string {
  if (n == null) return '—';
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}
