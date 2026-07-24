import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { env } from './env.js';
import type { SandboxSettings } from '@anthropic-ai/claude-agent-sdk';

/**
 * Directory di lavoro degli agenti.
 *
 *   <root>/<workspaceId>/project     repo condiviso dagli agenti sviluppatore
 *   <root>/<workspaceId>/scratch/<agentId>   spazio privato degli assistenti
 *
 * Gli agenti sviluppatore dello stesso progetto condividono la cartella:
 * è quello che vogliamo, lavorano sullo stesso codice. La separazione che
 * conta è fra progetti diversi, ed è garantita dal container.
 */
export async function resolveWorkDir(args: {
  workspaceId: string;
  agentId: string;
  kind: 'assistant' | 'developer';
}): Promise<string> {
  // Runner locale con una cartella di codice "viva" configurata: gli agenti
  // sviluppatore lavorano DIRETTAMENTE lì — è il tuo codice sul disco, come
  // avere Claude Code aperto in quella cartella, ma dalla chat. Niente clone,
  // niente sottocartelle per workspace.
  if (args.kind === 'developer' && env.HIVE_RUNNER_WORKDIR) {
    await mkdir(env.HIVE_RUNNER_WORKDIR, { recursive: true });
    return env.HIVE_RUNNER_WORKDIR;
  }

  const base = join(env.HIVE_WORKSPACE_ROOT, args.workspaceId);
  const dir =
    args.kind === 'developer' ? join(base, 'project') : join(base, 'scratch', args.agentId);
  await mkdir(dir, { recursive: true });
  return dir;
}

/**
 * Impostazioni del sandbox nativo dell'SDK.
 *
 * È una seconda linea di difesa: il confine forte fra progetti è il
 * container, ma dentro al container conviene comunque restringere ciò che
 * l'agente può toccare e contattare. Con isolamento `local` questa diventa
 * la protezione principale.
 */
export function sandboxFor(args: {
  kind: 'assistant' | 'developer';
  workDir: string;
  /** Domini che l'agente può contattare oltre a quelli dei modelli. */
  allowedDomains: string[];
}): SandboxSettings {
  // Il sandbox nativo dell'SDK (bubblewrap) si attiva SOLO in modalità
  // `sandbox`. In modalità `docker` il confine è il container e qui dentro
  // gira già confinato: attivare anche bwrap sarebbe ridondante e, su questa
  // macchina, fallirebbe. In modalità `none` niente sandbox.
  const isolated = env.AGENT_ISOLATION === 'sandbox';
  return {
    enabled: isolated,
    // Per un agente sviluppatore (che ha la shell) il sandbox è essenziale:
    // se non è disponibile sulla macchina, meglio fallire che eseguire
    // comandi senza confine. Per un assistente, che non ha shell, è meno
    // critico e lasciamo proseguire.
    failIfUnavailable: isolated && args.kind === 'developer',
    // Dentro al sandbox i comandi di shell non hanno bisogno di conferma
    // uno per uno: il confine è già imposto dal sandbox stesso.
    autoAllowBashIfSandboxed: args.kind === 'developer',
    allowUnsandboxedCommands: false,
    network: {
      allowedDomains: [
        'api.anthropic.com',
        'openrouter.ai',
        // I dev agent devono poter scaricare dipendenze e parlare con git.
        ...(args.kind === 'developer'
          ? [
              'github.com',
              'api.github.com',
              'codeload.github.com',
              'registry.npmjs.org',
              'pypi.org',
              'files.pythonhosted.org',
            ]
          : []),
        ...args.allowedDomains,
      ],
      allowLocalBinding: args.kind === 'developer',
    },
  };
}
