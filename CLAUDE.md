# Hive

Chat di squadra (stile Slack) con **agenti AI schierabili**: gli agenti sono membri dei canali, si taggano con `@handle`, rispondono in streaming e possono lavorare sul codice. L'harness degli agenti sviluppatore è il **Claude Agent SDK**, cioè Claude Code usato come libreria.

Gira in produzione su questo server, pubblicato su **https://hive.dvnx.net** tramite Cloudflare Tunnel.

## Struttura

Monorepo npm workspaces (`packages/*`, `apps/*`):

| Pacchetto | Cosa fa |
|---|---|
| `packages/shared` | Tipi di dominio, schemi zod, protocollo WebSocket, catalogo dei tool. **Sorgente di verità condivisa.** |
| `packages/db` | Schema Drizzle, `buildAgentContext`, store dei Documenti. Usato da server *e* runtime. |
| `apps/server` | API Fastify + realtime (WebSocket). Regge auth, canali, messaggi, agenti, approvazioni. |
| `apps/agent-runtime` | Esegue i turni degli agenti: worker del server + runner a token per le macchine degli utenti. |
| `apps/web` | React 19 + Vite + Tailwind v4 + Zustand. |
| `apps/desktop` | Guscio Tauri 2 (app Mac). |

## Comandi

```bash
npm run build          # tutti i pacchetti, nell'ordine giusto
npm run typecheck      # tsc --noEmit su ogni pacchetto, stesso ordine
npm run -w @hive/web build     # un solo pacchetto (più veloce durante il lavoro)
```

**L'ordine conta**: `shared` → `db` → (`server`, `agent-runtime`) → `web`. Chi consuma legge i `dist/`, non i sorgenti: se tocchi `shared` o `db`, ricompilali prima di ricompilare chi li usa, altrimenti vedi errori di tipo che non esistono.

## Deploy su questa macchina

Non c'è una pipeline: si compila e si riavviano i servizi.

```bash
npm run build
sudo systemctl restart hive-api.service      # API + realtime
sudo systemctl restart hive-agents.service   # runtime degli agenti
```

Il frontend è servito da nginx da `apps/web/dist` — basta ricompilare, nessun riavvio.

Il runner distribuito agli utenti è un bundle a parte:

```bash
./deploy/publish-runner.sh 0.4.2    # esbuild + tarball in /srv/hive/downloads
```

Il runner acceso si aggiorna da solo: mentre fa il poll, se non ha turni da
eseguire, controlla la versione pubblicata e — se è cambiata — esce pulito.
Il `run.sh` che lo avvolge scarica il bundle nuovo e riparte. Aggiorna quindi
solo **fra** un turno e l'altro, mai a metà.

## L'app Mac si compila su GitHub

Questa macchina è Linux: un `.app` macOS non si può costruire qui. Lo
costruiscono i runner macOS di GitHub Actions
(`.github/workflows/desktop-release.yml`), che ne fanno una Release e caricano
lo zip su `hive.dvnx.net` per l'installazione in una riga.

```bash
# 1. le QUATTRO versioni vanno allineate a mano, e devono coincidere col tag
#    apps/desktop/package.json · src-tauri/tauri.conf.json · src-tauri/Cargo.toml
#    e `?app=` in apps/desktop/ui/index.html, che la mostra nell'app
# 2. il codice deve stare su GitHub: il workflow fa checkout del tag
GIT_SSH_COMMAND="ssh -i ~/.ssh/hive_deploy" git push origin main
git tag desktop-v0.1.3 -m "che cosa cambia"
GIT_SSH_COMMAND="ssh -i ~/.ssh/hive_deploy" git push origin desktop-v0.1.3
```

- **La chiave SSH non è quella di default**: senza `GIT_SSH_COMMAND` il push
  fallisce con «Permission denied (publickey)». La chiave è di sola questo
  repo (`~/.ssh/hive_deploy`).
- **Il tag è l'innesco**: `desktop-v*`. Si può anche lanciare a mano dalla tab
  Actions, ma allora la Release esce come `desktop-v0.0.0-dev`.
- **Seguire la build senza `gh`** (qui non è installato): il repo è pubblico,
  quindi basta l'API senza token —
  `curl -s "https://api.github.com/repos/andreanicassio/hive-chat/actions/runs?per_page=1"`.
- Finita, l'app è su `https://hive.dvnx.net/install-mac` (curl | bash: così non
  scatta la quarantena di macOS e non esce «app danneggiata»).

## Dati

Postgres 16 e Redis 7 girano in locale.

```bash
PGPASSWORD=hive_dev_local psql -h 127.0.0.1 -U hive -d hive
```

Lo schema vive in `packages/db/src/schema.ts`. **Le migrazioni non sono automatiche in produzione**: aggiungendo una colonna, applica anche l'`ALTER TABLE` a mano sul DB, altrimenti il codice nuovo gira su uno schema vecchio.

Redis porta le code dei run, la presenza dei runner e il fanout realtime fra i nodi API.

## Convenzioni

- **Il commit lo gestisce l'agente, sempre.** Lavoro finito = commit su `main`,
  senza chiedere il permesso e senza lasciare il working tree sporco. Niente
  branch: qui non si usano. Nel messaggio va il **perché**, non l'elenco dei
  file — quello lo dice già il diff. Il `git push`, invece, si chiede: mandare
  su GitHub è un'altra cosa dal committare.
