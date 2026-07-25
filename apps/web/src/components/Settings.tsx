import { useEffect, useState } from 'react';
import clsx from 'clsx';
import {
  BadgeCheck,
  Bell,
  Palette,
  Brain,
  Check,
  Copy,
  KeyRound,
  Loader2,
  Plus,
  Trash2,
  TriangleAlert,
  UserPlus,
  X,
  BarChart3,
  Cpu,
} from 'lucide-react';
import { useStore } from '../store.js';
import { Usage } from './Usage.js';
import { Modal } from './Modal.js';
import { applyTheme, setThemePref, storedPref, type ThemePref } from '../lib/theme.js';
import { disablePush, enablePush, pushState, type PushState } from '../lib/push.js';
import type { PushPrefs } from '../lib/api.js';
import { RunnerTab } from './RunnerTab.js';
import { api, ApiError } from '../lib/api.js';
import { Avatar } from './Avatar.js';

/**
 * Area di amministrazione del progetto.
 *
 * Le chiavi si impostano qui invece che nel .env del server: sono cifrate
 * su database (AES-256-GCM) e valgono solo per questo progetto, così team
 * diversi possono avere conti diversi. Il valore non torna mai indietro dal
 * server — si vede solo un troncone per riconoscerlo.
 */

type Tab = 'credenziali' | 'contesto' | 'runner' | 'persone' | 'utilizzo' | 'aspetto' | 'notifiche';

interface SecretRow {
  key: string;
  hint: string | null;
  updatedAt: string;
}

/** Chiavi note, con spiegazione di cosa abilitano. */
const KNOWN_KEYS: Array<{
  key: string;
  label: string;
  help: string;
  placeholder: string;
}> = [
  {
    key: 'CLAUDE_CODE_OAUTH_TOKEN',
    label: 'Token abbonamento Claude',
    help: 'Fa girare gli agenti Claude sul tuo abbonamento invece che a consumo. Generalo sul server con `claude setup-token`.',
    placeholder: 'sk-ant-oat01-…',
  },
  {
    key: 'ANTHROPIC_API_KEY',
    label: 'API key Anthropic',
    help: 'Alternativa all’abbonamento, a consumo. Da platform.claude.com.',
    placeholder: 'sk-ant-api03-…',
  },
  {
    key: 'OPENROUTER_API_KEY',
    label: 'API key OpenRouter',
    help: 'Abilita gli agenti assistente su tutti i modelli non-Claude: Gemini, GPT, Kimi, Qwen, DeepSeek…',
    placeholder: 'sk-or-v1-…',
  },
  {
    key: 'GITHUB_TOKEN',
    label: 'Token GitHub',
    help: 'Serve agli agenti sviluppatore per clonare e pushare. Usa un fine-grained token limitato ai repo che vuoi.',
    placeholder: 'github_pat_…',
  },
];

