import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { App } from './App.js';
import './index.css';
import { watchSystemTheme } from './lib/theme.js';

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

/**
 * Dopo un aggiornamento, ricarica una volta sola.
 *
 * Il service worker nuovo prende il controllo subito, ma la pagina già aperta
 * continua a usare i file di prima: servivano due ricaricamenti, e al primo
 * sembrava che non fosse cambiato niente. Solo se un controller c'era già —
 * alla prima installazione non c'è niente da ricaricare.
 */
if ('serviceWorker' in navigator && navigator.serviceWorker.controller) {
  let reloading = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (reloading) return;
    reloading = true;
    location.reload();
  });
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </StrictMode>,
);
