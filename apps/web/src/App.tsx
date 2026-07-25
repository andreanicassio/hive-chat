import { Component, useEffect, useState, type ReactNode } from 'react';
import { Navigate, Route, Routes, useNavigate } from 'react-router-dom';
import { Loader2 } from 'lucide-react';
import { useStore } from './store.js';
import { AuthPage } from './pages/Auth.js';
import { Landing } from './pages/Landing.js';
import { Sidebar } from './components/Sidebar.js';
import { Chat, AgentStatusBar } from './components/Chat.js';
import { AgentPanel, AgentList } from './components/AgentPanel.js';
import { Settings } from './components/Settings.js';
import { api } from './lib/api.js';
import { useIsMobile } from './lib/breakpoint.js';
import { MobileShell } from './mobile/Shell.js';
import { UpdateToast } from './components/UpdateToast.js';

/* ==========================================================================
   Rete di sicurezza: un errore in un componente non deve produrre una
   pagina bianca muta. Meglio mostrare cosa è successo, con il modo di
   ripartire.
   ======================================================================== */
/**
 * Ricarica scartando la copia dell'app tenuta dal service worker.
 *
 * Un `location.reload()` normale rimette in piedi gli stessi file: se il
 * guasto sta lì, si ripresenta identico. Qui siamo già su una schermata di
 * errore, quindi buttare la cache è il compromesso giusto — si perde il
 * funzionamento offline per un giro, si recupera un'app che parte.
 */
async function hardReload(): Promise<void> {
  try {
    const regs = (await navigator.serviceWorker?.getRegistrations?.()) ?? [];
    await Promise.all(regs.map((r) => r.unregister()));
    if ('caches' in window) {
      const keys = await caches.keys();
      await Promise.all(keys.map((k) => caches.delete(k)));
    }
  } catch {
    /* se non si può, si ricarica e basta */
  }
  location.reload();
}

class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  override state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  override componentDidCatch(error: Error, info: unknown) {
    console.error('[hive] errore in interfaccia', error, info);
  }

  override render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="flex h-full items-center justify-center p-6">
        <div className="panel max-w-[440px] p-5">
          <h1 className="text-[17px] font-semibold">L’interfaccia si è bloccata</h1>
          <p className="mt-1 text-[14px] text-[var(--color-ink-soft)]">
            Il resto del sistema continua a funzionare. Ecco cosa è successo:
          </p>
          <pre className="mt-3 max-h-40 overflow-auto rounded-lg bg-[var(--color-panel-alt)] px-3 py-2 font-mono text-[12px]">
            {this.state.error.message}
          </pre>
          <p className="mt-2 font-mono text-[11.5px] text-[var(--color-ink-faint)]">
            build {__BUILD_ID__}
          </p>
          <button className="btn btn-primary mt-4" onClick={() => void hardReload()}>
            Ricarica
          </button>
          <p className="mt-2 text-[12.5px] text-[var(--color-ink-faint)]">
            Ricaricando si scarta anche la copia in cache: se il guasto era in una versione
            vecchia rimasta appesa, così sparisce.
          </p>
        </div>
      </div>
    );
  }
}

function Booting() {
  return (
    <div className="flex h-full items-center justify-center">
      <Loader2 size={22} className="animate-spin text-[var(--color-ink-faint)]" />
    </div>
  );
}

