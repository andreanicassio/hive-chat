/**
 * «C'è una versione nuova»: rilevamento e passaggio.
 *
 * Il service worker nuovo prende il controllo appena è pronto (vedi `sw.ts`),
 * ma NON ricarica la pagina: quella continua a girare con i file di prima
 * finché non lo decidi tu. Qui ce ne accorgiamo e lo diciamo all'app, che
 * mostra l'avviso in basso.
 *
 * Il controllo si rifà ogni tanto e al ritorno sulla scheda: una scheda aperta
 * da ore, altrimenti, non scoprirebbe mai che è uscita una versione nuova — ed
 * è proprio quella che resta indietro più a lungo.
 */

/** Ogni mezz'ora: abbastanza spesso da accorgersene, non tanto da pesare. */
const CHECK_EVERY_MS = 30 * 60_000;

let waiting: ServiceWorker | null = null;
let announced = false;

export function updateReady(): boolean {
  return announced;
}

/**
 * Accetta l'aggiornamento.
 *
 * Se un service worker è ancora in attesa gli si dice di prendere il posto del
 * vecchio; se invece ha già preso il controllo — il caso normale — basta
 * ricaricare, perché i file nuovi sono già quelli che verranno serviti.
 */
export function applyUpdate(): void {
  if (waiting) waiting.postMessage({ type: 'SKIP_WAITING' });
  location.reload();
}

export function watchForUpdates(onReady: () => void): void {
  if (!('serviceWorker' in navigator)) return;

  const announce = (sw: ServiceWorker | null) => {
    if (announced) return;
    waiting = sw;
    announced = true;
    onReady();
  };

  // C'era già un service worker e adesso ne comanda un altro: è arrivata una
  // versione nuova. Non si ricarica di forza — si avvisa.
  const hadController = Boolean(navigator.serviceWorker.controller);
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (hadController) announce(null);
  });

  void navigator.serviceWorker.ready.then((reg) => {
    // Già in attesa da un caricamento precedente.
    if (reg.waiting && navigator.serviceWorker.controller) announce(reg.waiting);

    reg.addEventListener('updatefound', () => {
      const installing = reg.installing;
      if (!installing) return;
      installing.addEventListener('statechange', () => {
        // `controller` esiste solo se un service worker c'era già: senza,
        // questa è la prima installazione e non è un aggiornamento.
        if (installing.state === 'installed' && navigator.serviceWorker.controller) {
          announce(reg.waiting);
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
