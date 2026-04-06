# Champagne

A universal, graphical source control GUI for Git, Sapling, Graphite, and more.

## Quick Start

```bash
# Install dependencies
yarn install

# Run web app in development mode
yarn dev browser --launch .

# Run VSCode extension in development mode
yarn dev vscode --launch .
```

## Documentation

See [claude.md](./claude.md) for comprehensive documentation including:
- Project structure and architecture
- Installation instructions
- Development workflow
- Testing guidelines
- Troubleshooting tips

## What's Included

- **Web App**: React-based UI for source control visualization
- **Server**: Node.js backend for repository operations
- **VSCode Extension**: Full IDE integration
- **Shared Libraries**: Reusable components and utilities

## License

MIT License - See [LICENSE](./LICENSE) file for details.

## Original Project

This project is based on Interactive Smartlog (ISL) from [Sapling SCM](https://sapling-scm.com/),
refactored to support multiple version control systems through a pluggable driver architecture.
