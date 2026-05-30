#!/bin/sh
# Rental Tracker — Mac & Linux launcher
# On Mac: double-click in Finder, or run from terminal with: sh start.command
# On Linux: run from terminal with: sh start.command
ROOT="$(cd "$(dirname "$0")" && pwd)"
APP="$ROOT/app"
RUNTIME="$ROOT/runtime"
NODE_VER="22.16.0"

# ── 1. Find Node.js ───────────────────────────────────────────────────────────
if [ -f "$RUNTIME/bin/node" ]; then
  export PATH="$RUNTIME/bin:$PATH"
elif command -v node >/dev/null 2>&1; then
  NODE_MAJOR=$(node -e "process.stdout.write(String(process.versions.node.split('.')[0]))" 2>/dev/null)
  if [ -n "$NODE_MAJOR" ] && [ "$NODE_MAJOR" -ge 18 ] 2>/dev/null; then
    : # system node is fine
  else
    echo "  System Node.js is too old (need v18+). Downloading a compatible version..."
  fi
else
  echo "  Node.js not found. Downloading now (one-time, ~40 MB)..."
fi

if [ ! -f "$RUNTIME/bin/node" ] && ! (command -v node >/dev/null 2>&1 && [ "$(node -e "process.stdout.write(String(process.versions.node.split('.')[0]))" 2>/dev/null)" -ge 18 ] 2>/dev/null); then
  OS=$(uname -s)
  ARCH=$(uname -m)
  case "$OS" in
    Darwin)
      case "$ARCH" in
        arm64) PLATFORM="darwin-arm64" ;;
        *)     PLATFORM="darwin-x64"   ;;
      esac
      ;;
    Linux)
      case "$ARCH" in
        aarch64|arm64) PLATFORM="linux-arm64" ;;
        *)             PLATFORM="linux-x64"   ;;
      esac
      ;;
    *)
      echo "  Unsupported OS: $OS. Install Node.js v18+ from https://nodejs.org and re-run."
      exit 1
      ;;
  esac

  TARBALL="node-v${NODE_VER}-${PLATFORM}.tar.gz"
  URL="https://nodejs.org/dist/v${NODE_VER}/${TARBALL}"
  TMP="/tmp/${TARBALL}"
  echo "  Downloading Node.js v${NODE_VER} for ${PLATFORM}..."

  if command -v curl >/dev/null 2>&1; then
    curl -fL --progress-bar "$URL" -o "$TMP"
  elif command -v wget >/dev/null 2>&1; then
    wget -q --show-progress "$URL" -O "$TMP"
  else
    echo "  ERROR: Neither curl nor wget found. Install one and try again."
    exit 1
  fi

  if [ $? -ne 0 ] || [ ! -f "$TMP" ]; then
    echo "  ERROR: Download failed. Check your internet connection and try again."
    exit 1
  fi

  echo "  Unpacking..."
  mkdir -p "$RUNTIME"
  tar -xzf "$TMP" -C "$RUNTIME" --strip-components=1
  rm -f "$TMP"

  if [ ! -f "$RUNTIME/bin/node" ]; then
    echo "  ERROR: Extraction failed. Please try again."
    exit 1
  fi

  export PATH="$RUNTIME/bin:$PATH"
  echo "  Node.js ready."
  echo ""
fi

# ── 2. Auto-update ────────────────────────────────────────────────────────────
node "$APP/updater.js"
if [ $? -eq 42 ]; then
  echo "  Refreshing dependencies after update..."
  rm -rf "$APP/node_modules"
fi

# ── 3. Dependencies ───────────────────────────────────────────────────────────
if [ -d "$APP/node_modules" ]; then
  if ! node -e "require('$APP/node_modules/better-sqlite3')" >/dev/null 2>&1; then
    echo "  Rebuilding dependencies for this platform..."
    rm -rf "$APP/node_modules"
  fi
fi

if [ ! -d "$APP/node_modules" ]; then
  echo "  Installing dependencies (one-time, ~30 seconds)..."
  npm install --omit=dev --prefix "$APP"
  if [ $? -ne 0 ]; then
    echo ""
    echo "  ERROR: npm install failed. Check your internet connection and try again."
    exit 1
  fi
  echo ""
fi

# ── 4. Start server and open browser ─────────────────────────────────────────
echo ""
echo "  Rental Tracker is running at http://localhost:3000"
echo "  Leave this window open while using the app."
echo "  Press Ctrl+C to stop."
echo ""

(sleep 2 && open "http://localhost:3000" 2>/dev/null || xdg-open "http://localhost:3000" 2>/dev/null || true) &

node "$APP/server.js"
