import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { App } from './App.js';
import './index.css';
import { watchSystemTheme } from './lib/theme.js';
import { trackKeyboard } from './lib/keyboard.js';
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
  // SOLO `window-controls-overlay`, che è un segnale vero: il browser lo
  // dichiara quando la finestra ci lascia davvero disegnare in cima.
  //
  // Prima bastava trovarsi dentro Tauri, ed era un'ipotesi sbagliata: il
  // guscio Mac ha la barra in sovrimpressione solo se è stato ricompilato con
  // quella configurazione. Fino ad allora la barra di sistema c'era ancora e
  // noi le lasciavamo comunque 32px di spazio — una striscia vuota in cima,
  // sotto una barra che non era affatto sparita.
  if (window.matchMedia?.('(display-mode: window-controls-overlay)').matches === true) {
    document.documentElement.dataset.titlebar = 'overlay';
    return;
  }

  // Il guscio Mac non dichiara nulla — quel segnale è roba da PWA e dentro
  // Tauri non arriva mai. Ce lo dice lui, con `?shell=overlay` sul primo
  // indirizzo, e da lì in poi vale per questo dispositivo: la navigazione
  // interna perde la query, e la finestra non cambia forma per strada.
  /*
   * Dentro il guscio Mac la barra in sovrimpressione c'è SEMPRE: è nella sua
   * configurazione da quando esiste la 0.1.3, e non c'è più nessuna build in
   * circolazione senza. Quindi basta accorgersi di essere lì.
   *
   * Prima lo deducevo dal `?shell=overlay` che il guscio aggiunge quando
   * premi «Apri»: bastava un percorso diverso — un link, un ricaricamento a
   * indirizzo pulito — e il segnale non arrivava mai. Niente striscia, niente
   * trascinamento, e nessun modo di accorgersene guardando.
   */
  const inTauri = '__TAURI__' in window;
  if (inTauri) {
    document.documentElement.dataset.titlebar = 'overlay';
    document.documentElement.dataset.shell = 'tauri';
  }

  try {
    const params = new URLSearchParams(location.search);
    if (params.get('shell') === 'overlay') {
      localStorage.setItem('hive:shell', 'overlay');
      // Il guscio si presenta con la sua versione. Serve a rispondere a «che
      // versione dell'app hai?», che finora non aveva risposta: la sigla in
      // basso è quella del frontend, che si aggiorna da sé — il guscio no.
      const app = params.get('app');
      if (app) localStorage.setItem('hive:shellVersion', app);
      history.replaceState(null, '', location.pathname + location.hash);
    }
    if (localStorage.getItem('hive:shell') === 'overlay') {
      document.documentElement.dataset.titlebar = 'overlay';
      // Il guscio Mac vuole sapere dove NON disegnare la striscia: i tre
      // pallini stanno a sinistra e devono restare cliccabili.
      document.documentElement.dataset.shell = 'tauri';
    }
  } catch {
    // Archiviazione bloccata: si resta con la barra normale, che è il caso
    // peggiore ma non rompe niente.
  }
}
markTitlebar();

// Il tema l'ha già applicato lo script in index.html: qui restiamo solo in
// ascolto, perché il sistema può passare a scuro mentre l'app è aperta.
watchSystemTheme();

// Quanto occupa la tastiera a schermo: i fogli si accorciano di conseguenza.
trackKeyboard();

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
