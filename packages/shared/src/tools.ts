import { z } from 'zod';
import type { AgentKind } from './domain.js';

/**
 * Catalogo dei tool assegnabili a un agente al momento della creazione.
 *
 * Ogni voce mappa su uno o più tool reali del Claude Agent SDK:
 *  - `sdk`     → tool nativi dell'SDK (Read, Bash, WebSearch, ...)
 *  - `hive`    → tool custom in-process esposti via createSdkMcpServer()
 *  - `mcp`     → server MCP esterni, configurati a parte sull'agente
 *
 * `sdkTools` è la lista di nomi che finisce in `allowedTools`. I tool non
 * concessi non vengono elencati e restano quindi bloccati.
 */

export type ToolKind = 'sdk' | 'hive';

export interface ToolDef {
  id: string;
  label: string;
  /** Mostrata nella UI di creazione agente. */
  description: string;
  kind: ToolKind;
  /** Nomi tool passati ad `allowedTools` dell'SDK. */
  sdkTools: string[];
  /** Per quali tipi di agente è proponibile. */
  availableFor: AgentKind[];
  /** L'azione è irreversibile o esce dal perimetro: chiede sempre conferma umana. */
  dangerous: boolean;
  /** Raggruppamento nella UI. */
  group: 'conoscenza' | 'workspace' | 'integrazioni' | 'codice' | 'sistema';
  icon: string;
  /** Schema della config specifica del tool, se ne ha una. */
  configSchema?: z.ZodTypeAny;
}

