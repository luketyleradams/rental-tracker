#!/bin/sh
cd "$(dirname "$0")"

if command -v git >/dev/null 2>&1 && [ -d ".git" ]; then
  echo "Checking for updates..."
  git pull --quiet && echo "Up to date." || echo "Update failed (continuing with current version)."
  echo ""
fi

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js is not installed. Download it from https://nodejs.org"
  exit 1
fi

if [ -d "node_modules" ]; then
  if ! node -e "require('better-sqlite3')" >/dev/null 2>&1; then
    echo "Dependencies need to be rebuilt for this platform..."
    rm -rf node_modules
  fi
fi

if [ ! -d "node_modules" ]; then
  echo "First run — installing dependencies..."
  npm install --omit=dev
fi

echo ""
echo "  Rental Tracker running at http://localhost:3000"
echo "  Press Ctrl+C to stop."
echo ""

# Open browser after server has had a moment to start
(sleep 2 && open "http://localhost:3000" 2>/dev/null || xdg-open "http://localhost:3000" 2>/dev/null || true) &

node server.js
