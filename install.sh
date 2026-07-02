#!/usr/bin/env bash
# Zolana Sentinel — one-line installer (full dependencies).
#
#   curl -fsSL https://raw.githubusercontent.com/rygroup-dev/zolana-sentinel/main/install.sh | bash
#
# Installs Node.js (if missing), clones the repo, installs all npm dependencies,
# and scaffolds the .env config. Idempotent — safe to re-run.
set -euo pipefail

REPO="https://github.com/rygroup-dev/zolana-sentinel.git"
DIR="${ZOLANA_DIR:-$HOME/zolana-sentinel}"
NODE_MAJOR=20

log() { printf '\033[1;36m[zolana]\033[0m %s\n' "$*"; }

# 1. Node.js (>= 18)
if ! command -v node >/dev/null 2>&1 || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 18 ]; then
  log "Installing Node.js ${NODE_MAJOR}.x ..."
  if command -v apt-get >/dev/null 2>&1; then
    curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | sudo -E bash -
    sudo apt-get install -y nodejs
  elif command -v dnf >/dev/null 2>&1; then
    curl -fsSL "https://rpm.nodesource.com/setup_${NODE_MAJOR}.x" | sudo -E bash -
    sudo dnf install -y nodejs
  elif command -v brew >/dev/null 2>&1; then
    brew install "node@${NODE_MAJOR}"
  else
    log "Please install Node.js >= 18 manually, then re-run."; exit 1
  fi
fi
log "Node $(node -v), npm $(npm -v)"

# 2. Clone or update
if [ -d "$DIR/.git" ]; then
  log "Updating existing checkout in $DIR"
  git -C "$DIR" pull --ff-only || true
else
  log "Cloning into $DIR"
  git clone --depth 1 "$REPO" "$DIR"
fi
cd "$DIR"

# 3. Dependencies (full install)
log "Installing npm dependencies ..."
npm install --no-audit --no-fund

# 4. Config scaffold
if [ ! -f .env ]; then
  cp .env.example .env
  chmod 600 .env
  log ".env created from .env.example — edit it with your keys before running."
fi

cat <<EOF

  ✅ Zolana Sentinel installed at $DIR

  Next:
    1. Edit $DIR/.env  (ZOLANA_PRIVATE_KEY, ZOLANA_TELEGRAM_BOT_TOKEN, ZOLANA_TELEGRAM_CHAT_ID)
    2. Run:            cd $DIR && node src/index.js
       One cycle:      node src/index.js --once
       Or as a service (Linux): see README.md

EOF
