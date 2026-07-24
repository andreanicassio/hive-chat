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
npm run typecheck      # tsc -b su tutto
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
./deploy/publish-runner.sh 0.4.1    # esbuild + tarball in /srv/hive/downloads
```

## Dati

Postgres 16 e Redis 7 girano in locale.

```bash
PGPASSWORD=hive_dev_local psql -h 127.0.0.1 -U hive -d hive
```

Lo schema vive in `packages/db/src/schema.ts`. **Le migrazioni non sono automatiche in produzione**: aggiungendo una colonna, applica anche l'`ALTER TABLE` a mano sul DB, altrimenti il codice nuovo gira su uno schema vecchio.

Redis porta le code dei run, la presenza dei runner e il fanout realtime fra i nodi API.

## Convenzioni

- **Il codice parla italiano**: commenti, messaggi d'errore, testi dell'interfaccia. I nomi di variabili e funzioni restano in inglese.
- **I commenti spiegano il perché**, non il cosa. Se una riga è ovvia, niente commento.
- Niente `any` gratuiti: i tipi condivisi stanno in `@hive/shared`, si estendono lì.
- L'interfaccia dà del tu e non usa gergo tecnico dove può farne a meno.
- Ogni pop-up passa dal componente `Modal` (`apps/web/src/components/Modal.tsx`): dà Esc, click fuori, blocco dello scroll e impilamento coerenti.

## Trappole già scoperte

- **Agenti sviluppatore = Docker.** Girano dentro `hive/dev-sandbox:latest` con montato solo il progetto (`AGENT_ISOLATION=docker`). Bubblewrap non è utilizzabile: Ubuntu blocca gli user namespace non privilegiati.
- **`canUseTool` non viene chiamato in modalità headless** dall'SDK. Per intercettare i tool si usa l'hook `PreToolUse`.
- **`settingSources`**: il runner locale carica `['user','project','local']`, così ha la stessa potenza di Claude Code da terminale (CLAUDE.md, skill, MCP). Lasciarlo vuoto è un handicap silenzioso.
- **Schemi di modifica**: non usare `createSchema.partial()` per le PATCH — `.partial()` rende i campi facoltativi ma i `.default()` scattano lo stesso, e una modifica parziale azzera quello che non hai mandato. Gli schemi di update si scrivono a mano con `.optional()`.
- **Segreti**: `.env`, `runner.env` e i `*.bak` non entrano mai in git. Le chiavi del workspace stanno cifrate nel DB (AES-256-GCM).

## Contesto per gli agenti che lavorano qui

Il progetto ha una sua **base di conoscenza dentro Hive** (Documenti) e un **contesto condiviso** (Impostazioni → Contesto condiviso): decisioni di prodotto e note di squadra vivono lì, non in questo file. Questo file descrive il *codice*.
