import { hash as argonHash, verify as argonVerify } from '@node-rs/argon2';
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';
import { env } from '../env.js';

/* ---------------------------------------------------------------------------
 * Password
 * ------------------------------------------------------------------------ */

/**
 * Parametri argon2id. Il costo di memoria (19 MiB) è quello raccomandato da
 * OWASP: regge bene su questa macchina e rende il brute force costoso.
 */
const ARGON = {
  memoryCost: 19456,
  timeCost: 2,
  parallelism: 1,
} as const;

export function hashPassword(plain: string): Promise<string> {
  return argonHash(plain, ARGON);
}

export async function verifyPassword(hash: string, plain: string): Promise<boolean> {
  try {
    return await argonVerify(hash, plain);
  } catch {
    // Hash malformato o corrotto: trattalo come credenziale errata.
    return false;
  }
}

/* ---------------------------------------------------------------------------
 * Token di sessione
 * ------------------------------------------------------------------------ */

/**
 * Il token viaggia nel cookie; su DB salviamo solo lo SHA-256.
 * Chi legge il database non può quindi impersonare nessuno.
 */
export function newSessionToken(): { token: string; hash: string } {
  const token = randomBytes(32).toString('base64url');
  return { token, hash: sha256(token) };
}

export function sha256(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

/** Confronto a tempo costante fra due stringhe esadecimali. */
export function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

/** Codice d'invito leggibile ma non indovinabile. */
export function newInviteCode(): string {
  return randomBytes(18).toString('base64url');
}

/* ---------------------------------------------------------------------------
 * Segreti per workspace (API key, token git, credenziali HTTP)
 * ------------------------------------------------------------------------ */

const SECRET_KEY = Buffer.from(env.SECRETS_KEY, 'hex');

/**
 * AES-256-GCM. Formato salvato: `iv.tag.ciphertext`, tutto in base64url.
 * GCM autentica il testo cifrato: una manomissione fa fallire il decrypt
 * invece di restituire spazzatura.
 */
export function encryptSecret(plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', SECRET_KEY, iv);
  const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [iv.toString('base64url'), tag.toString('base64url'), enc.toString('base64url')].join('.');
}

export function decryptSecret(stored: string): string {
  const parts = stored.split('.');
  if (parts.length !== 3) throw new Error('segreto in formato non valido');
  const [ivB64, tagB64, dataB64] = parts as [string, string, string];
  const decipher = createDecipheriv(
    'aes-256-gcm',
    SECRET_KEY,
    Buffer.from(ivB64, 'base64url'),
  );
  decipher.setAuthTag(Buffer.from(tagB64, 'base64url'));
  return Buffer.concat([
    decipher.update(Buffer.from(dataB64, 'base64url')),
    decipher.final(),
  ]).toString('utf8');
}

/** Anteprima non sensibile da mostrare in UI, es. `sk-ant-…f3a9`. */
export function secretHint(plain: string): string {
  if (plain.length <= 8) return '…';
  return `${plain.slice(0, 7)}…${plain.slice(-4)}`;
}
