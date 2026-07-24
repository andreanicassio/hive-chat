# Hive Desktop (macOS / Windows / Linux)

App nativa di Hive costruita con **Tauri 2**. Fa due cose:

1. Apre la **chat di Hive** in una finestra nativa (icona nel Dock, notifiche di
   sistema), collegandosi al server che indichi.
2. Avvia/ferma il tuo **runner locale** con un clic — così gli agenti che hai
   impostato su «Sul mio computer» girano qui, sul tuo codice (vedi
   [`deploy/RUNNER.md`](../../deploy/RUNNER.md)).

> **Nota:** questa app va **compilata su ogni sistema** che deve usarla (Tauri
> produce un binario nativo). Il repo contiene tutto il sorgente; i comandi qui
> sotto generano `Hive.app`/`.dmg` sul Mac. Non serve nulla di tutto ciò per la
> versione **PWA installabile**: da Safari/Chrome sul server Hive, menu →
> «Installa Hive» / «Aggiungi al Dock» e hai già un'app, senza compilare niente.

## Requisiti (sul Mac)

- [Rust](https://rustup.rs) (`curl https://sh.rustup.rs -sSf | sh`)
- Xcode Command Line Tools (`xcode-select --install`)
- Node 22+ (per la CLI di Tauri)

## Build

```bash
cd apps/desktop
npm install

# genera l'intero set di icone da icon-source.png (1024×1024)
npm run icon

# sviluppo (hot reload della finestra):
npm run dev

# build di produzione → src-tauri/target/release/bundle/
npm run build
```

Il `.app` e il `.dmg` finiscono in
`apps/desktop/src-tauri/target/release/bundle/`. Trascina `Hive.app` in
Applicazioni.

## Come si usa

All'avvio l'app mostra una schermata iniziale:

- **Indirizzo del server** → l'URL del tuo Hive (es. `http://10.0.0.76`), poi
  **Apri Hive →** entra nella chat.
- **Runner locale** → indica la cartella del repo Hive clonato su questo Mac e
  premi **Avvia runner** (equivale a lanciare `deploy/hive-runner.sh`, che legge
  `deploy/runner.env`). Il pallino verde conferma che è acceso. Chiudendo l'app
  il runner viene fermato.

## Firma e distribuzione (facoltativo)

Per distribuire il `.dmg` ad altri Mac senza avviso di sicurezza serve firmarlo
e notarizzarlo con un account Apple Developer: vedi la
[guida Tauri al signing macOS](https://tauri.app/distribute/sign/macos/). Per
uso interno sulla tua rete puoi anche solo aprire l'app con tasto destro →
«Apri» la prima volta.

## Struttura

```
apps/desktop/
├─ ui/index.html          schermata iniziale (server URL + controllo runner)
├─ icon-source.png        sorgente icone (npm run icon la espande)
└─ src-tauri/
   ├─ src/lib.rs          comandi Rust: start_runner / stop_runner / stato
   ├─ src/main.rs         entrypoint
   ├─ tauri.conf.json     finestra, bundle, icone
   └─ capabilities/       permessi della finestra
```
