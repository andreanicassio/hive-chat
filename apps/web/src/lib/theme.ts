/**
 * Tema chiaro/scuro.
 *
 * La preferenza normale è **auto**: si segue il sistema, su desktop come su
 * telefono. Chi vuole forzare uno dei due lo fa dalle impostazioni, e da quel
 * momento il sistema non decide più.
 *
 * Chi applica il tema davvero è lo script in `index.html`, che gira prima che
 * la pagina si disegni: se aspettassimo il bundle si vedrebbe un lampo chiaro
 * prima dello scuro, che è la cosa più fastidiosa di tutte. Qui c'è la stessa
 * logica, per i cambi a caldo.
 */

export type ThemePref = 'auto' | 'light' | 'dark';

export const THEME_KEY = 'hive:theme';

/** Il colore della barra di sistema: deve continuare il gradiente. */
const BAR = { light: '#d9dee2', dark: '#1b2024' };

export function storedPref(): ThemePref {
  try {
    const v = localStorage.getItem(THEME_KEY);
    return v === 'light' || v === 'dark' ? v : 'auto';
  } catch {
    return 'auto';
  }
}

function systemIsDark(): boolean {
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches === true;
}

/** Risolve la preferenza in un tema vero e lo applica al documento. */
export function applyTheme(pref: ThemePref): void {
  const dark = pref === 'dark' || (pref === 'auto' && systemIsDark());
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  document
    .querySelector('meta[name="theme-color"]')
    ?.setAttribute('content', dark ? BAR.dark : BAR.light);
}

/** Salva la scelta e la applica subito. */
export function setThemePref(pref: ThemePref): void {
  try {
    if (pref === 'auto') localStorage.removeItem(THEME_KEY);
    else localStorage.setItem(THEME_KEY, pref);
  } catch {
    /* modalità privata: il tema vale per questa sessione e basta */
  }
  applyTheme(pref);
}

/**
 * Segue il sistema mentre cambia.
 *
 * Serve davvero: macOS e iOS passano a scuro da soli al tramonto, e un'app
 * aperta da ore deve seguirli senza che la si ricarichi.
 */
export function watchSystemTheme(): () => void {
  const mq = window.matchMedia('(prefers-color-scheme: dark)');
  const onChange = () => {
    if (storedPref() === 'auto') applyTheme('auto');
  };
  mq.addEventListener('change', onChange);
  return () => mq.removeEventListener('change', onChange);
}
