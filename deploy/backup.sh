#!/usr/bin/env bash
#
# Copia di sicurezza di Hive: database + allegati.
#
# Due cose insieme, perché separate non servono a niente: il database senza
# gli allegati ti ridà una chat piena di immagini mancanti, e gli allegati
# senza il database sono file con un nome a caso.
#
# Ogni copia viene RILETTA subito dopo essere stata scritta. Un backup che
# non si apre non è un backup, ed è il modo classico di scoprirlo il giorno
# sbagliato.
#
# Ripristino (il motivo per cui tutto questo esiste):
#   pg_restore -h 127.0.0.1 -U hive -d hive --clean --if-exists FILE.dump
#   tar xzf FILE-uploads.tar.gz -C /
#
set -euo pipefail

DEST="${HIVE_BACKUP_DIR:-/srv/hive/backups}"
UPLOADS="${HIVE_UPLOAD_ROOT:-/srv/hive/uploads}"
PGHOST="${PGHOST:-127.0.0.1}"
PGUSER="${PGUSER:-hive}"
PGDATABASE="${PGDATABASE:-hive}"
STAMP="$(date -u +%Y-%m-%dT%H%M%SZ)"

mkdir -p "$DEST"

dump="$DEST/hive-$STAMP.dump"
files="$DEST/hive-$STAMP-uploads.tar.gz"

# -Fc: formato compresso di Postgres, ripristinabile tabella per tabella.
pg_dump -h "$PGHOST" -U "$PGUSER" -d "$PGDATABASE" -Fc -f "$dump"

# La verifica vera: se l'indice non si legge, il file non vale niente.
if ! pg_restore --list "$dump" >/dev/null 2>&1; then
  echo "[backup] ERRORE: il dump appena scritto non è leggibile: $dump" >&2
  rm -f "$dump"
  exit 1
fi

if [ -d "$UPLOADS" ]; then
  tar czf "$files" -C / "${UPLOADS#/}"
  if ! tar tzf "$files" >/dev/null 2>&1; then
    echo "[backup] ERRORE: l'archivio allegati non è leggibile: $files" >&2
    rm -f "$files"
    exit 1
  fi
fi

# --- Ritenzione a scalare -------------------------------------------------
#
# Tutte le copie degli ultimi 7 giorni; poi una a settimana per due mesi;
# poi una al mese per sei. Serve a coprire due guasti diversi: quello che
# scopri subito e quello che scopri fra tre mesi, quando ti accorgi che una
# conversazione è sparita da un pezzo.
python3 - "$DEST" <<'PY'
import os, re, sys
from datetime import datetime, timedelta, timezone

dest = sys.argv[1]
now = datetime.now(timezone.utc)
pat = re.compile(r'^hive-(\d{4}-\d{2}-\d{2}T\d{6}Z)(-uploads\.tar\.gz|-env|\.dump)(\.gpg)?$')

# Raggruppa dump e allegati sotto la stessa data: si tengono o si buttano
# insieme, altrimenti resta un database senza le sue immagini.
groups: dict[str, list[str]] = {}
for name in os.listdir(dest):
    m = pat.match(name)
    if not m:
        continue
    groups.setdefault(m.group(1), []).append(name)

def when(stamp: str) -> datetime:
    return datetime.strptime(stamp, '%Y-%m-%dT%H%M%SZ').replace(tzinfo=timezone.utc)

keep: set[str] = set()
stamps = sorted(groups, key=when, reverse=True)

# Tutto quello che sta negli ultimi 7 giorni.
for s in stamps:
    if now - when(s) <= timedelta(days=7):
        keep.add(s)

# Una per settimana fino a due mesi, una per mese fino a sei.
seen_week: set[tuple] = set()
seen_month: set[tuple] = set()
for s in stamps:
    age = now - when(s)
    d = when(s)
    if age <= timedelta(days=63):
        key = d.isocalendar()[:2]
        if key not in seen_week:
            seen_week.add(key)
            keep.add(s)
    if age <= timedelta(days=190):
        key = (d.year, d.month)
        if key not in seen_month:
            seen_month.add(key)
            keep.add(s)

removed = 0
for s in stamps:
    if s in keep:
        continue
    for name in groups[s]:
        os.remove(os.path.join(dest, name))
        removed += 1
print(f'[backup] copie tenute: {len(keep)}, file rimossi: {removed}')
PY

# --- Copia fuori sede, cifrata ----------------------------------------
#
# Tutto quello che esce da questa macchina esce cifrato. Non perche' R2 sia
# insicuro — e' privato — ma perche' dentro c'e' ogni messaggio mai scritto,
# e una copia in chiaro su un servizio altrui e' una decisione che non voglio
# prendere per distrazione.
#
# Ci va anche il `.env`: contiene SECRETS_KEY, la chiave che apre i segreti
# dei progetti nel database. Senza, un ripristino ti ridarebbe le righe
# cifrate e nessun modo di leggerle.
ENVFILE="${HIVE_ENV_FILE:-/home/andrea/hive/.env}"
CONF="${HIVE_BACKUP_ENV:-/home/andrea/hive/deploy/backup.env}"

if [ -r "$CONF" ]; then
  set -a; . "$CONF"; set +a
fi

if [ -n "${BACKUP_PASSPHRASE:-}" ]; then
  enc() {
    gpg --batch --yes --quiet --symmetric --cipher-algo AES256 \
      --passphrase "$BACKUP_PASSPHRASE" -o "$1.gpg" "$1"
    # Riletto subito: una copia cifrata che non si apre e' peggio di nessuna
    # copia, perche' ti fa credere di essere coperto.
    if ! gpg --batch --quiet --decrypt --passphrase "$BACKUP_PASSPHRASE" \
         -o /dev/null "$1.gpg" 2>/dev/null; then
      echo "[backup] ERRORE: cifratura non verificabile per $1" >&2
      rm -f "$1.gpg"
      exit 1
    fi
  }
  enc "$dump"
  [ -f "$files" ] && enc "$files"
  if [ -r "$ENVFILE" ]; then
    cp "$ENVFILE" "$DEST/hive-$STAMP-env"
    enc "$DEST/hive-$STAMP-env"
    rm -f "$DEST/hive-$STAMP-env"   # in chiaro non resta mai a terra
  fi
fi

if [ -n "${R2_BUCKET:-}" ] && command -v rclone >/dev/null 2>&1; then
  export RCLONE_CONFIG_R2_TYPE=s3
  export RCLONE_CONFIG_R2_PROVIDER=Cloudflare
  export RCLONE_CONFIG_R2_ACCESS_KEY_ID="$R2_ACCESS_KEY_ID"
  export RCLONE_CONFIG_R2_SECRET_ACCESS_KEY="$R2_SECRET_ACCESS_KEY"
  export RCLONE_CONFIG_R2_ENDPOINT="$R2_ENDPOINT"
  export RCLONE_CONFIG_R2_NO_CHECK_BUCKET=true
  # `sync` e non `copy`: cosi' la ritenzione decisa qui sopra vale anche
  # laggiu', senza una seconda regola da tenere allineata a mano.
  rclone sync "$DEST" "r2:$R2_BUCKET" --include "*.gpg" --stats-one-line -q
  echo "[backup] fuori sede: $(rclone ls "r2:$R2_BUCKET" -q | wc -l) file su R2"
fi

echo "[backup] ok: $(basename "$dump") ($(du -h "$dump" | cut -f1))"
