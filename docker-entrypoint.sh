#!/bin/sh
set -e
if [ ! -w "$DATA_DIR" ]; then
  echo "Složka dat $DATA_DIR není zapisovatelná pro uživatele $(id -u). Svazek musí patřit uživateli s UID $(id -u)." >&2
  exit 1
fi
exec "$@"
