import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { App } from './App.js';
import './index.css';

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

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </StrictMode>,
);
