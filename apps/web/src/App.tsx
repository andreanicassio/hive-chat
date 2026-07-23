import { Component, useEffect, useState, type ReactNode } from 'react';
import { Navigate, Route, Routes, useNavigate } from 'react-router-dom';
import { Loader2 } from 'lucide-react';
import { useStore } from './store.js';
import { AuthPage } from './pages/Auth.js';
import { Sidebar } from './components/Sidebar.js';
import { Chat, AgentStatusBar } from './components/Chat.js';
import { AgentPanel, AgentList } from './components/AgentPanel.js';
import { Settings } from './components/Settings.js';
import { api } from './lib/api.js';

/* ==========================================================================
   Rete di sicurezza: un errore in un componente non deve produrre una
   pagina bianca muta. Meglio mostrare cosa è successo, con il modo di
   ripartire.
   ======================================================================== */
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
          <button className="btn btn-primary mt-4" onClick={() => location.reload()}>
            Ricarica
          </button>
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

  const [bootError, setBootError] = useState<string | null>(null);
  const [showAgents, setShowAgents] = useState(false);
  const [showNewAgent, setShowNewAgent] = useState(false);
  const [showSettings, setShowSettings] = useState(false);

  useEffect(() => {
    const first = workspaces[0];
    if (!first || workspace?.id === first.id) return;
    void openWorkspace(first.id).catch((e: unknown) =>
      // Senza questo, un bootstrap fallito lascerebbe lo spinner per sempre
      // e nessuno saprebbe perché.
      setBootError(e instanceof Error ? e.message : 'Impossibile caricare il progetto'),
    );
  }, [workspaces, workspace?.id, openWorkspace]);

  useEffect(() => {
    if (!activeChannelId && channels.length > 0) void openChannel(channels[0]!.id);
  }, [channels, activeChannelId, openChannel]);

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

  return (
    <div className="flex h-full flex-col">
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

      <div className="flex min-h-0 flex-1 gap-1 py-2.5 pr-2.5 pl-1">
        <Sidebar
          onOpenAgents={() => setShowAgents(true)}
          onNewChannel={() => {}}
          onSearch={() => {}}
          onOpenSettings={() => setShowSettings(true)}
        />
        <Chat />
      </div>

      {/* Barra di stato sotto il foglio, sul crema. */}
      <div className="h-6 shrink-0 pl-[244px]">
        <AgentStatusBar />
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
      <Routes>
        <Route path="/accedi" element={user ? <Navigate to="/" replace /> : <AuthPage />} />
        <Route path="/invito/:code" element={<InviteLanding />} />
        <Route
          path="/*"
          element={
            !user ? (
              <Navigate to="/accedi" replace />
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