export const toolCatalog: ToolDef[] = [
  /* --- Conoscenza -------------------------------------------------------- */
  {
    id: 'web.search',
    label: 'Ricerca web',
    description: 'Cerca sul web informazioni aggiornate oltre la data di training.',
    kind: 'sdk',
    sdkTools: ['WebSearch'],
    availableFor: ['assistant', 'developer'],
    dangerous: false,
    group: 'conoscenza',
    icon: 'search',
  },
  {
    id: 'web.fetch',
    label: 'Apri pagina web',
    description: 'Scarica e legge il contenuto di un URL specifico.',
    kind: 'sdk',
    sdkTools: ['WebFetch'],
    availableFor: ['assistant', 'developer'],
    dangerous: false,
    group: 'conoscenza',
    icon: 'globe',
  },

  /* --- Workspace --------------------------------------------------------- */
  {
    id: 'hive.search_messages',
    label: 'Cerca nelle conversazioni',
    description: 'Cerca nello storico dei canali a cui l\'agente ha accesso.',
    kind: 'hive',
    sdkTools: ['mcp__hive__search_messages'],
    availableFor: ['assistant', 'developer'],
    dangerous: false,
    group: 'workspace',
    icon: 'message-search',
  },
  {
    id: 'hive.read_channel',
    label: 'Leggi un canale',
    description: 'Legge i messaggi recenti di un canale per farsi il contesto.',
    kind: 'hive',
    sdkTools: ['mcp__hive__read_channel'],
    availableFor: ['assistant', 'developer'],
    dangerous: false,
    group: 'workspace',
    icon: 'hash',
  },
  {
    id: 'hive.post_message',
    label: 'Scrivi in un canale',
    description: 'Pubblica un messaggio in un altro canale del progetto.',
    kind: 'hive',
    sdkTools: ['mcp__hive__post_message'],
    availableFor: ['assistant', 'developer'],
    dangerous: false,
    group: 'workspace',
    icon: 'send',
  },
  {
    id: 'hive.handoff',
    label: 'Passa la palla a un altro agente',
    description:
      'Tagga un altro agente del progetto e gli affida il seguito del lavoro.',
    kind: 'hive',
    sdkTools: ['mcp__hive__handoff'],
    availableFor: ['assistant', 'developer'],
    dangerous: false,
    group: 'workspace',
    icon: 'arrow-right',
  },
  {
    id: 'hive.memory',
    label: 'Memoria di progetto',
    description:
      'Legge e aggiorna il contesto condiviso del progetto, visibile a tutti gli agenti.',
    kind: 'hive',
    sdkTools: ['mcp__hive__read_memory', 'mcp__hive__write_memory'],
    availableFor: ['assistant', 'developer'],
    dangerous: false,
    group: 'workspace',
    icon: 'brain',
  },
  {
    id: 'hive.artifacts',
    label: 'Checklist e documenti',
    description:
      'Crea e aggiorna to-do list e documenti accanto alla chat: spunta le voci mentre lavora e tiene appunti condivisi, visibili in tempo reale.',
    kind: 'hive',
    sdkTools: [
      'mcp__hive__list_artifacts',
      'mcp__hive__create_artifact',
      'mcp__hive__update_artifact',
      'mcp__hive__add_checklist_item',
      'mcp__hive__check_item',
    ],
    availableFor: ['assistant', 'developer'],
    dangerous: false,
    group: 'workspace',
    icon: 'list-checks',
  },

  /* --- Integrazioni ------------------------------------------------------ */
  {
    id: 'http.request',
    label: 'Chiamata HTTP',
    description:
      'Chiama una API esterna. Limitato agli host che autorizzi; le credenziali restano sul server.',
    kind: 'hive',
    sdkTools: ['mcp__hive__http_request'],
    availableFor: ['assistant', 'developer'],
    dangerous: false,
    group: 'integrazioni',
    icon: 'plug',
    configSchema: z.object({
      allowedHosts: z
        .array(z.string().min(1).max(200))
        .min(1, 'indica almeno un host')
        .max(50),
      /** Nomi delle chiavi nei segreti del workspace da iniettare negli header. */
      credentialKey: z.string().max(64).nullable().default(null),
      /** Header in cui iniettare il segreto, es. "Authorization". */
      credentialHeader: z.string().max(64).default('Authorization'),
      /** Prefisso del valore, es. "Bearer ". */
      credentialPrefix: z.string().max(32).default('Bearer '),
      /** Metodi che l'agente può usare. */
      methods: z
        .array(z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']))
        .default(['GET']),
    }),
  },

  /* --- Codice (solo agenti sviluppatore) --------------------------------- */
  {
    id: 'code.read',
    label: 'Leggi il codice',
    description: 'Legge file, cerca per pattern e per contenuto nel repo.',
    kind: 'sdk',
    sdkTools: ['Read', 'Glob', 'Grep'],
    availableFor: ['developer'],
    dangerous: false,
    group: 'codice',
    icon: 'file-code',
  },
  {
    id: 'code.write',
    label: 'Modifica il codice',
    description: 'Crea e modifica file nel repo del progetto.',
    kind: 'sdk',
    sdkTools: ['Write', 'Edit', 'NotebookEdit'],
    availableFor: ['developer'],
    dangerous: false,
    group: 'codice',
    icon: 'pencil',
  },
  {
    id: 'code.shell',
    label: 'Terminale',
    description:
      'Esegue comandi nel container del progetto: build, test, linter, git locale.',
    kind: 'sdk',
    sdkTools: ['Bash', 'BashOutput', 'KillShell'],
    availableFor: ['developer'],
    dangerous: false,
    group: 'codice',
    icon: 'terminal',
  },
  {
    id: 'code.subagents',
    label: 'Subagent',
    description:
      'Delega sotto-task ad agenti specializzati in parallelo (esplorazione, review).',
    kind: 'sdk',
    sdkTools: ['Agent'],
    availableFor: ['developer'],
    dangerous: false,
    group: 'codice',
    icon: 'users',
  },
  {
    id: 'code.push',
    label: 'Push e Pull Request',
    description:
      'Pubblica il lavoro sul remoto. Ogni push passa da una conferma umana in chat.',
    kind: 'hive',
    sdkTools: ['mcp__hive__git_push', 'mcp__hive__open_pull_request'],
    availableFor: ['developer'],
    dangerous: true,
    group: 'codice',
    icon: 'git-branch',
  },
  {
    id: 'code.deploy',
    label: 'Deploy',
    description:
      'Lancia il comando di deploy configurato. Richiede sempre conferma umana in chat.',
    kind: 'hive',
    sdkTools: ['mcp__hive__deploy'],
    availableFor: ['developer'],
    dangerous: true,
    group: 'sistema',
    icon: 'rocket',
    configSchema: z.object({
      command: z.string().min(1).max(500),
      /** Ambiente mostrato nella card di conferma. */
      environment: z.string().max(32).default('production'),
    }),
  },
];

export const toolById = new Map(toolCatalog.map((t) => [t.id, t]));

/** Tool proposti di default alla creazione, per tipo di agente. */
export const defaultToolIds: Record<AgentKind, string[]> = {
  assistant: ['web.search', 'web.fetch', 'hive.search_messages', 'hive.memory', 'hive.artifacts'],
  developer: [
    'code.read',
    'code.write',
    'code.shell',
    'code.subagents',
    'web.search',
    'web.fetch',
    'hive.search_messages',
    'hive.memory',
    'hive.artifacts',
  ],
};

/** Espande i tool concessi nella lista `allowedTools` per l'SDK. */
export function resolveAllowedTools(
  grants: Array<{ toolId: string }>,
  kind: AgentKind,
): string[] {
  const out = new Set<string>();
  for (const g of grants) {
    const def = toolById.get(g.toolId);
    if (!def) continue;
    if (!def.availableFor.includes(kind)) continue;
    for (const t of def.sdkTools) out.add(t);
  }
  return [...out];
}

/**
 * Tool SDK built-in da NON esporre al modello perché non concessi.
 *
 * L'Agent SDK mostra al modello tutti i suoi tool nativi (Read, Bash,
 * WebSearch...) a meno che non siano in `disallowedTools`. Senza questo,
 * un agente prova tool che non ha e li vede negati uno per uno — brutto da
 * vedere e uno spreco di turni. Qui blocchiamo a monte tutti i tool built-in
 * del catalogo che l'agente non ha ricevuto.
 *
 * I tool MCP (`mcp__hive__*`) non passano di qui: quelli non concessi non
 * vengono proprio registrati nel server MCP.
 */
export function resolveDisallowedTools(
  grants: Array<{ toolId: string }>,
  kind: AgentKind,
): string[] {
  const allowed = new Set(resolveAllowedTools(grants, kind));
  const disallowed = new Set<string>();
  for (const def of toolCatalog) {
    for (const t of def.sdkTools) {
      if (t.startsWith('mcp__')) continue;
      if (!allowed.has(t)) disallowed.add(t);
    }
  }
  return [...disallowed];
}

/**
 * Tool SDK da bloccare esplicitamente.
 * Un agente `assistant` non deve poter toccare filesystem o shell nemmeno
 * per errore di configurazione: li neghiamo in modo esplicito.
 */
export const assistantDeniedTools = [
  'Bash',
  'BashOutput',
  'KillShell',
  'Read',
  'Write',
  'Edit',
  'NotebookEdit',
  'Glob',
  'Grep',
  'Agent',
];

/** I tool marcati `dangerous` richiedono sempre conferma umana. */
export function dangerousToolNames(grants: Array<{ toolId: string; requireApproval?: boolean }>): Set<string> {
  const out = new Set<string>();
  for (const g of grants) {
    const def = toolById.get(g.toolId);
    if (!def) continue;
    if (def.dangerous || g.requireApproval) {
      for (const t of def.sdkTools) out.add(t);
    }
  }
  return out;
}

/**
 * Per ogni tool `hive.*` del catalogo, i nomi dei tool MCP che espone.
 * Serve al runtime per registrare nel server MCP solo i tool concessi.
 */
export function grantedHiveToolNames(grants: Array<{ toolId: string }>): Set<string> {
  const names = new Set<string>();
  for (const g of grants) {
    const def = toolById.get(g.toolId);
    if (!def) continue;
    for (const t of def.sdkTools) {
      if (t.startsWith('mcp__hive__')) names.add(t.slice('mcp__hive__'.length));
    }
  }
  return names;
}
