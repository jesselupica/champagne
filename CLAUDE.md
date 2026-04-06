# Champagne Project

## Vision: Universal VCS Support

**PRIMARY GOAL**: Make ISL's excellent graphical user interface work with ANY version control system that supports single-developer feature branches off a master branch.

### Supported Backends

- **Sapling** (reference implementation)
- **Git** (raw git commands)
- **Graphite** (Git wrapper)
- **Git Branchless** (Git extension)

### Three-Phase Plan

1. **Document the VCS Interface** - See [docs/spec.md](docs/spec.md) and [docs/vcs-operations-manifest.md](docs/vcs-operations-manifest.md)
2. **Refactor ISL Server** - Extract pluggable VCS driver architecture. See [docs/plan.md](docs/plan.md)
3. **Implement Additional Drivers** - Git, Graphite, Git Branchless

### Project Structure

```
champagne/
├── docs/             # VCS driver spec, operations manifest, implementation plan
├── isl/              # React frontend UI (client)
├── isl-server/       # Node.js backend server
├── vscode/           # VSCode extension
├── shared/           # Shared utilities and libraries
├── components/       # Reusable UI component library
├── textmate/         # Syntax highlighting support
├── scripts/          # Build and development scripts
└── package.json      # Yarn workspace configuration
```

## Prerequisites

- **Node.js** (v16 or later)
- **Yarn** (v1.22.22 or compatible)
- **Git**
- **Sapling SCM** (for testing with Sapling repos)

## Development

### Install

```bash
yarn install
```

### Run (Browser)

```bash
yarn dev browser --launch .
```

- Client: `http://localhost:3000`, Server: `http://localhost:3001`
- Hot-reloads on client changes. Press `R` to restart server, `Q` to quit.

### Run (VSCode Extension)

```bash
yarn dev vscode --launch .
```

### Advanced Server Options

```bash
# Terminal 1: Build and watch (no launch)
yarn dev browser

# Terminal 2: Run server with full logging
cd isl-server
yarn serve --dev --force --foreground --stdout --cwd /path/to/repo
```

Server flags: `--dev` (hot-reload frontend), `--force` (kill existing), `--foreground`, `--stdout`, `--cwd <path>`

### Production Builds

```bash
yarn dev --production
```

### Testing

```bash
cd isl && yarn test                        # Client tests
cd isl-server && yarn test                 # Server tests
HIDE_RTL_DOM_ERRORS=1 yarn test            # Suppress DOM errors
```

### Linting

```bash
yarn eslint
yarn prettier-fix
yarn prettier-check
```

### Adding Dependencies

```bash
cd isl && yarn add <package>          # Client
cd isl-server && yarn add <package>   # Server
cd shared && yarn add <package>       # Shared
```

## Architecture

- **Client**: React 18, Jotai (state), StyleX (styling), Vite (build)
- **Server**: Node.js, TypeScript, Rollup (bundling)
- **Protocol**: WebSocket, bidirectional, token-authenticated
- **Watching**: Watchman (preferred) or polling fallback
- **UI**: Optimistic updates, operation queuing

## Important Rules

- **Never run the Champagne app (server/dev) against the champagne repo itself.** Use `scripts/test-git-repo.sh` to create a separate test repo for testing the UI.
- **Always update the VSIX changelog** (`vscode/CHANGELOG.md`) when bumping the extension version. Add a new entry at the top with the version number, date, and a summary of changes.

## Troubleshooting

- **Port conflicts**: `yarn serve --force --dev`
- **Build errors**: `rm -rf node_modules */node_modules && yarn install`
- **VSCode extension not loading**: Ensure both webview and extension are built, reload VSCode window