function SecretField({
  spec,
  existing,
  onSaved,
  onDeleted,
}: {
  spec: (typeof KNOWN_KEYS)[number];
  existing: SecretRow | undefined;
  onSaved: () => void;
  onDeleted: () => void;
}) {
  const workspace = useStore((s) => s.workspace);
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    if (!value.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await api.setSecret(workspace!.id, spec.key, value.trim());
      setValue('');
      setSaved(true);
      setTimeout(() => setSaved(false), 2200);
      onSaved();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Salvataggio non riuscito');
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    setBusy(true);
    try {
      await api.deleteSecret(workspace!.id, spec.key);
      onDeleted();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="rounded-[11px] border border-[var(--color-line)] p-3.5">
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="text-[14px] font-medium">{spec.label}</span>
            {existing && (
              <span className="flex items-center gap-1 rounded-full bg-[color-mix(in_oklab,var(--color-online)_16%,transparent)] px-2 py-px text-[11px] font-medium text-[var(--color-online)]">
                <BadgeCheck size={11} strokeWidth={2.4} /> impostata
              </span>
            )}
          </div>
          <p className="mt-0.5 text-[12.5px] leading-snug text-[var(--color-ink-soft)]">
            {spec.help}
          </p>
          <code className="mt-1 block font-mono text-[11px] text-[var(--color-ink-faint)]">
            {spec.key}
          </code>
        </div>
        {existing && (
          <button
            onClick={() => void remove()}
            disabled={busy}
            className="shrink-0 rounded-lg p-1.5 text-[var(--color-ink-faint)] transition-colors hover:bg-[var(--color-sunken)] hover:text-[var(--color-error)]"
            title="Rimuovi"
          >
            <Trash2 size={14} />
          </button>
        )}
      </div>

      <div className="mt-2.5 flex gap-2">
        <input
          type="password"
          className="field flex-1 font-mono text-[13px]"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder={existing ? `${existing.hint ?? '••••'} — incolla per sostituire` : spec.placeholder}
          onKeyDown={(e) => e.key === 'Enter' && void save()}
          autoComplete="off"
          spellCheck={false}
        />
        <button className="btn btn-primary" onClick={() => void save()} disabled={busy || !value.trim()}>
          {busy ? (
            <Loader2 size={14} className="animate-spin" />
          ) : saved ? (
            <Check size={14} />
          ) : null}
          {saved ? 'Salvata' : existing ? 'Sostituisci' : 'Salva'}
        </button>
      </div>

      {error && <p className="mt-1.5 text-[12.5px] text-[var(--color-error)]">{error}</p>}
    </div>
  );
}

export function Settings({ onClose }: { onClose: () => void }) {
  const workspace = useStore((s) => s.workspace);
  const members = useStore((s) => s.members);
  const capabilities = useStore((s) => s.capabilities);

  const [tab, setTab] = useState<Tab>('credenziali');
  const [secrets, setSecrets] = useState<SecretRow[]>([]);
  const [notes, setNotes] = useState('');
  const [autoSummary, setAutoSummary] = useState<string | null>(null);
  const [autoUpdatedAt, setAutoUpdatedAt] = useState<string | null>(null);
  const [notesSaved, setNotesSaved] = useState(false);
  const [inviteUrl, setInviteUrl] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [loading, setLoading] = useState(true);

  const reloadSecrets = () => {
    void api
      .secrets(workspace!.id)
      .then(({ secrets }) => setSecrets(secrets))
      .catch(() => {});
  };

  useEffect(() => {
    if (!workspace) return;
    Promise.allSettled([
      api.secrets(workspace.id).then(({ secrets }) => setSecrets(secrets)),
      api.context(workspace.id).then(({ context }) => {
        setNotes(context.manualNotes ?? '');
        setAutoSummary(context.autoSummary);
        setAutoUpdatedAt(context.autoUpdatedAt);
      }),
    ]).finally(() => setLoading(false));
  }, [workspace]);

  async function saveNotes() {
    await api.saveContext(workspace!.id, notes.trim() || null);
    setNotesSaved(true);
    setTimeout(() => setNotesSaved(false), 2200);
  }

  async function makeInvite() {
    const { invite } = await api.createInvite(workspace!.id, { role: 'member' });
    setInviteUrl(invite.url);
  }

  const byKey = new Map(secrets.map((s) => [s.key, s]));

  return (
    <Modal
      onClose={onClose}
      size="lg"
      tall
      flush
      icon={<span className="text-[17px]">{workspace?.iconEmoji}</span>}
      title={`Impostazioni · ${workspace?.name ?? ''}`}
    >

        {/* Le tab scorrono in orizzontale. Erano cinque, ora sono sette: senza
            scorrimento le ultime finivano semplicemente fuori dal pannello, e
            «Notifiche» non si poteva raggiungere in nessun modo. */}
        <nav className="flex shrink-0 gap-1 overflow-x-auto border-b border-[var(--color-line)] px-4 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          {(
            [
              ['credenziali', 'Credenziali', KeyRound],
              ['contesto', 'Contesto', Brain],
              ['runner', 'Runner', Cpu],
              ['persone', 'Persone', UserPlus],
              ['utilizzo', 'Utilizzo', BarChart3],
              ['aspetto', 'Aspetto', Palette],
              ['notifiche', 'Notifiche', Bell],
            ] as const
          ).map(([id, label, Icon]) => (
            <button
              key={id}
              onClick={() => setTab(id)}
              className={clsx(
                'flex shrink-0 items-center gap-1.5 border-b-2 px-2.5 py-2 text-[13.5px] whitespace-nowrap transition-colors',
                tab === id
                  ? 'border-[var(--color-honey)] font-medium text-[var(--color-ink)]'
                  : 'border-transparent text-[var(--color-ink-soft)] hover:text-[var(--color-ink)]',
              )}
            >
              <Icon size={14} strokeWidth={2.1} className="shrink-0" />
              {label}
            </button>
          ))}
        </nav>

        <div className="min-h-0 flex-1 overflow-y-auto p-5">
          {loading ? (
            <div className="flex justify-center py-10">
              <Loader2 size={18} className="animate-spin text-[var(--color-ink-faint)]" />
            </div>
          ) : tab === 'credenziali' ? (
            <div className="space-y-3">
              {/* Stato reale, non un'ipotesi. */}
              <div
                className={clsx(
                  'flex items-start gap-2.5 rounded-[11px] px-3.5 py-3',
                  capabilities.anthropicConfigured
                    ? 'bg-[color-mix(in_oklab,var(--color-online)_11%,transparent)]'
                    : 'bg-[color-mix(in_oklab,var(--color-busy)_14%,transparent)]',
                )}
              >
                {capabilities.anthropicConfigured ? (
                  <BadgeCheck size={16} className="mt-px shrink-0 text-[var(--color-online)]" />
                ) : (
                  <TriangleAlert size={16} className="mt-px shrink-0 text-[var(--color-busy)]" />
                )}
                <div className="text-[13px]">
                  <div className="font-medium">
                    Agenti Claude:{' '}
                    {capabilities.anthropicConfigured ? 'attivi' : 'non configurati'}
                  </div>
                  <div className="text-[var(--color-ink-soft)]">
                    {capabilities.claudeAuthLabel}
                  </div>
                  <div className="mt-1 text-[var(--color-ink-soft)]">
                    Modelli non-Claude:{' '}
                    {capabilities.openrouterConfigured
                      ? 'attivi via OpenRouter'
                      : 'servono le chiavi qui sotto'}
                  </div>
                </div>
              </div>

              <p className="text-[12.5px] text-[var(--color-ink-soft)]">
                Le chiavi impostate qui valgono solo per questo progetto e hanno la
                precedenza su quelle del server. Sono cifrate sul database e non tornano
                mai indietro: puoi sostituirle, non rileggerle.
              </p>

              {KNOWN_KEYS.map((spec) => (
                <SecretField
                  key={spec.key}
                  spec={spec}
                  existing={byKey.get(spec.key)}
                  onSaved={reloadSecrets}
                  onDeleted={reloadSecrets}
                />
              ))}
            </div>
          ) : tab === 'contesto' ? (
            <div className="space-y-5">
              <div>
                <div className="mb-1.5 text-[13px] font-medium text-[var(--color-ink-soft)]">
                  Le tue note
                </div>
                <p className="mb-2 text-[12.5px] text-[var(--color-ink-soft)]">
                  Quello che scrivi qui lo vedono <strong>tutti</strong> gli agenti del
                  progetto, in ogni canale. Serve per le cose stabili: com'è fatto il
                  prodotto, chi sono i clienti, che tono usare, cosa non fare mai. Non
                  vengono mai sovrascritte dagli agenti.
                </p>
                <textarea
                  className="field h-auto w-full py-2.5 font-normal leading-relaxed"
                  rows={9}
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  placeholder={
                    'Es.\n' +
                    '- Studey è una piattaforma di studio per universitari.\n' +
                    '- Parliamo agli studenti dando del tu, mai formale.\n' +
                    '- Le decisioni di prodotto passano sempre da Andrea.\n' +
                    '- Non promettere date di rilascio.'
                  }
                  maxLength={20000}
                />
                <div className="mt-2.5 flex items-center gap-2">
                  <button className="btn btn-primary h-8" onClick={() => void saveNotes()}>
                    {notesSaved ? <Check size={14} /> : null}
                    {notesSaved ? 'Salvato' : 'Salva le tue note'}
                  </button>
                  <span className="text-[12px] text-[var(--color-ink-faint)]">
                    {notes.length}/20000
                  </span>
                </div>
              </div>

              {/* Note che gli agenti hanno aggiunto da soli (write_memory). */}
              <div>
                <div className="mb-1.5 flex items-center gap-2 text-[13px] font-medium text-[var(--color-ink-soft)]">
                  <Brain size={14} strokeWidth={2.1} />
                  Note degli agenti
                  {autoUpdatedAt && (
                    <span className="text-[11.5px] font-normal text-[var(--color-ink-faint)]">
                      · ultimo aggiornamento{' '}
                      {new Date(autoUpdatedAt).toLocaleString('it-IT', {
                        day: 'numeric',
                        month: 'short',
                        hour: '2-digit',
                        minute: '2-digit',
                      })}
                    </span>
                  )}
                </div>
                <p className="mb-2 text-[12.5px] text-[var(--color-ink-soft)]">
                  Quello che gli agenti hanno salvato con la memoria di progetto durante il
                  lavoro. Cresce da solo; le tue note qui sopra hanno sempre la precedenza.
                </p>
                {autoSummary?.trim() ? (
                  <pre className="max-h-72 overflow-auto whitespace-pre-wrap rounded-[10px] border border-[var(--color-line)] bg-[var(--color-panel-alt)] px-3.5 py-3 font-sans text-[13px] leading-relaxed">
                    {autoSummary}
                  </pre>
                ) : (
                  <div className="rounded-[10px] border border-dashed border-[var(--color-line-strong)] px-3.5 py-4 text-center text-[12.5px] text-[var(--color-ink-faint)]">
                    Ancora niente. Quando un agente salva qualcosa nel contesto — con la
                    memoria di progetto — comparirà qui.
                  </div>
                )}
              </div>
            </div>
          ) : tab === 'notifiche' ? (
            <NotificationsTab />
          ) : tab === 'aspetto' ? (
            <AppearanceTab />
          ) : tab === 'utilizzo' ? (
            <Usage />
          ) : tab === 'runner' ? (
            <RunnerTab workspaceId={workspace!.id} />
          ) : (
            <div>
              <div className="mb-4">
                <button className="btn btn-primary" onClick={() => void makeInvite()}>
                  <Plus size={14} /> Crea link d'invito
                </button>
                {inviteUrl && (
                  <div className="mt-2.5 flex items-center gap-2 rounded-[10px] bg-[var(--color-panel-alt)] px-3 py-2">
                    <code className="min-w-0 flex-1 truncate font-mono text-[12.5px]">
                      {inviteUrl}
                    </code>
                    <button
                      onClick={() => {
                        void navigator.clipboard?.writeText(inviteUrl);
                        setCopied(true);
                        setTimeout(() => setCopied(false), 1800);
                      }}
                      className="flex shrink-0 items-center gap-1 rounded-md px-2 py-1 text-[12.5px] text-[var(--color-ink-soft)] transition-colors hover:bg-[var(--color-sunken)]"
                    >
                      {copied ? <Check size={12} /> : <Copy size={12} />}
                      {copied ? 'Copiato' : 'Copia'}
                    </button>
                  </div>
                )}
                <p className="mt-1.5 text-[12px] text-[var(--color-ink-faint)]">
                  Chi apre il link crea il suo account ed entra in questo progetto. Vale 7
                  giorni, una sola volta.
                </p>
              </div>

              <div className="space-y-1">
                {members.map((m) => (
                  <div key={m.id} className="flex items-center gap-2.5 rounded-[9px] px-2 py-1.5">
                    <Avatar name={m.name} emoji={m.avatarEmoji} color={m.avatarColor} size={30} />
                    <div className="min-w-0 flex-1">
                      <div className="text-[14px] font-medium">{m.name}</div>
                      <div className="truncate text-[12.5px] text-[var(--color-ink-faint)]">
                        @{m.handle}
                      </div>
                    </div>
                    <span className="rounded bg-[var(--color-sunken)] px-2 py-px text-[11.5px] text-[var(--color-ink-soft)]">
                      {m.role}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
    </Modal>
  );
}

/* ========================================================================== */
/*  Aspetto                                                                    */
/* ========================================================================== */

const THEME_CHOICES: Array<{ id: ThemePref; label: string; hint: string }> = [
  { id: 'auto', label: 'Come il sistema', hint: 'Segue il tuo dispositivo, e cambia con lui' },
  { id: 'light', label: 'Chiaro', hint: 'Sempre chiaro, qualunque cosa dica il sistema' },
  { id: 'dark', label: 'Scuro', hint: 'Sempre scuro' },
];

function AppearanceTab() {
  const [pref, setPref] = useState<ThemePref>(() => storedPref());

  // Se si torna su "come il sistema", il tema va ricalcolato subito: la
  // scelta manuale poteva averlo portato dalla parte opposta.
  function choose(next: ThemePref) {
    setPref(next);
    setThemePref(next);
    if (next === 'auto') applyTheme('auto');
  }

  return (
    <div className="max-w-[460px]">
      <h3 className="text-[14px] font-semibold">Tema</h3>
      <p className="mt-1 text-[13.5px] text-[var(--color-ink-soft)]">
        Di norma Hive segue il tuo dispositivo. Se preferisci decidere tu, scegli qui: la scelta
        resta su questo browser.
      </p>

      <div className="mt-3 flex flex-col gap-1.5">
        {THEME_CHOICES.map((c) => (
          <button
            key={c.id}
            onClick={() => choose(c.id)}
            className={clsx(
              'flex items-start gap-3 rounded-[11px] border px-3.5 py-3 text-left transition-colors',
              pref === c.id
                ? 'border-[color-mix(in_oklab,var(--color-honey)_50%,transparent)] bg-[var(--color-honey-soft)]'
                : 'border-[var(--color-line)] hover:border-[var(--color-line-strong)]',
            )}
          >
            <span
              className={clsx(
                'mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full border',
                pref === c.id
                  ? 'border-[var(--color-honey)] bg-[var(--color-honey)]'
                  : 'border-[var(--color-line-strong)]',
              )}
            >
              {pref === c.id && <Check size={10} strokeWidth={3.2} className="text-[var(--color-on-accent)]" />}
            </span>
            <span className="min-w-0">
              <span className="block text-[14px] font-medium">{c.label}</span>
              <span className="block text-[12.5px] text-[var(--color-ink-faint)]">{c.hint}</span>
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}

/* ========================================================================== */
/*  Notifiche                                                                  */
/* ========================================================================== */

const PUSH_MESSAGE: Record<PushState, { text: string; tone: 'ok' | 'info' | 'warn' }> = {
  on: { text: 'Le notifiche sono attive su questo dispositivo.', tone: 'ok' },
  off: { text: 'Non ancora attive su questo dispositivo.', tone: 'info' },
  denied: {
    text: 'Le hai negate a questo sito. Si riattivano dalle impostazioni del browser, non da qui.',
    tone: 'warn',
  },
  'needs-install': {
    text: 'Su iPhone servono con l’app aggiunta alla schermata Home: apri il menu Condividi e scegli «Aggiungi a Home».',
    tone: 'info',
  },
  unsupported: { text: 'Questo browser non supporta le notifiche push.', tone: 'warn' },
  unconfigured: {
    text: 'Il server non ha ancora le chiavi per inviarle.',
    tone: 'warn',
  },
};

/** Le voci, con l'etichetta che dice cosa arriva davvero. */
const PUSH_KINDS: Array<{ id: keyof PushPrefs; label: string; hint: string }> = [
  { id: 'mentions', label: 'Quando mi taggano', hint: 'Un messaggio che ti nomina, in qualsiasi canale' },
  { id: 'approvals', label: 'Quando un agente chiede un permesso', hint: 'È fermo finché non decidi' },
  {
    id: 'runnerOffline',
    label: 'Quando la mia macchina è spenta',
    hint: 'L’agente locale non può partire, e senza avviso te ne accorgi tardi',
  },
  { id: 'runFinished', label: 'Quando un agente finisce', hint: 'Anche se non ti ha nominato' },
];

function NotificationsTab() {
  const [state, setState] = useState<PushState | null>(null);
  const [prefs, setPrefs] = useState<PushPrefs | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void pushState().then(setState);
    void api
      .pushPrefs()
      .then(({ prefs }) => setPrefs(prefs))
      .catch(() => setPrefs(null));
  }, []);

  async function toggleDevice() {
    setBusy(true);
    try {
      setState(state === 'on' ? await disablePush() : await enablePush());
    } finally {
      setBusy(false);
    }
  }

  async function toggleKind(id: keyof PushPrefs) {
    if (!prefs) return;
    const next = { ...prefs, [id]: !prefs[id] };
    setPrefs(next);
    await api.updatePushPrefs({ [id]: next[id] } as Partial<PushPrefs>).catch(() => setPrefs(prefs));
  }

  const info = state ? PUSH_MESSAGE[state] : null;

  return (
    <div className="max-w-[480px]">
      <h3 className="text-[14px] font-semibold">Questo dispositivo</h3>
      {info && (
        <p
          className={clsx(
            'mt-1 text-[13.5px]',
            info.tone === 'warn' ? 'text-[var(--color-error)]' : 'text-[var(--color-ink-soft)]',
          )}
        >
          {info.text}
        </p>
      )}
      {(state === 'on' || state === 'off') && (
        <button className="btn btn-primary mt-3" onClick={() => void toggleDevice()} disabled={busy}>
          {state === 'on' ? 'Disattiva qui' : 'Attiva le notifiche'}
        </button>
      )}

      <h3 className="mt-6 text-[14px] font-semibold">Di cosa avvisarti</h3>
      <p className="mt-1 text-[13.5px] text-[var(--color-ink-soft)]">
        Vale su tutti i tuoi dispositivi. Non ti avvisiamo mai del canale che stai già guardando.
      </p>

      <div className="mt-3 flex flex-col gap-1.5">
        {PUSH_KINDS.map((k) => {
          const on = prefs ? Boolean(prefs[k.id]) : false;
          return (
            <button
              key={k.id}
              onClick={() => void toggleKind(k.id)}
              disabled={!prefs}
              className="flex items-start gap-3 rounded-[11px] border border-[var(--color-line)] px-3.5 py-3 text-left transition-colors hover:border-[var(--color-line-strong)] disabled:opacity-50"
            >
              <span
                className={clsx(
                  'mt-0.5 flex h-[18px] w-[30px] shrink-0 items-center rounded-full px-[2px] transition-colors',
                  on ? 'bg-[var(--color-honey)]' : 'bg-[var(--color-line-strong)]',
                )}
              >
                <span
                  className={clsx(
                    'h-[14px] w-[14px] rounded-full bg-[var(--color-panel)] transition-transform',
                    on && 'translate-x-[12px]',
                  )}
                />
              </span>
              <span className="min-w-0">
                <span className="block text-[14px] font-medium">{k.label}</span>
                <span className="block text-[12.5px] text-[var(--color-ink-faint)]">{k.hint}</span>
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
