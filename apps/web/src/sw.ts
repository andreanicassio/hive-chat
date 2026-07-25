/// <reference lib="webworker" />
import { clientsClaim } from 'workbox-core';
import { cleanupOutdatedCaches, createHandlerBoundToURL, precacheAndRoute } from 'workbox-precaching';
import { NavigationRoute, registerRoute } from 'workbox-routing';

/**
 * Service worker di Hive.
 *
 * Prima era generato da Workbox e basta. Ora è scritto a mano perché serve
 * gestire l'evento `push`: quello è l'unico modo che il browser ha di
 * svegliare l'app quando è chiusa, e un service worker generato non lo sa
 * fare.
 *
 * Il resto — precache del guscio, navigazioni servite dalla cache tranne API
 * e websocket — è esattamente quello che faceva prima: se cambia, l'app
 * offline smette di aprirsi.
 */

declare const self: ServiceWorkerGlobalScope;

/*
 * Il service worker nuovo NON prende il posto del vecchio da solo.
 *
 * Prima lo faceva, e la pagina si ricaricava di conseguenza: ma ricaricare
 * mentre qualcuno sta scrivendo un messaggio è una piccola violenza. Adesso
 * resta in attesa, l'app mostra un avviso, e il cambio avviene quando lo
 * decide chi la sta usando.
 *
 * Non è solo cortesia: se il nuovo service worker prendesse il controllo
 * subito, la pagina vecchia continuerebbe a girare mentre i suoi pezzi
 * caricati a richiesta (il markdown, per esempio) sono già stati rimossi
 * dalla cache — e si romperebbero al primo uso.
 */
self.addEventListener('message', (event) => {
  if ((event.data as { type?: string } | undefined)?.type === 'SKIP_WAITING') {
    void self.skipWaiting();
  }
});
clientsClaim();

cleanupOutdatedCaches();
precacheAndRoute(self.__WB_MANIFEST);

// Le navigazioni prendono il guscio dalla cache. `/api` e `/ws` no: la chat è
// realtime, servire messaggi dalla cache sarebbe peggio che non servirli.
registerRoute(
  new NavigationRoute(createHandlerBoundToURL('index.html'), {
    denylist: [/^\/api/, /^\/ws/],
  }),
);

/** Quello che il server mette dentro la notifica. */
interface PushPayload {
  title: string;
  body: string;
  /** Rotta dell'app da aprire al tocco, es. `/c/<id>`. */
  url?: string;
  /** Notifiche con lo stesso tag si sostituiscono invece di accumularsi. */
  tag?: string;
}

self.addEventListener('push', (event) => {
  if (!event.data) return;
  let payload: PushPayload;
  try {
    payload = event.data.json() as PushPayload;
  } catch {
    payload = { title: 'Hive', body: event.data.text() };
  }

  event.waitUntil(
    self.registration.showNotification(payload.title, {
      body: payload.body,
      icon: '/icon-192.png',
      badge: '/icon-192.png',
      tag: payload.tag,
      // Con lo stesso tag la nuova sostituisce la vecchia: meglio «3 nuovi
      // messaggi in #annunci» che tre righe identiche in fila.
      renotify: Boolean(payload.tag),
      data: { url: payload.url ?? '/' },
    } as NotificationOptions),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = (event.notification.data as { url?: string } | undefined)?.url ?? '/';

  event.waitUntil(
    (async () => {
      const clients = await self.clients.matchAll({
        type: 'window',
        includeUncontrolled: true,
      });
      // Se Hive è già aperta si porta a fuoco quella scheda e la si naviga:
      // aprirne una seconda vorrebbe dire due copie della stessa chat.
      for (const client of clients) {
        if (new URL(client.url).origin !== self.location.origin) continue;
        await client.focus();
        if ('navigate' in client) await client.navigate(url);
        return;
      }
      await self.clients.openWindow(url);
    })(),
  );
});