/** Primo accesso: nessun progetto ancora. */
function FirstWorkspace() {
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const loadSession = useStore((s) => s.loadSession);

  async function create(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;
    setBusy(true);
    try {
      await api.createWorkspace({ name: name.trim() });
      await loadSession();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex min-h-full items-center justify-center p-5">
      <form onSubmit={create} className="panel w-full max-w-[400px] p-6">
        <div className="mb-1 text-2xl">🐝</div>
        <h1 className="text-[21px] font-semibold tracking-[-0.02em]">Crea il tuo primo progetto</h1>
        <p className="mt-1 mb-4 text-[14px] text-[var(--color-ink-soft)]">
          Un progetto può essere un'azienda intera o un singolo lavoro. Dentro ci metti
          canali, persone e agenti.
        </p>
        <input
          className="field mb-3"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Es. Studey"
          autoFocus
          maxLength={64}
        />
        <button className="btn btn-primary w-full" disabled={busy || !name.trim()}>
          {busy ? 'Creo…' : 'Crea progetto'}
        </button>
      </form>
    </div>
  );
}

/**
 * Guscio del progetto.
 *
 * Impaginazione presa dalla reference: la sidebar sta a filo sul crema
 * (nessun pannello suo), la conversazione è un foglio bianco arrotondato che
 * ci galleggia sopra, e la barra di stato degli agenti vive sotto il foglio,
 * sul crema, come "Honey: Working" nell'originale.
 */
function WorkspaceShell() {
  const workspaces = useStore((s) => s.workspaces);
  const workspace = useStore((s) => s.workspace);
  const channels = useStore((s) => s.channels);
  const activeChannelId = useStore((s) => s.activeChannelId);
  const openWorkspace = useStore((s) => s.openWorkspace);
  const openChannel = useStore((s) => s.openChannel);
  const capabilities = useStore((s) => s.capabilities);

  const isMobile = useIsMobile();
  const [bootError, setBootError] = useState<string | null>(null);
  const [showAgents, setShowAgents] = useState(false);
  const [showNewAgent, setShowNewAgent] = useState(false);
  const [showSettings, setShowSettings] = useState(false);

  useEffect(() => {
    if (workspace || workspaces.length === 0) return;
    // Riapri l'ultimo progetto usato, se ancora accessibile; altrimenti il primo.
    let target = workspaces[0]!.id;
    try {
      const saved = localStorage.getItem('hive:lastWorkspace');
      if (saved && workspaces.some((w) => w.id === saved)) target = saved;
    } catch {
      /* ignora */
    }
    void openWorkspace(target).catch((e: unknown) =>
      setBootError(e instanceof Error ? e.message : 'Impossibile caricare il progetto'),
    );
  }, [workspaces, workspace, openWorkspace]);

  useEffect(() => {
    if (activeChannelId || channels.length === 0) return;
    // L'ultimo canale aperto in questo progetto, se esiste ancora.
    let target = channels[0]!.id;
    try {
      const saved = localStorage.getItem(`hive:lastChannel:${workspace?.id ?? ''}`);
      if (saved && channels.some((c) => c.id === saved)) target = saved;
    } catch {
      /* ignora */
    }
    void openChannel(target);
  }, [channels, activeChannelId, openChannel, workspace]);

  if (bootError) {
    return (
      <div className="flex h-full items-center justify-center p-6">
        <div className="panel max-w-[420px] p-5">
          <h1 className="text-[17px] font-semibold">Non riesco ad aprire il progetto</h1>
          <p className="mt-1.5 text-[14px] text-[var(--color-ink-soft)]">{bootError}</p>
          <button className="btn btn-primary mt-4" onClick={() => location.reload()}>
            Riprova
          </button>
        </div>
      </div>
    );
  }

  if (!workspace) return <Booting />;

  const noModels = !capabilities.anthropicConfigured && !capabilities.openrouterConfigured;

  if (isMobile) {
    return (
      <>
        <MobileShell
          onOpenAgents={() => setShowAgents(true)}
          onOpenSettings={() => setShowSettings(true)}
        />
        {showAgents && (
          <AgentList
            onClose={() => setShowAgents(false)}
            onNew={() => {
              setShowAgents(false);
              setShowNewAgent(true);
            }}
          />
        )}
        {showNewAgent && <AgentPanel onClose={() => setShowNewAgent(false)} />}
        {showSettings && <Settings onClose={() => setShowSettings(false)} />}
      </>
    );
  }

  return (
    // `overflow-hidden`: dentro c'è una conversazione che scorre per conto suo,
    // e la finestra non deve mai scorrere anche lei.
    <div className="flex h-full flex-col overflow-hidden">
      {noModels && (
        <div className="shrink-0 px-3 pt-2 text-center text-[12.5px] text-[var(--color-ink-soft)]">
          Nessuna credenziale per i modelli: gli agenti non possono ancora rispondere.{' '}
          <button
            onClick={() => setShowSettings(true)}
            className="font-medium text-[var(--color-terracotta)] underline underline-offset-2"
          >
            Configurala
          </button>
        </div>
      )}

      <div className="flex min-h-0 flex-1 gap-1 pt-2 pr-2.5 pb-1 pl-1">
        <Sidebar
          onOpenAgents={() => setShowAgents(true)}
          onNewChannel={() => {}}
          onSearch={() => {}}
          onOpenSettings={() => setShowSettings(true)}
        />
        {/* La barra di stato sta DENTRO la colonna della conversazione, non
            sotto tutto: quando compare, a farle spazio è solo il foglio della
            chat, che si accorcia di quaranta pixel. Prima era fuori, e quindi
            restringeva anche la barra laterale — nome, progetto e impostazioni
            si spostavano ogni volta che un agente cominciava a lavorare. */}
        <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-1">
          <Chat />
          <AgentStatusBar />
        </div>
      </div>

      {showAgents && (
        <AgentList
          onClose={() => setShowAgents(false)}
          onNew={() => {
            setShowAgents(false);
            setShowNewAgent(true);
          }}
        />
      )}
      {showNewAgent && <AgentPanel onClose={() => setShowNewAgent(false)} />}
      {showSettings && <Settings onClose={() => setShowSettings(false)} />}
    </div>
  );
}

/*
 * Trascinare la finestra dal guscio Mac.
 *
 * `data-tauri-drag-region` da solo non bastava: è l'attributo che il guscio
 * riconosce, ma resta in piedi solo se il suo script interno è agganciato e
 * se il permesso c'è. Chiamare l'API a mano è la stessa cosa detta in modo
 * esplicito — e soprattutto è codice nostro, che si aggiorna ricaricando la
 * pagina invece di richiedere una build nuova dell'app.
 *
 * Fuori dall'app Mac non fa niente e non dà fastidio.
 */
interface TauriWindowApi {
  getCurrentWindow?: () => {
    startDragging?: () => Promise<void>;
    toggleMaximize?: () => Promise<void>;
  };
}

function tauriWindow(): TauriWindowApi | null {
  return (window as { __TAURI__?: { window?: TauriWindowApi } }).__TAURI__?.window ?? null;
}

function startWindowDrag(event: React.MouseEvent): void {
  // Solo il tasto sinistro: col destro macOS apre il suo menu di finestra.
  if (event.button !== 0) return;
  try {
    void tauriWindow()?.getCurrentWindow?.()?.startDragging?.();
  } catch {
    /* non siamo nel guscio, o il permesso manca: la striscia resta inerte */
  }
}

function toggleWindowMaximize(): void {
  try {
    void tauriWindow()?.getCurrentWindow?.()?.toggleMaximize?.();
  } catch {
    /* come sopra */
  }
}

export function App() {
  const user = useStore((s) => s.user);
  const bootLoading = useStore((s) => s.bootLoading);
  const workspaces = useStore((s) => s.workspaces);
  const loadSession = useStore((s) => s.loadSession);

  useEffect(() => {
    void loadSession();
  }, [loadSession]);

  if (bootLoading) return <Booting />;

  return (
    <ErrorBoundary>
      {/* Fuori dalle rotte: l'avviso di aggiornamento vale ovunque, anche
          sulla pagina d'accesso. */}
      <UpdateToast />
      {/* La striscia trascinabile sotto i comandi della finestra. C'è solo
          dove la finestra ci lascia disegnare fin lassù: altrove sarebbe
          32px di pagina che non risponde al clic. */}
      {document.documentElement.dataset.titlebar === 'overlay' && (
        <div
          className="titlebar-drag"
          data-tauri-drag-region
          onMouseDown={startWindowDrag}
          onDoubleClick={toggleWindowMaximize}
        />
      )}
      <Routes>
        <Route path="/accedi" element={user ? <Navigate to="/" replace /> : <AuthPage />} />
        <Route path="/invito/:code" element={<InviteLanding />} />
        <Route
          path="/*"
          element={
            !user ? (
              <Landing />
            ) : workspaces.length === 0 ? (
              <FirstWorkspace />
            ) : (
              <WorkspaceShell />
            )
          }
        />
      </Routes>
    </ErrorBoundary>
  );
}

/** Atterraggio da un link d'invito. */
function InviteLanding() {
  const navigate = useNavigate();
  const user = useStore((s) => s.user);

  useEffect(() => {
    const code = location.pathname.split('/').pop() ?? '';
    if (!code) {
      navigate('/', { replace: true });
      return;
    }
    if (user) {
      void api
        .acceptInvite(code)
        .then(() => useStore.getState().loadSession())
        .finally(() => navigate('/', { replace: true }));
    } else {
      navigate(`/accedi?invito=${encodeURIComponent(code)}`, { replace: true });
    }
  }, [navigate, user]);

  return <Booting />;
}
