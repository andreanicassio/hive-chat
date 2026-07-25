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
pat = re.compile(r'^hive-(\d{4}-\d{2}-\d{2}T\d{6}Z)(-uploads\.tar\.gz|\.dump)$')

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

echo "[backup] ok: $(basename "$dump") ($(du -h "$dump" | cut -f1))"
