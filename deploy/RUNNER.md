# Hive Runner — eseguire gli agenti sul proprio computer

Di default gli agenti di Hive girano **sul server**. Un agente **sviluppatore**
può però girare **in locale**, sul computer del suo proprietario: lavora sul
codice che hai già sul tuo disco, con le **tue** credenziali Claude e git.
Il server Hive resta il centro dati condiviso a cui il runner si collega.

```
   ┌─────────────┐        job (coda Redis)        ┌──────────────────┐
   │   Server    │ ─────────────────────────────▶ │  Runner (il tuo  │
   │  Hive (hub  │                                │  Mac): esegue    │
   │  dati: DB,  │ ◀───────────────────────────── │  l'agente sul    │
   │  Redis, UI) │     eventi/risposte in chat    │  repo LOCALE     │
   └─────────────┘                                └──────────────────┘
```

Un agente `local` risponde **solo quando il suo runner è acceso**. Se è spento,
in chat compare una nota che invita ad avviarlo.

---

## 1. Preparare il server (una volta)

Il runner raggiunge **Postgres e Redis del server** via LAN/VPN. Di norma sono in
ascolto solo su `127.0.0.1`: vanno aperti verso la rete del team (idealmente
**solo sulla VPN**), con attenzione.

**Postgres** (`/etc/postgresql/16/main/postgresql.conf`):
```
listen_addresses = 'localhost,10.0.0.76'
```
e in `pg_hba.conf` consenti il ruolo `hive` dalla sottorete della VPN:
```
host  all  hive  10.0.0.0/24  scram-sha-256
```

**Redis** (`/etc/redis/redis.conf`): aggiungi l'IP della VPN a `bind` e imposta
una password (`requirepass`), poi usala nel `REDIS_URL` del runner.

> Sicurezza: esponi questi servizi **solo sulla VPN**, mai su internet. Il runner
> ha bisogno della `SECRETS_KEY` del server per leggere i segreti condivisi del
> progetto: trattala come una password. Una variante più blindata (il runner non
> tocca mai il DB, parla solo col server via WebSocket) è nella roadmap.

## 2. Preparare il runner (sul tuo Mac)

```bash
# 1. Node 22+ e git installati. Login Claude locale:
claude setup-token          # oppure usa ~/.claude/.credentials.json

# 2. Prendi il codice di Hive e compila:
git clone <repo-hive> hive && cd hive
npm install
npm run build

# 3. Configura il runner:
cp deploy/runner.env.example deploy/runner.env
#   → compila DATABASE_URL, REDIS_URL, SECRETS_KEY (dal server),
#     HIVE_RUNNER_USER_ID (il tuo id utente, in Impostazioni → profilo),
#     HIVE_WORKSPACE_ROOT (una cartella locale per i repo).

# 4. Avvia:
./deploy/hive-runner.sh
```

Quando parte vedrai:
```
[runner] avviato per l'utente <id> («Il mio Mac») — coda hive:runs:runner:<id>
```

## 3. Rendere un agente "locale"

Nella UI, crea o modifica un **agente sviluppatore** e alla voce **«Dove gira»**
scegli **«Sul mio computer»**. Da quel momento i suoi turni vengono affidati al
tuo runner. Se il runner è spento, l'agente lo dice in chat.

## Domande frequenti

- **Su che codice lavora?** Sul repo che l'agente clona/apre dentro
  `HIVE_WORKSPACE_ROOT`, sul tuo disco. Puoi aprirlo nel tuo editor e vedere le
  modifiche in tempo reale.
- **Chi paga i token?** Tu: usa la tua sottoscrizione/credenziali Claude locali.
- **Serve Docker?** No. Sul tuo computer l'agente gira in locale
  (`AGENT_ISOLATION=none`): il perimetro di fiducia è la tua macchina. Il
  container serve solo agli agenti che girano *sul server*.
- **Più persone, più runner?** Sì: ogni utente avvia il proprio runner e prende
  in carico solo i propri agenti `local`. Il workspace resta condiviso sul server.
