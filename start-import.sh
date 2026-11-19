#!/bin/sh
# CINELIST local importer. Run as a normal Linux user, NEVER via sudo.
set -eu
cd "$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
umask 077

if [ "$(id -u)" -eq 0 ]; then
  printf '%s\n' 'Nespouštěj importér přes sudo. Spusť ./start-import.sh jako běžný uživatel.' >&2
  exit 1
fi

if [ ! -w . ]; then
  printf '%s\n' 'Složka projektu není zapisovatelná pro tohoto uživatele.' >&2
  exit 1
fi
if [ -d private ] && [ ! -w private ]; then
  printf '%s\n' 'Složka private/ není zapisovatelná. Zkontroluj vlastníka souborů vytvořených dříve přes sudo.' >&2
  exit 1
fi
if [ -f private/movies.json ] && [ ! -w private/movies.json ]; then
  printf '%s\n' 'private/movies.json není zapisovatelný. Zkontroluj vlastníka souboru.' >&2
  exit 1
fi
if [ ! -x .venv/bin/python3 ]; then
  printf '%s\n' 'Vytvářím lokální Python prostředí .venv/ (bez sudo)...'
  if ! python3 -m venv .venv; then
    printf '%s\n' 'Nelze vytvořit venv. Na některých distribucích je potřeba nejdřív nainstalovat systémový balíček python3-venv.' >&2
    exit 1
  fi
fi
if ! .venv/bin/python3 -c 'import requests, bs4' 2>/dev/null; then
  printf '%s\n' 'Instaluji knihovny pouze do .venv/ (bez sudo)...'
  .venv/bin/python3 -m pip install --disable-pip-version-check -r tools/requirements.txt
fi
printf '\n%s\n' 'Otevři http://127.0.0.1:8765/ (ukončení Ctrl+C).'
exec .venv/bin/python3 tools/admin_server.py
