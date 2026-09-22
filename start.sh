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

# Loud, unmissable status line on every single boot — this is the #1 thing
# to check in Render's logs if users/data keep disappearing after a
# redeploy or crash-restart. Silence here (the old behavior) is exactly how
# a misconfiguration goes unnoticed for weeks: the app boots up fine either
# way, so nothing LOOKS wrong until you notice your data is gone.
if [ -z "$LITESTREAM_BUCKET" ]; then
  echo "⚠️  PERSISTENCE DISABLED: LITESTREAM_BUCKET is not set. data/app.db lives only on this container's disk and WILL be wiped on the next redeploy or crash-restart. Set LITESTREAM_BUCKET / LITESTREAM_ENDPOINT / LITESTREAM_ACCESS_KEY_ID / LITESTREAM_SECRET_ACCESS_KEY in Render's Environment settings to fix this — see README.md."
  exec node src/server.js
elif [ ! -f "$LITESTREAM_BIN" ]; then
  echo "⚠️  PERSISTENCE DISABLED: LITESTREAM_BUCKET is set, but $LITESTREAM_BIN doesn't exist — the build step that downloads it (scripts/install-litestream.sh) never ran. This almost always means Render's Build Command isn't 'npm run build' (it's probably still the default 'npm install'). Fix it in Render → your service → Settings → Build Command, then redeploy. Until then data/app.db is NOT being backed up and WILL be wiped on the next redeploy or crash-restart."
  exec node src/server.js
else
  if [ -f "$DB_PATH" ]; then
    echo "✅ PERSISTENCE ENABLED (Litestream): data/app.db already present on disk, skipping restore."
  else
    echo "✅ PERSISTENCE ENABLED (Litestream): data/app.db missing (fresh container) — restoring from the replica..."
    if "$LITESTREAM_BIN" restore -if-replica-exists -config litestream.yml "$DB_PATH"; then
      if [ -f "$DB_PATH" ]; then
        echo "✅ Restore finished — data/app.db is back."
      else
        echo "ℹ️  Restore ran but found no existing replica yet (expected on the very first deploy with these credentials) — starting with a brand-new database."
      fi
    else
      echo "❌ Litestream restore FAILED (see the error above — usually wrong bucket/endpoint/credentials). Starting with a brand-new, EMPTY database rather than crash-looping; fix the LITESTREAM_* env vars and redeploy once you can, or your users list will look empty until then."
    fi
  fi
  echo "Starting app under litestream replicate..."
  exec "$LITESTREAM_BIN" replicate -config litestream.yml -exec "node src/server.js"
fi
