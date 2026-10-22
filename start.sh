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

# Backblaze B2 (unlike Cloudflare R2) rejects/mishandles region: "auto" — it
# needs the EXACT region string from its own endpoint hostname
# (s3.<region>.backblazeb2.com). A wrong region breaks the S3 request
# signature, which some S3 clients retry silently instead of erroring out —
# that silent retry loop is the leading suspect for the restore hangs seen
# in Render's logs. Derive it automatically from LITESTREAM_ENDPOINT so a
# manual LITESTREAM_REGION env var is optional; set LITESTREAM_REGION
# explicitly in Render to override this if it's ever wrong.
if [ -z "$LITESTREAM_REGION" ] && [ -n "$LITESTREAM_ENDPOINT" ]; then
  DERIVED_REGION=$(echo "$LITESTREAM_ENDPOINT" | sed -E 's#^https?://s3\.([a-z0-9-]+)\.backblazeb2\.com.*#\1#')
  if [ "$DERIVED_REGION" != "$LITESTREAM_ENDPOINT" ] && [ -n "$DERIVED_REGION" ]; then
    export LITESTREAM_REGION="$DERIVED_REGION"
    echo "ℹ️  Derived LITESTREAM_REGION=\"$LITESTREAM_REGION\" from LITESTREAM_ENDPOINT (region: auto is wrong for Backblaze B2)."
  else
    echo "⚠️  Could not derive a region from LITESTREAM_ENDPOINT=\"$LITESTREAM_ENDPOINT\" — set LITESTREAM_REGION explicitly in Render's Environment settings (e.g. us-east-005)."
  fi
fi

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
