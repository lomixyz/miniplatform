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
    # Quick reachability probe BEFORE calling litestream — if restore hangs
    # with zero log output (no "downloaded wal"/"applied wal" lines at all),
    # that means it never even got past its first request to the endpoint,
    # which points at basic network/DNS/TLS reachability from this Render
    # instance to LITESTREAM_ENDPOINT rather than a slow/large replica. This
    # curl has its own 15s cap and never blocks the boot either way.
    echo "ℹ️  Probing LITESTREAM_ENDPOINT reachability: $LITESTREAM_ENDPOINT"
    curl -sS -o /dev/null -w "ℹ️  Endpoint probe result: HTTP %{http_code}, connect=%{time_connect}s, tls=%{time_appconnect}s, total=%{time_total}s\n" --max-time 15 "$LITESTREAM_ENDPOINT" || echo "❌ Endpoint probe FAILED or timed out after 15s — this strongly suggests a network/DNS/TLS reachability issue from this Render instance to Backblaze, not a slow/large replica."
    # Second diagnostic: ask litestream itself to just LIST the generations
    # on the replica (a cheap metadata call — no data download) with its own
    # tight 20s cap. If this prints a generation/lag table quickly, basic
    # connectivity + credentials + bucket listing are all fine, and the real
    # `restore` below is hanging during actual WAL/snapshot data transfer. If
    # THIS hangs or errors too, the problem is earlier — bad credentials,
    # wrong bucket/path, or a listing-permission issue — not a slow restore.
    echo "ℹ️  Probing replica generations (metadata only, no data download)..."
    if timeout 20s "$LITESTREAM_BIN" generations -config litestream.yml "$DB_PATH"; then
      echo "ℹ️  Generations listing succeeded above — connectivity/credentials/listing are fine; if restore still hangs below, the issue is in the data-transfer phase."
    else
      GEN_EXIT=$?
      if [ "$GEN_EXIT" -eq 124 ]; then
        echo "❌ Generations listing itself TIMED OUT after 20s — this points to a credentials/permissions or bucket-listing problem (not just a slow restore), since this call does no data download at all."
      else
        echo "❌ Generations listing FAILED (exit $GEN_EXIT, see error above) — check LITESTREAM_BUCKET/ACCESS_KEY/SECRET_KEY."
      fi
    fi
    # Capped at 90s with `timeout` — a bad/unreachable LITESTREAM_* endpoint or
    # revoked credentials can make `litestream restore` hang silently instead
    # of erroring out, which used to block the app from ever starting (no
    # port ever opens, so Render's deploy eventually times out at ~5-10min
    # with "Port scan timeout reached", stuck on the OLD build anyway, just
    # much slower). Failing fast here gets Render to the SAME end state —
    # this deploy marked failed, previous one still live — in 90s instead of
    # 5-10min, and surfaces the real reason via the probe + messages above.
    if timeout 90s "$LITESTREAM_BIN" restore -if-replica-exists -config litestream.yml "$DB_PATH"; then
      if [ -f "$DB_PATH" ]; then
        echo "✅ Restore finished — data/app.db is back."
      else
        echo "ℹ️  Restore ran but found no existing replica yet (expected on the very first deploy with these credentials) — starting with a brand-new database."
      fi
    else
      RESTORE_EXIT=$?
      # IMPORTANT: unlike an earlier version of this script, a failed/timed-out
      # restore no longer falls back to booting with an empty database. If it
      # did, THIS container would still pass its health check and Render would
      # cut traffic over to it — permanently destroying whatever real data is
      # only on the OLD container that's live right now. Far safer to fail
      # the boot outright: Render keeps serving the last known-good deploy
      # while this one shows as failed, and no data is ever at risk.
      rm -f "$DB_PATH"
      if [ "$RESTORE_EXIT" -eq 124 ]; then
        echo "❌ Litestream restore TIMED OUT after 90s (it never returned — see the endpoint probe result above). Refusing to boot with an empty database — failing this deploy instead, so Render keeps serving the previous working version. Fix LITESTREAM_ENDPOINT/BUCKET/credentials or network reachability, then redeploy."
      else
        echo "❌ Litestream restore FAILED (see the error above — usually wrong bucket/endpoint/credentials). Refusing to boot with an empty database — failing this deploy instead, so Render keeps serving the previous working version. Fix the LITESTREAM_* env vars, then redeploy."
      fi
      exit 1
    fi
  fi
  echo "Starting app under litestream replicate..."
  exec "$LITESTREAM_BIN" replicate -config litestream.yml -exec "node src/server.js"
fi
