import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { and, eq } from 'drizzle-orm';
import { schema } from '@hive/db';
import { db } from './db.js';
import { decryptSecret } from './crypto.js';
import type { RepoConfig } from '@hive/shared';

const exec = promisify(execFile);

/**
 * Prepara il codebase su cui lavora un agente sviluppatore.
 *
 * Se l'agente ha un repository GitHub configurato, lo clona (o lo aggiorna
 * se già presente) nella directory di lavoro del progetto. Il token per
 * l'accesso arriva dai segreti del workspace e NON finisce mai nel repo:
 * lo usiamo solo per le operazioni git eseguite dal runtime, mai passato
 * al modello.
 *
 * Gli agenti dello stesso progetto condividono questa directory: se è già
 * clonata da un run precedente, facciamo solo un fetch + reset invece di
 * riclonare da zero.
 */

export interface RepoStatus {
  ready: boolean;
  hasRepo: boolean;
  branch: string | null;
  detail: string;
}

async function githubToken(workspaceId: string, key: string | null): Promise<string | null> {
  // Prova prima la chiave indicata sull'agente, poi il GITHUB_TOKEN del progetto.
  const candidates = [key, 'GITHUB_TOKEN'].filter((k): k is string => Boolean(k));
  for (const k of candidates) {
    const rows = await db
      .select({ value: schema.workspaceSecrets.valueEncrypted })
      .from(schema.workspaceSecrets)
      .where(
        and(
          eq(schema.workspaceSecrets.workspaceId, workspaceId),
          eq(schema.workspaceSecrets.key, k),
        ),
      )
      .limit(1);
    if (rows[0]) {
      try {
        return decryptSecret(rows[0].value);
      } catch {
        /* prova il prossimo */
      }
    }
  }
  return null;
}

/** Inserisce il token nell'URL https per l'autenticazione git. */
function authedUrl(gitUrl: string, token: string | null): string {
  if (!token) return gitUrl;
  try {
    const u = new URL(gitUrl);
    if (u.protocol !== 'https:') return gitUrl;
    // Formato accettato dai fine-grained PAT di GitHub.
    u.username = 'x-access-token';
    u.password = token;
    return u.toString();
  } catch {
    return gitUrl;
  }
}

async function git(cwd: string, args: string[], token?: string | null): Promise<string> {
  const { stdout } = await exec('git', args, {
    cwd,
    timeout: 180_000,
    maxBuffer: 16 * 1024 * 1024,
    env: {
      ...process.env,
      // Niente prompt interattivi: se manca l'auth, fallisce subito.
      GIT_TERMINAL_PROMPT: '0',
      GIT_ASKPASS: '',
      ...(token ? { GIT_AUTHOR_NAME: 'Hive Agent', GIT_COMMITTER_NAME: 'Hive Agent' } : {}),
    },
  });
  return stdout.trim();
}

export async function prepareRepo(args: {
  workspaceId: string;
  workDir: string;
  repo: RepoConfig | null;
}): Promise<RepoStatus> {
  const { repo, workDir, workspaceId } = args;

  if (!repo?.gitUrl) {
    return { ready: true, hasRepo: false, branch: null, detail: 'nessun repository configurato' };
  }

  const token = await githubToken(workspaceId, repo.credentialKey);
  const branch = repo.branch || 'main';
  const gitDir = join(workDir, '.git');

  try {
    if (existsSync(gitDir)) {
      // Repo già presente: aggiorniamo al branch richiesto senza riclonare.
      await git(workDir, ['remote', 'set-url', 'origin', authedUrl(repo.gitUrl, token)], token);
      await git(workDir, ['fetch', '--depth', '1', 'origin', branch], token);
      await git(workDir, ['checkout', '-B', branch, `origin/${branch}`], token);
      // Riportiamo il remote a un URL pulito (senza token in .git/config).
      await git(workDir, ['remote', 'set-url', 'origin', repo.gitUrl], token);
      return { ready: true, hasRepo: true, branch, detail: `repository aggiornato su ${branch}` };
    }

    // Primo clone. Se la directory ha spazzatura non-git, la ripuliamo.
    if (existsSync(workDir)) {
      const entries = await import('node:fs/promises').then((m) => m.readdir(workDir));
      if (entries.length > 0) await rm(workDir, { recursive: true, force: true });
    }
    await exec(
      'git',
      ['clone', '--depth', '1', '--branch', branch, authedUrl(repo.gitUrl, token), workDir],
      { timeout: 300_000, maxBuffer: 16 * 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } },
    );
    // Rimuoviamo il token dall'URL salvato nel repo.
    await git(workDir, ['remote', 'set-url', 'origin', repo.gitUrl], token);

    // Comando di setup una tantum (npm install, ecc.), se configurato.
    if (repo.setupCommand?.trim()) {
      try {
        await exec('bash', ['-lc', repo.setupCommand], {
          cwd: workDir,
          timeout: 600_000,
          maxBuffer: 32 * 1024 * 1024,
        });
      } catch (err) {
        // Il setup fallito non blocca il run: l'agente può ancora lavorare.
        console.warn('[repo] setup fallito:', err instanceof Error ? err.message : err);
      }
    }

    return { ready: true, hasRepo: true, branch, detail: `repository clonato (${branch})` };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      ready: false,
      hasRepo: true,
      branch,
      detail: token
        ? `clone/aggiornamento fallito: ${message.slice(0, 200)}`
        : `serve un token GitHub nei segreti del progetto (chiave ${repo.credentialKey ?? 'GITHUB_TOKEN'}) per accedere a ${repo.gitUrl}`,
    };
  }
}

/**
 * Esegue il push del lavoro dell'agente sul remoto.
 * Chiamato dal tool `git_push` DOPO l'approvazione umana.
 */
export async function pushBranch(args: {
  workspaceId: string;
  workDir: string;
  repo: RepoConfig | null;
  branch: string;
  message: string;
}): Promise<{ ok: boolean; detail: string }> {
  const { repo, workDir, workspaceId, branch, message } = args;
  if (!repo?.gitUrl) return { ok: false, detail: 'nessun repository configurato per questo agente' };

  const token = await githubToken(workspaceId, repo.credentialKey);
  if (!token) {
    return {
      ok: false,
      detail: `serve un token GitHub (chiave ${repo.credentialKey ?? 'GITHUB_TOKEN'}) con permesso di scrittura`,
    };
  }

  try {
    // Committiamo qualsiasi modifica in sospeso lasciata dall'agente.
    await git(workDir, ['add', '-A']);
    const status = await git(workDir, ['status', '--porcelain']);
    if (status) {
      await git(workDir, ['commit', '-m', message || 'Modifiche di un agente Hive']);
    }
    await git(workDir, ['remote', 'set-url', 'origin', authedUrl(repo.gitUrl, token)], token);
    await git(workDir, ['push', 'origin', `HEAD:${branch}`], token);
    await git(workDir, ['remote', 'set-url', 'origin', repo.gitUrl], token);
    return { ok: true, detail: `push su ${branch} completato` };
  } catch (err) {
    // Ripristina l'URL pulito anche in caso di errore.
    await git(workDir, ['remote', 'set-url', 'origin', repo.gitUrl]).catch(() => {});
    return { ok: false, detail: `push fallito: ${err instanceof Error ? err.message : String(err)}` };
  }
}
