/**
 * «C'è una versione nuova»: rilevamento e passaggio.
 *
 * Il service worker nuovo si installa ma resta in attesa (vedi `sw.ts`). Qui
 * ce ne accorgiamo e lo diciamo all'app, che mostra l'avviso; quando l'utente
 * accetta, gli si dice di prendere il posto del vecchio e si ricarica.
 *
 * Il controllo si rifà anche ogni tanto e al ritorno sulla scheda: una scheda
 * aperta da ore, altrimenti, non scoprirebbe mai che è uscita una versione
 * nuova — ed è proprio quella che resta indietro più a lungo.
 */

/** Ogni mezz'ora: abbastanza spesso da accorgersene, non tanto da pesare. */
const CHECK_EVERY_MS = 30 * 60_000;

let waiting: ServiceWorker | null = null;
let reloading = false;

export function updateReady(): boolean {
  return waiting !== null;
}

/**
 * Accetta l'aggiornamento.
 *
 * Non ricarica subito: prima chiede al service worker in attesa di prendere
 * il posto del vecchio, poi la pagina si ricarica quando il cambio è
 * avvenuto — `controllerchange`. Ricaricare prima servirebbe la versione
 * vecchia un'altra volta.
 */
export function applyUpdate(): void {
  if (!waiting) {
    location.reload();
    return;
  }
  waiting.postMessage({ type: 'SKIP_WAITING' });
}

export function watchForUpdates(onReady: () => void): void {
  if (!('serviceWorker' in navigator)) return;

  const announce = (sw: ServiceWorker | null) => {
    if (!sw) return;
    waiting = sw;
    onReady();
  };

  navigator.serviceWorker.addEventListener('controllerchange', () => {
    // Succede anche alla primissima installazione, quando non c'era niente da
    // aggiornare: lì non c'è nulla da ricaricare.
    if (reloading || !waiting) return;
    reloading = true;
    location.reload();
  });

  void navigator.serviceWorker.ready.then((reg) => {
    // Già in attesa da un caricamento precedente.
    announce(reg.waiting);

    reg.addEventListener('updatefound', () => {
      const installing = reg.installing;
      if (!installing) return;
      installing.addEventListener('statechange', () => {
        // `controller` esiste solo se un service worker c'era già: senza,
        // questa è la prima installazione e non è un aggiornamento.
        if (installing.state === 'installed' && navigator.serviceWorker.controller) {
          announce(reg.waiting ?? installing);
        }
      });
    });

    const check = () => void reg.update().catch(() => {});
    setInterval(check, CHECK_EVERY_MS);
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) check();
    });
  });
}
