#!/bin/bash
# Production start script. If Litestream env vars are configured (Render),
# restore the last known database snapshot from cloud storage before boot,
# then run the app under `litestream replicate -exec` so every write keeps
# streaming to that storage in the background. Locally (no LITESTREAM_BUCKET
# set) this just runs the app normally, exactly like `npm start` always did.
set -e

DB_PATH="data/app.db"
LITESTREAM_BIN="./bin/litestream"

mkdir -p data

if [ -n "$LITESTREAM_BUCKET" ] && [ -f "$LITESTREAM_BIN" ]; then
  if [ ! -f "$DB_PATH" ]; then
    echo "Restoring database from Litestream replica (if one exists)..."
    "$LITESTREAM_BIN" restore -if-replica-exists -config litestream.yml "$DB_PATH" || true
  fi
  echo "Starting app under litestream replicate..."
  exec "$LITESTREAM_BIN" replicate -config litestream.yml -exec "node src/server.js"
else
  exec node src/server.js
fi
