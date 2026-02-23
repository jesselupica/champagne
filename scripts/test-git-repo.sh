#!/bin/bash
set -e

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

echo ""
echo "✓ Test repository created with:"
echo "  - main branch (3 commits)"
echo "  - feature/login branch (2 commits)"
echo "  - feature/dashboard branch (2 commits)"
echo "  - bugfix/navbar branch (1 commit)"
echo ""
echo "Repository location: $TEST_REPO"
echo ""
echo "Starting ISL server..."
echo ""

# Start the dev server from the champagne root
cd "$(dirname "$0")/.."
yarn dev browser --launch "$TEST_REPO"
