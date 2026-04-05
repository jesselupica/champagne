#!/bin/bash
set -e

# Parse arguments
VCS_TYPE="${1:-git}"
if [[ "$VCS_TYPE" != "sapling" && "$VCS_TYPE" != "git" ]]; then
  echo "Usage: $0 [sapling|git]"
  echo "  Default: sapling"
  exit 1
fi

# Capture script directory before any cd
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CHAMPAGNE_ROOT="$SCRIPT_DIR/.."

# Create test repository in /tmp
TEST_REPO="/tmp/champagne-git-test-$(date +%s)"
echo "Creating test Git repository at: $TEST_REPO"

# Initialize Git repo
mkdir -p "$TEST_REPO"
cd "$TEST_REPO"
git init
git config user.email "test@champagne.dev"
git config user.name "Champagne Test"

# Create initial commit on main
echo "# Test Repository" > README.md
git add README.md
git commit -m "Initial commit"

# Rename master to main if needed
CURRENT_BRANCH=$(git branch --show-current)
if [ "$CURRENT_BRANCH" = "master" ]; then
  git branch -m master main
fi

# Create some commits on main
echo "main content" > main.txt
git add main.txt
git commit -m "Add main content"

echo "more main work" >> main.txt
git add main.txt
git commit -m "Update main content"

# Create feature branch with commits
git checkout -b feature/login
echo "login page" > login.html
git add login.html
git commit -m "Add login page"

echo "login styles" > login.css
git add login.css
git commit -m "Add login styles"

# Create another feature branch from main
git checkout main
git checkout -b feature/dashboard
echo "dashboard page" > dashboard.html
git add dashboard.html
git commit -m "Add dashboard page"

echo "dashboard widgets" >> dashboard.html
git add dashboard.html
git commit -m "Add dashboard widgets"

# Create a bugfix branch
git checkout main
git checkout -b bugfix/navbar
echo "navbar fix" > navbar.js
git add navbar.js
git commit -m "Fix navbar collapse issue"

# Go back to main
git checkout main

# --- Merge conflict branches ---
# First, create a shared base file on main that both branches will modify
echo "line 1: shared header" > conflict-demo.txt
echo "line 2: original content" >> conflict-demo.txt
echo "line 3: more content" >> conflict-demo.txt
echo "function hello() { return 'hello'; }" > utils.js
echo "config: default" > settings.cfg
git add conflict-demo.txt utils.js settings.cfg
git commit -m "Add shared files for conflict demo"

# Branch: onto-me-for-merge-conflict (the rebase destination)
git checkout -b onto-me-for-merge-conflict main

# 1. Content conflict: modify same lines in conflict-demo.txt
echo "line 1: shared header" > conflict-demo.txt
echo "line 2: ONTO version of content" >> conflict-demo.txt
echo "line 3: more content" >> conflict-demo.txt
git add conflict-demo.txt

# 2. Delete/modify conflict: delete utils.js
git rm utils.js

# 3. Add/add conflict: create a new file both branches will add
echo "created by onto-me branch" > new-feature.txt
git add new-feature.txt

# 4. Rename conflict: rename settings.cfg
git mv settings.cfg config.yaml
git commit -m "Onto-me changes: edit content, delete utils, add new-feature, rename settings"

# Branch: rebase-me (the branch to rebase)
git checkout -b rebase-me main

# 1. Content conflict: modify same lines differently in conflict-demo.txt
echo "line 1: shared header" > conflict-demo.txt
echo "line 2: REBASE-ME version of content" >> conflict-demo.txt
echo "line 3: more content" >> conflict-demo.txt
git add conflict-demo.txt

# 2. Delete/modify conflict: modify utils.js (other branch deleted it)
echo "function hello() { return 'hi there'; }" > utils.js
git add utils.js

# 3. Add/add conflict: create same file with different content
echo "created by rebase-me branch" > new-feature.txt
git add new-feature.txt

# 4. Rename conflict: rename settings.cfg to something different
git mv settings.cfg preferences.ini
git commit -m "Rebase-me changes: edit content, modify utils, add new-feature, rename settings"

# Go back to main
git checkout main

# Create a bare remote and push all branches so remote tracking works
BARE_REMOTE="/tmp/champagne-remote-$(date +%s)"
git clone --bare . "$BARE_REMOTE"
git remote add origin "$BARE_REMOTE"
git fetch origin
# Set up tracking for all branches
for branch in main feature/login feature/dashboard bugfix/navbar onto-me-for-merge-conflict rebase-me; do
  git branch --set-upstream-to="origin/$branch" "$branch" 2>/dev/null || true
done

echo ""
echo "✓ Test repository created with:"
echo "  - main branch (3 commits)"
echo "  - feature/login branch (2 commits)"
echo "  - feature/dashboard branch (2 commits)"
echo "  - bugfix/navbar branch (1 commit)"
echo "  - onto-me-for-merge-conflict branch (1 commit, rebase target)"
echo "  - rebase-me branch (1 commit, rebase this onto the above for conflicts)"
echo "  Conflict types: content, delete/modify, add/add, rename/rename"
echo "  - bare remote at: $BARE_REMOTE"
echo ""
echo "Repository location: $TEST_REPO"
echo ""
echo "========================================"
echo "Installing dependencies & building..."
echo "========================================"
echo ""

cd "$CHAMPAGNE_ROOT"
yarn install --frozen-lockfile 2>&1 | tail -1
echo "Building server..."
cd "$CHAMPAGNE_ROOT/isl-server" && yarn build 2>&1 | tail -1
echo ""

echo "========================================"
echo "Starting ISL server..."
echo "========================================"
echo ""
echo "IMPORTANT: WebSockets require SOCKS proxy for SSH tunneling!"
echo ""
echo "On your LOCAL machine, run this SSH command:"
echo "  ssh -D 8080 jesselupica@100.85.241.138"
echo ""
echo "Then configure your browser to use SOCKS5 proxy:"
echo "  Host: localhost"
echo "  Port: 8080"
echo ""
echo "Firefox: Settings → Network Settings → Manual proxy → SOCKS Host: localhost, Port: 8080, SOCKS v5"
echo "Chrome: Run with --proxy-server=\"socks5://localhost:8080\""
echo ""
echo "The server URL will be printed below (use it after configuring the proxy):"
echo "========================================"
echo ""

# Start the client (Vite) and server

# Graceful shutdown: kill child processes on exit/signal
cleanup() {
  echo ""
  echo "Shutting down..."
  [ -n "$CLIENT_PID" ] && kill "$CLIENT_PID" 2>/dev/null
  [ -n "$SERVER_PID" ] && kill "$SERVER_PID" 2>/dev/null
  wait 2>/dev/null
  echo "Done."
  exit 0
}
trap cleanup INT TERM EXIT

# Log files for debugging
LOG_DIR="/tmp/champagne-logs"
mkdir -p "$LOG_DIR"
CLIENT_LOG="$LOG_DIR/client.log"
SERVER_LOG="$LOG_DIR/server.log"
echo "Logs: $LOG_DIR/{client,server}.log"

# Start Vite client in the background
cd "$CHAMPAGNE_ROOT/isl" || exit 1
yarn start 2>&1 | tee "$CLIENT_LOG" &
CLIENT_PID=$!

# Start the ISL server in the background (so trap can catch signals)
cd "$CHAMPAGNE_ROOT/isl-server" || exit 1
yarn serve --dev --foreground --stdout --force --vcs-type "$VCS_TYPE" --cwd "$TEST_REPO" 2>&1 | tee "$SERVER_LOG" &
SERVER_PID=$!

# Wait for either process to exit
wait
