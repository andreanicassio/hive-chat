import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { App } from './App.js';
import './index.css';
import { watchSystemTheme } from './lib/theme.js';
import { realtime } from './lib/ws.js';
import { useStore } from './store.js';

/**
 * La finestra ci lascia disegnare fin sotto la sua barra?
 *
 * Succede in due casi: l'app installata con i comandi della finestra in
 * sovrimpressione, e il guscio Mac (Tauri), che carica questa stessa pagina
 * dentro una finestra senza barra propria. In entrambi lo spazio in alto e la
 * striscia trascinabile li mette il CSS — ma solo se glielo diciamo, perché
 * in un browser normale quello spazio sarebbe un buco senza motivo.
 */
function markTitlebar(): void {
  const overlay =
    '__TAURI__' in window ||
    window.matchMedia?.('(display-mode: window-controls-overlay)').matches === true;
  if (overlay) document.documentElement.dataset.titlebar = 'overlay';
}
markTitlebar();

// Il tema l'ha già applicato lo script in index.html: qui restiamo solo in
// ascolto, perché il sistema può passare a scuro mentre l'app è aperta.
watchSystemTheme();

/*
 * Finestra nascosta = non stai guardando niente.
 *
 * Serve alle notifiche: il canale aperto resta aperto anche col telefono in
 * tasca, e senza questo il server continuerebbe a crederti presente e non ti
 * avviserebbe mai. Al ritorno si rimanda il canale attivo.
 */
document.addEventListener('visibilitychange', () => {
  const { activeChannelId } = useStore.getState();
  realtime.focus(document.hidden ? null : activeChannelId);
});

/*
 * L'aggiornamento non ricarica più da solo.
 *
 * Prima lo faceva, e strappava la pagina a chi stava scrivendo. Ora il
 * service worker nuovo resta in attesa e compare l'avviso in basso
 * (`UpdateToast`): il momento lo sceglie chi usa l'app. Vedi `lib/update.ts`.
 */

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </StrictMode>,
);
