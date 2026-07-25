/**
 * «C'è una versione nuova»: rilevamento e passaggio.
 *
 * Il service worker nuovo prende il controllo appena è pronto (vedi `sw.ts`),
 * ma NON ricarica la pagina: quella continua a girare con i file di prima
 * finché non lo decidi tu. Qui ce ne accorgiamo e lo diciamo all'app, che
 * mostra l'avviso in basso.
 *
 * Due sentinelle, non una:
 *
 * 1. il service worker, che è il segnale autorevole — quando ha installato i
 *    file nuovi, ricaricare serve davvero a qualcosa;
 * 2. `version.json`, riletto ogni minuto, che dice quale sigla c'è sul
 *    server. È il segnale *veloce*: il controllo del service worker da solo
 *    passa ogni mezz'ora, e in una fase in cui si pubblica dieci volte al
 *    giorno vuol dire mezz'ora su una versione vecchia senza saperlo.
 */

/** Il service worker si ricontrolla da sé ogni mezz'ora. */
const CHECK_EVERY_MS = 30 * 60_000;
/** `version.json` invece ogni minuto: costa un rigo di JSON. */
const POLL_EVERY_MS = 60_000;

let waiting: ServiceWorker | null = null;
let announced = false;
/**
 * Chi ha dato l'allarme: se è stato solo il poll, i file nuovi potrebbero non
 * essere ancora in cache e un reload normale servirebbe di nuovo i vecchi.
 */
let needsHardReload = false;

/** La sigla pubblicata sul server, appena la conosciamo. */
let published: string | null = null;
const listeners = new Set<() => void>();

export function updateReady(): boolean {
  return announced;
}

/** Il commit da cui esce il bundle che sta girando in questo momento. */
export function runningSha(): string {
  return __BUILD_SHA__;
}

/** Quella pubblicata sul server: diversa dalla precedente = sei indietro. */
export function publishedSha(): string | null {
  return published;
}

export function onVersionChange(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/**
 * Accetta l'aggiornamento.
 *
 * Se un service worker è ancora in attesa gli si dice di prendere il posto del
 * vecchio; se invece ha già preso il controllo — il caso normale — basta
 * ricaricare, perché i file nuovi sono già quelli che verranno serviti.
 *
 * Quando l'allarme è arrivato solo dal poll si fa la strada lunga: cache
 * buttata e service worker sregistrato. Un «Ricarica» che non cambia niente è
 * peggio di nessun bottone — è già successo, dentro l'app Mac.
 */
export function applyUpdate(): void {
  if (needsHardReload) {
    void (async () => {
      try {
        const regs = await navigator.serviceWorker?.getRegistrations();
        await Promise.all((regs ?? []).map((r) => r.unregister()));
        const keys = await caches.keys();
        await Promise.all(keys.map((k) => caches.delete(k)));
      } catch {
        // Se la pulizia non riesce si ricarica lo stesso: peggio di così è
        // restare fermi.
      }
      location.reload();
    })();
    return;
  }
  if (waiting) waiting.postMessage({ type: 'SKIP_WAITING' });
  location.reload();
}

let watching = false;

export function watchForUpdates(onReady: () => void): void {
  // Le sentinelle si armano una volta sola: un secondo giro raddoppierebbe
  // timer e ascoltatori senza aggiungere niente.
  if (watching) return;
  watching = true;

  const announce =(sw: ServiceWorker | null, hard = false) => {
    if (announced) return;
    waiting = sw;
    needsHardReload = hard;
    announced = true;
    onReady();
  };

  /* -------------------------------------------- sentinella «version.json» */

  // Quante volte di fila il server ha detto «sei indietro» senza che il
  // service worker se ne accorgesse. Alla terza si smette di aspettarlo.
  let stale = 0;

  const poll = async () => {
    try {
      const res = await fetch('/version.json', { cache: 'no-store' });
      if (!res.ok) return;
      const data = (await res.json()) as { sha?: string };
      if (!data.sha) return;
      if (data.sha !== published) {
        published = data.sha;
        for (const fn of listeners) fn();
      }
    } catch {
      // Rete assente: non è una versione nuova, è solo silenzio.
      return;
    }
    if (published === __BUILD_SHA__) {
      stale = 0;
      return;
    }
    stale++;
    const reg = await navigator.serviceWorker?.ready.catch(() => null);
    // Prima si prova a farlo scoprire al service worker, che è la strada
    // pulita; se dopo tre giri non l'ha ancora visto, si forza.
    if (reg) void reg.update().catch(() => {});
    if (!reg || stale >= 3) announce(null, true);
  };

  void poll();
  setInterval(() => void poll(), POLL_EVERY_MS);
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) void poll();
  });

  /* ----------------------------------------- sentinella «service worker» */

  if (!('serviceWorker' in navigator)) return;

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