- **Everything in the product is in English.** UI copy, API error messages,
  tool catalog labels, the agents' system prompt, code comments, commit
  messages. The project started in Italian and is being converted: if you
  touch a file that still has Italian in it, translate what you touch.
  The one thing that stays: the agents' rule «reply in the language of the
  person who wrote to you» — Andrea writes in Italian and expects Italian
  back. Product language and conversation language are different things.
- **I commenti spiegano il perché**, non il cosa. Se una riga è ovvia, niente commento.
- Niente `any` gratuiti: i tipi condivisi stanno in `@hive/shared`, si estendono lì.
- The interface speaks plainly, in the second person, and avoids jargon where it can.
- Ogni pop-up passa dal componente `Modal` (`apps/web/src/components/Modal.tsx`): dà Esc, click fuori, blocco dello scroll e impilamento coerenti.

## Copie di sicurezza

Timer di sistema notturno (`hive-backup.timer`, 03:20 UTC) che lancia
`deploy/backup.sh`: dump del database **e** archivio degli allegati, insieme,
in `/srv/hive/backups`. Separati non servirebbero — il database senza i file
ti ridà una chat piena di immagini mancanti.

Ogni copia viene riletta appena scritta: se non si apre, viene cancellata e
lo script fallisce. Ritenzione a scalare: tutto degli ultimi 7 giorni, una a
settimana per due mesi, una al mese per sei.

```bash
sudo systemctl start hive-backup.service    # a mano, subito
pg_restore -h 127.0.0.1 -U hive -d hive --clean --if-exists FILE.dump
tar xzf FILE-uploads.tar.gz -C /
```

La copia esce anche **fuori sede**, su Cloudflare R2, e ne esce **cifrata**
(`gpg`, AES256): dentro c'è ogni messaggio mai scritto, e una copia in chiaro
su un servizio altrui non è una decisione da prendere per distrazione. Nel
pacchetto cifrato va anche il `.env`, perché contiene `SECRETS_KEY` — senza
quella, un ripristino ti ridà i segreti dei progetti cifrati e nessun modo di
aprirli.

Credenziali e passphrase stanno in `deploy/backup.env` (600, fuori da git).
**Se perdi la passphrase i backup remoti sono carta straccia**: deve esistere
anche fuori da questo server.

L'invio è `rclone sync`, non `copy`: la ritenzione decisa qui vale anche
laggiù, senza una seconda regola da tenere allineata a mano. Serve rclone
recente — quello del pacchetto Ubuntu (1.60) fallisce con R2 restituendo 501;
in `/usr/local/bin` c'è quello ufficiale.

## Collaudare l'interfaccia davvero

`puppeteer-core` è in `package.json`, ma **di proposito non scarica nessun
browser**: `npm install` non basta, e la cache resta con le cartelle vuote —
il che sembra un browser installato e non lo è.

```bash
npm run browser:install   # una volta per macchina, ~150 MB in ~/.cache/puppeteer
```

Serve per rispondere con i fatti invece che col ragionamento: un bug
dell'interfaccia si riproduce in una pagina finta di venti righe, si guarda
cosa fa il DOM, e si verifica la correzione **prima** di pubblicarla. Le
volte in cui ho saltato questo passaggio in questo progetto sono le stesse in
cui ho fatto perdere un pomeriggio a qualcuno.

## Trappole già scoperte

- **Agenti sviluppatore = Docker.** Girano dentro `hive/dev-sandbox:latest` con montato solo il progetto (`AGENT_ISOLATION=docker`). Bubblewrap non è utilizzabile: Ubuntu blocca gli user namespace non privilegiati.
- **`canUseTool` non viene chiamato in modalità headless** dall'SDK. Per intercettare i tool si usa l'hook `PreToolUse`.
- **`settingSources`**: il runner locale carica `['user','project','local']`, così ha la stessa potenza di Claude Code da terminale (CLAUDE.md, skill, MCP). Lasciarlo vuoto è un handicap silenzioso.
- **Schemi di modifica**: non usare `createSchema.partial()` per le PATCH — `.partial()` rende i campi facoltativi ma i `.default()` scattano lo stesso, e una modifica parziale azzera quello che non hai mandato. Gli schemi di update si scrivono a mano con `.optional()`.
- **La coda dei turni sta nel DATABASE, non in Redis.** Un turno in attesa è una riga `queued` con `dispatched_at` nullo che porta con sé il suo `job`. Non rimettere il payload in una lista Redis: quando le due fonti divergono (annullamento, runner morto, segnale perso) la riga resta in coda per sempre e blocca tutte quelle dopo, e nessuno può più ricostruire il lavoro. Il raccoglitore rimette in moto le code ferme ogni minuto.
- **La presenza del runner ha un battito suo.** Non legarla al poll dei turni: mentre il runner ESEGUE un lavoro non fa poll, la chiave scade (TTL 30s) e il server lo dà per spento — i messaggi inviati durante un turno lungo fallivano con «runner offline» a macchina accesa.
- **Il pacchetto del runner ha un URL versionato** (`hive-runner-<ver>.tar.gz`). Non riusare un nome fisso: Cloudflare tiene in cache il `.tar.gz` mentre `runner-version` è già aggiornato, e i runner si riavviano in tondo scaricando per sempre la versione vecchia.
- **Segreti**: `.env`, `runner.env` e i `*.bak` non entrano mai in git. Le chiavi del workspace stanno cifrate nel DB (AES-256-GCM).

## Contesto per gli agenti che lavorano qui

Il progetto ha una sua **base di conoscenza dentro Hive** (Documenti) e un **contesto condiviso** (Impostazioni → Contesto condiviso): decisioni di prodotto e note di squadra vivono lì, non in questo file. Questo file descrive il *codice*.
