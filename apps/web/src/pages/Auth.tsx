import { useState, type FormEvent } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { api, ApiError } from '../lib/api.js';
import { useStore } from '../store.js';

/**
 * Accesso e registrazione in una schermata sola.
 * Il codice d'invito, se presente nell'URL, viene raccolto e passato alla
 * registrazione: chi arriva da un link entra nel progetto senza altri passaggi.
 */
export function AuthPage() {
  const [params] = useSearchParams();
  const inviteCode = params.get('invito') ?? undefined;

  const [mode, setMode] = useState<'login' | 'register'>(inviteCode ? 'register' : 'login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const navigate = useNavigate();
  const loadSession = useStore((s) => s.loadSession);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (mode === 'register') {
        await api.register({ email, password, name, inviteCode });
      } else {
        await api.login({ email, password });
        if (inviteCode) await api.acceptInvite(inviteCode).catch(() => {});
      }
      await loadSession();
      navigate('/', { replace: true });
    } catch (err) {
      setError(
        err instanceof ApiError ? err.message : 'Qualcosa è andato storto. Riprova.',
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex min-h-full items-center justify-center p-5">
      <div className="w-full max-w-[380px]">
        <div className="mb-7 text-center">
          <div className="mb-3 inline-flex h-12 w-12 items-center justify-center rounded-[14px] bg-[var(--color-panel)] text-2xl shadow-[var(--shadow-panel)]">
            🐝
          </div>
          <h1 className="text-[26px] font-semibold tracking-[-0.02em]">Hive</h1>
          <p className="mt-1 text-[14.5px] text-[var(--color-ink-soft)]">
            {mode === 'login'
              ? 'Bentornato. Accedi per continuare.'
              : inviteCode
                ? 'Sei stato invitato. Crea il tuo account.'
                : 'Crea un account per iniziare.'}
          </p>
        </div>

        <form onSubmit={submit} className="panel space-y-3 p-5">
          {mode === 'register' && (
            <label className="block">
              <span className="mb-1.5 block text-[13px] font-medium text-[var(--color-ink-soft)]">
                Come ti chiami
              </span>
              <input
                className="field"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Andrea Rossi"
                autoComplete="name"
                required
                maxLength={64}
              />
            </label>
          )}

          <label className="block">
            <span className="mb-1.5 block text-[13px] font-medium text-[var(--color-ink-soft)]">
              Email
            </span>
            <input
              className="field"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="tu@esempio.it"
              autoComplete="email"
              required
            />
          </label>

          <label className="block">
            <span className="mb-1.5 block text-[13px] font-medium text-[var(--color-ink-soft)]">
              Password
            </span>
            <input
              className="field"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder={mode === 'register' ? 'Almeno 10 caratteri' : '••••••••'}
              autoComplete={mode === 'register' ? 'new-password' : 'current-password'}
              required
              minLength={mode === 'register' ? 10 : 1}
            />
          </label>

          {error && (
            <p
              role="alert"
              className="rounded-lg bg-[color-mix(in_oklab,var(--color-error)_10%,transparent)] px-3 py-2 text-[13.5px] text-[var(--color-error)]"
            >
              {error}
            </p>
          )}

          <button type="submit" className="btn btn-primary w-full" disabled={busy}>
            {busy ? 'Un attimo…' : mode === 'login' ? 'Accedi' : 'Crea account'}
          </button>
        </form>

        <p className="mt-4 text-center text-[13.5px] text-[var(--color-ink-soft)]">
          {mode === 'login' ? 'Non hai un account? ' : 'Hai già un account? '}
          <button
            type="button"
            className="font-medium text-[var(--color-terracotta)] underline underline-offset-2"
            onClick={() => {
              setMode(mode === 'login' ? 'register' : 'login');
              setError(null);
            }}
          >
            {mode === 'login' ? 'Registrati' : 'Accedi'}
          </button>
        </p>
      </div>
    </div>
  );
}
