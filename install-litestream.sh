#!/bin/bash
# Downloads the Litestream binary (a standalone Go program, no npm package
# needed) into ./bin/litestream during the Render build step. Safe to run
# more than once — skips the download if the binary is already present.
# Litestream continuously streams every SQLite write to S3-compatible
# storage (e.g. Cloudflare R2) and restores the database from there on boot,
# so data/app.db survives every redeploy without any change to how the app
# itself talks to SQLite (see start.sh).
set -e

LITESTREAM_VERSION="0.3.13"
BIN_DIR="$(dirname "$0")/../bin"
BIN_PATH="$BIN_DIR/litestream"

if [ -f "$BIN_PATH" ]; then
  echo "litestream already installed at $BIN_PATH"
  exit 0
fi

mkdir -p "$BIN_DIR"
echo "Downloading litestream v$LITESTREAM_VERSION..."
curl -sSL "https://github.com/benbjohnson/litestream/releases/download/v${LITESTREAM_VERSION}/litestream-v${LITESTREAM_VERSION}-linux-amd64.tar.gz" \
  | tar -xz -C "$BIN_DIR"
chmod +x "$BIN_PATH"
echo "litestream installed at $BIN_PATH"
