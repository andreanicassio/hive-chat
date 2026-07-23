import { createDecipheriv } from 'node:crypto';
import { env } from './env.js';

const KEY = Buffer.from(env.SECRETS_KEY, 'hex');

/**
 * Decifra i segreti del workspace scritti dal server.
 * Formato: `iv.tag.ciphertext`, tutto in base64url, AES-256-GCM.
 * Il runtime non cifra mai nulla: gli serve solo leggere.
 */
export function decryptSecret(stored: string): string {
  const parts = stored.split('.');
  if (parts.length !== 3) throw new Error('segreto in formato non valido');
  const [ivB64, tagB64, dataB64] = parts as [string, string, string];
  const decipher = createDecipheriv('aes-256-gcm', KEY, Buffer.from(ivB64, 'base64url'));
  decipher.setAuthTag(Buffer.from(tagB64, 'base64url'));
  return Buffer.concat([
    decipher.update(Buffer.from(dataB64, 'base64url')),
    decipher.final(),
  ]).toString('utf8');
}
