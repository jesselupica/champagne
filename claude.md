# Champagne Project

## High-Level Intent

Champagne is a fork of the Interactive Smartlog (ISL) components from the Sapling SCM project. The goal is to extract and maintain the ISL web application, server, and VSCode extension as a standalone project.

### What is ISL?

Interactive Smartlog (ISL) is an embeddable, web-based GUI for Sapling SCM. It provides:
- A modern React-based user interface for version control
- Real-time repository monitoring and visualization
- Interactive commit management and history visualization
- VSCode extension integration
- Web-based and desktop access modes

### Project Structure

This repository contains the following components extracted from Sapling:

```
champagne/
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

Before you begin, ensure you have:
- **Node.js** (v16 or later recommended)
- **Yarn** package manager (v1.22.22 or compatible)
- **Git** for version control
- **Sapling SCM** installed if you want to test with actual repositories

## Installation

1. Clone or navigate to the champagne directory:
```bash
cd ~/champagne
```

2. Install all dependencies using Yarn workspaces:
```bash
yarn install
```

This will install dependencies for all workspace packages (isl, isl-server, vscode, shared, components, textmate).

## Development Workflow

### Running the Web App + Server (Browser Mode)

To run the ISL web application with hot-reloading in development mode:

```bash
yarn dev browser --launch .
```

This command does three things:
1. Builds the client (React app) and watches for changes
2. Builds the server and watches for changes
3. Launches a local server instance that opens ISL in your browser

The `--launch .` argument specifies the current directory as the repository to open. You can replace `.` with any path to a Sapling repository.

**Development server details:**
- Client runs on: `http://localhost:3000`
- Server runs on: `http://localhost:3001`
- The webpage will hot-reload as you make changes
- The server must be manually restarted to pick up server-side changes
- Press `R` while the dev command is running to restart just the server
- Press `Q` or `Ctrl+C` to quit

### Advanced Server Options

For more verbose server output, you can build without launching and then run the server separately:

```bash
# Terminal 1: Build and watch for changes (no launch)
yarn dev browser

# Terminal 2: Launch server with full logging
cd isl-server
yarn serve --dev --force --foreground --stdout --cwd /path/to/repo
```

**Server flags explained:**
- `--dev`: Connect to vite's hot-reloading frontend (port 3000)
- `--force`: Kill any existing ISL server on this port
- `--foreground`: Run in foreground (Ctrl+C kills the server)
- `--stdout`: Print server logs to stdout
- `--cwd`: Specify repository path to open

### Running the VSCode Extension

To develop the VSCode extension:

```bash
yarn dev vscode --launch .
```

This command:
1. Builds the webview (client) and watches for changes
2. Builds the extension host and watches for changes
3. Launches VSCode in extension development mode

You can also build without launching and open VSCode manually:

```bash
# Build only
yarn dev vscode

# Then open VSCode with extension development
code --extensionDevelopmentPath=./vscode /path/to/repo
```

## Production Builds

To create optimized production builds:

```bash
# Build all components in production mode
yarn dev --production

# Or build individual components:
cd isl && yarn build          # Build web client
cd isl-server && yarn build   # Build server
cd vscode && yarn build-webview && yarn build-extension  # Build VSCode extension
```

## Testing

Run tests for the ISL client:

```bash
cd isl
yarn test
```

For server tests:

```bash
cd isl-server
yarn test
```

To hide verbose DOM errors from React Testing Library:

```bash
HIDE_RTL_DOM_ERRORS=1 yarn test
```

## Architecture Overview

### Client-Server Communication

ISL uses an embeddable Client/Server architecture:

- **Client**: Runs in browser/VSCode webview, renders UI with React + Jotai state management
- **Server**: Runs in Node.js, executes SCM commands, watches repository for changes
- **Protocol**: WebSocket connection for bidirectional communication
- **Security**: Token-based authentication to prevent unauthorized access

### Key Technologies

- **Frontend**: React 18, Jotai (state), StyleX (styling), Vite (build)
- **Backend**: Node.js, TypeScript, Rollup (bundling)
- **Repository Watching**: Watchman (if available) or polling fallback
- **VSCode**: Webview API for embedding in VS Code

### Development Features

- **Hot Reloading**: Client automatically refreshes on code changes
- **Source Maps**: Full debugging support with source maps
- **Optimistic UI**: Shows predicted state while commands execute
- **Operation Queuing**: Multiple operations can be queued and run sequentially

## Common Development Tasks

### Watching for Changes

All development commands include file watching:
- Client changes trigger hot reload (instant)
- Server changes require manual restart (press `R` in dev mode)

### Adding New Dependencies

Since this is a Yarn workspace, add dependencies to the specific package:

```bash
# Add to ISL client
cd isl && yarn add some-package

# Add to ISL server
cd isl-server && yarn add some-package

# Add to shared workspace
cd shared && yarn add some-package
```

### Linting and Formatting

```bash
# Lint all code
yarn eslint

# Format code with Prettier
yarn prettier-fix

# Check formatting
yarn prettier-check
```

## Troubleshooting

### Server Won't Start

If you get port conflicts:
```bash
# Use --force to kill existing servers
yarn serve --force --dev
```

### Client Build Errors

Clear node_modules and reinstall:
```bash
rm -rf node_modules */node_modules
yarn install
```

### VSCode Extension Not Loading

1. Make sure both webview and extension are built
2. Check that VSCode is using the extension development path
3. Reload the VSCode window (Cmd/Ctrl + R)

## Migration Notes

This project was extracted from the Sapling SCM repository. Key changes:
- Moved from `sapling/addons/*` to standalone `champagne/*` structure
- Maintained all workspace dependencies and build configurations
- Preserved the development workflow and scripts

## Next Steps

Future improvements for the Champagne project:
- [ ] Update branding from "ISL" and "Sapling" to "Champagne"
- [ ] Customize UI theme and styling
- [ ] Add project-specific documentation
- [ ] Set up CI/CD pipeline
- [ ] Publish VSCode extension independently
- [ ] Create standalone Electron/Tauri app

## Resources

- Original Sapling ISL Documentation: https://sapling-scm.com/docs/addons/isl
- React Documentation: https://react.dev
- Jotai State Management: https://jotai.org
- Vite Build Tool: https://vitejs.dev
