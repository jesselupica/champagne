# Champagne VCS Driver Specification

**Version**: 1.0
**Status**: Draft - Pending Approval
**Date**: 2026-02-21

## Table of Contents

1. [Overview](#overview)
2. [Architecture](#architecture)
3. [VCSDriver Interface](#vcsdriver-interface)
4. [Type Definitions](#type-definitions)
5. [Method Contracts](#method-contracts)
6. [Operations System](#operations-system)
7. [File Watching](#file-watching)
8. [Error Handling](#error-handling)
9. [Driver Detection](#driver-detection)
10. [Extension Points](#extension-points)

---

## Overview

### Purpose

The VCS Driver interface defines the contract between ISL's UI/server layer and the underlying version control system. By abstracting all VCS-specific logic behind this interface, Champagne can support multiple VCS backends (Sapling, Git, Graphite, Git Branchless) without modifying the UI or server coordination code.

### Design Principles

1. **Minimal surface area**: The interface captures only what the UI needs, not every VCS feature.
2. **Sapling as reference**: Sapling's capabilities define the maximum feature set. Other drivers implement what they can and declare what they cannot.
3. **No UI changes**: Drivers are server-side only. The client protocol remains unchanged.
4. **Capability-based**: Drivers declare which operations they support. The UI adapts accordingly.
5. **Streaming progress**: Operations must support real-time progress reporting.

### Scope

The driver interface covers:
- Repository detection and validation
- Commit graph fetching (smartlog)
- Working directory status
- Merge conflict detection and resolution
- Operation execution (commit, amend, rebase, etc.)
- Configuration read/write
- File content retrieval
- File watching configuration
- Code review system detection

The driver interface does **not** cover:
- UI rendering or state management
- Client-server message protocol
- Operation queuing and serialization (handled by `OperationQueue`)
- Optimistic UI state (handled by Operation classes on the client)

---

## Architecture

### Current Architecture (Sapling-coupled)

```
┌─────────────┐    WebSocket    ┌──────────────────────┐
│   Client     │ ◄────────────► │  ServerToClientAPI    │
│  (React UI)  │                │                      │
└─────────────┘                 │  ┌─────────────────┐ │
                                │  │  Repository.ts   │ │
                                │  │  (Sapling-       │ │
                                │  │   specific)      │ │
                                │  └────────┬────────┘ │
                                │           │          │
                                │  ┌────────▼────────┐ │
                                │  │  commands.ts     │ │
                                │  │  (runs `sl`)     │ │
                                │  └─────────────────┘ │
                                └──────────────────────┘
```

### Target Architecture (Driver-based)

```
┌─────────────┐    WebSocket    ┌──────────────────────────────┐
│   Client     │ ◄────────────► │  ServerToClientAPI            │
│  (React UI)  │                │                              │
└─────────────┘                 │  ┌────────────────────────┐  │
                                │  │  Repository.ts          │  │
                                │  │  (VCS-agnostic)         │  │
                                │  │                         │  │
                                │  │  driver: VCSDriver ─────┼──┼──► detectDriver()
                                │  └────────┬───────────────┘  │
                                │           │                  │
                                │  ┌────────▼────────┐         │
                                │  │  VCSDriver       │         │
                                │  │  interface        │         │
                                │  └────────┬────────┘         │
                                │           │                  │
                                │  ┌────────┴─────────────┐    │
                                │  │         │            │    │
                                │  ▼         ▼            ▼    │
                                │ Sapling   Git      Graphite  │
                                │ Driver    Driver    Driver   │
                                └──────────────────────────────┘
```

### Integration Points

The VCS driver plugs into the server at these points:

| Current Code | Change Required |
|---|---|
| `Repository.ts` constructor | Accept `VCSDriver` parameter |
| `Repository.fetchSmartlogCommits()` | Delegate to `driver.fetchCommits()` |
| `Repository.fetchUncommittedChanges()` | Delegate to `driver.fetchStatus()` |
| `Repository.checkForMergeConflicts()` | Delegate to `driver.checkMergeConflicts()` |
| `Repository.cat()` | Delegate to `driver.getFileContents()` |
| `Repository.blame()` | Delegate to `driver.getBlame()` |
| `Repository.runDiff()` | Delegate to `driver.getDiff()` |
| `Repository.runOperation()` | Use `driver.command` and `driver.getExecParams()` |
| `ServerToClientAPI.setActiveRepoForCwd()` | Call `detectDriver()` to select driver |
| `WatchForChanges` constructor | Use `driver.getWatchConfig()` |
| `commands.ts` `getExecParams()` | Use `driver.getExecParams()` |

---

## VCSDriver Interface

```typescript
/**
 * The core abstraction for version control system backends.
 *
 * Each driver implementation encapsulates all VCS-specific logic:
 * command execution, output parsing, file watching, and operation creation.
 *
 * The driver is instantiated once per detected repository and passed
 * to the Repository constructor.
 */
export interface VCSDriver {
  /** Human-readable name for this VCS (e.g., "Sapling", "Git") */
  readonly name: string;

  /** The CLI command to invoke (e.g., "sl", "git", "gt") */
  readonly command: string;

  /** Capabilities this driver supports */
  readonly capabilities: VCSCapabilities;

  // ── Repository Detection ──────────────────────────────

  /**
   * Find the repository root directory starting from a given path.
   * Walks up the directory tree looking for VCS markers (.sl, .git, etc.).
   */
  findRoot(ctx: RepositoryContext): Promise<AbsolutePath | undefined>;

  /**
   * Find additional repository roots (e.g., nested repos, submodules).
   * Returns the primary root if nested roots are not supported.
   */
  findRoots(ctx: RepositoryContext): Promise<AbsolutePath[]>;

  /**
   * Find the VCS metadata directory (.sl, .git, etc.).
   */
  findDotDir(ctx: RepositoryContext): Promise<AbsolutePath>;

  /**
   * Validate a repository and return its info.
   * This is the primary method for detecting what kind of repo we're in
   * and what code review system it uses.
   */
  validateRepo(ctx: RepositoryContext): Promise<RepoInfo>;

  // ── Data Fetching ─────────────────────────────────────

  /**
   * Fetch the commit graph for the smartlog view.
   *
   * Must return a DAG of commits including:
   * - All draft (local) commits
   * - The working directory parent (marked with isDot=true)
   * - Relevant public commits (branch points, bookmarks)
   * - Remote bookmarks and local bookmarks
   *
   * The `options` parameter controls which commits to include
   * (date range, stable locations, recommended bookmarks).
   */
  fetchCommits(
    ctx: RepositoryContext,
    options: FetchCommitsOptions,
  ): Promise<FetchedCommits>;

  /**
   * Fetch the working directory status (uncommitted changes).
   * Returns all modified, added, removed, unknown, and missing files.
   */
  fetchStatus(ctx: RepositoryContext): Promise<FetchedUncommittedChanges>;

  /**
   * Check for active merge conflicts.
   * Returns undefined if no merge/rebase is in progress.
   */
  checkMergeConflicts(ctx: RepositoryContext): Promise<MergeConflicts | undefined>;

  /**
   * Fetch details for specific commits by hash.
   * Used for blame, commit lookups, and on-demand fetching.
   */
  lookupCommits(
    ctx: RepositoryContext,
    hashes: Hash[],
  ): Promise<Map<Hash, CommitInfo>>;

  /**
   * Get the contents of a file at a specific revision.
   */
  getFileContents(
    ctx: RepositoryContext,
    path: RepoRelativePath,
    revset: string,
  ): Promise<string>;

  /**
   * Get line-by-line blame information for a file.
   */
  getBlame(
    ctx: RepositoryContext,
    path: RepoRelativePath,
    hash: Hash,
  ): Promise<BlameInfo[]>;

  /**
   * Generate a unified diff for a comparison.
   */
  getDiff(
    ctx: RepositoryContext,
    comparison: Comparison,
    contextLines?: number,
  ): Promise<string>;

  /**
   * Get all files changed in a specific commit.
   */
  getChangedFiles(
    ctx: RepositoryContext,
    hash: Hash,
  ): Promise<ChangedFile[]>;

  /**
   * Get shelved/stashed changes.
   * Returns empty array if shelving is not supported.
   */
  getShelvedChanges(ctx: RepositoryContext): Promise<ShelvedChange[]>;

  /**
   * Get diff statistics (lines added/removed) for a commit.
   */
  getDiffStats(
    ctx: RepositoryContext,
    hash: Hash,
    excludePatterns?: string[],
  ): Promise<DiffStats>;

  /**
   * Get diff statistics for pending (uncommitted) changes.
   */
  getPendingDiffStats(
    ctx: RepositoryContext,
    includePatterns?: string[],
  ): Promise<DiffStats>;

  // ── Configuration ─────────────────────────────────────

  /**
   * Read a configuration value.
   * Returns undefined if the config key doesn't exist.
   */
  getConfig(
    ctx: RepositoryContext,
    name: string,
  ): Promise<string | undefined>;

  /**
   * Read multiple configuration values in a single call.
   * More efficient than calling getConfig() repeatedly.
   */
  getConfigs(
    ctx: RepositoryContext,
    names: string[],
  ): Promise<Map<string, string | undefined>>;

  /**
   * Write a configuration value at the specified scope.
   */
  setConfig(
    ctx: RepositoryContext,
    name: string,
    value: string,
    scope: ConfigScope,
  ): Promise<void>;

  // ── Operations ────────────────────────────────────────

  /**
   * Convert a RunnableOperation into executable command arguments.
   *
   * The server passes the operation's abstract args (which may contain
   * revsets, file paths, config overrides) and the driver converts them
   * to concrete CLI arguments for its VCS command.
   *
   * Returns the resolved command line and any environment variables needed.
   */
  resolveOperationArgs(
    ctx: RepositoryContext,
    args: CommandArg[],
    options?: OperationExecOptions,
  ): ResolvedCommand;

  /**
   * Get environment variables needed to run commands.
   * Includes VCS-specific env vars (e.g., SL_AUTOMATION for Sapling,
   * GIT_TERMINAL_PROMPT=0 for Git).
   */
  getExecParams(ctx: RepositoryContext): ExecParams;

  /**
   * Get the merge tool configuration.
   * Returns the name of the configured merge tool, or null for the default.
   */
  getMergeTool(ctx: RepositoryContext): Promise<string | null>;

  /**
   * Get environment variables to set when running merge tools.
   */
  getMergeToolEnvVars(): Record<string, string>;

  // ── File Watching ─────────────────────────────────────

  /**
   * Get the file watching configuration for this repository.
   * Defines which directories/files to watch and which Watchman
   * subscriptions to create.
   */
  getWatchConfig(repoInfo: ValidatedRepoInfo): WatchConfig;

  // ── Optional / Capability-Gated Methods ───────────────

  /**
   * Export a stack of commits in a structured format.
   * Only available if capabilities.stackOperations is true.
   */
  exportStack?(
    ctx: RepositoryContext,
    revs: string,
    assumeTracked?: string[],
  ): Promise<ExportStack>;

  /**
   * Import a stack of commits from a structured format.
   * Only available if capabilities.stackOperations is true.
   */
  importStack?(
    ctx: RepositoryContext,
    stack: ImportStack,
  ): Promise<void>;

  /**
   * Get commit cloud sync state.
   * Only available if capabilities.commitCloud is true.
   */
  getCommitCloudState?(ctx: RepositoryContext): Promise<CommitCloudSyncState>;

  /**
   * Fetch submodule information.
   * Only available if capabilities.submodules is true.
   */
  fetchSubmodules?(
    ctx: RepositoryContext,
    repoRoots: AbsolutePath[],
  ): Promise<SubmodulesByRoot>;

  /**
   * Get active system/repo alerts.
   * Only available if capabilities.alerts is true.
   */
  getActiveAlerts?(ctx: RepositoryContext): Promise<Alert[]>;

  /**
   * Collect debugging information.
   * Returns a paste/dump identifier.
   */
  collectDebugInfo?(ctx: RepositoryContext): Promise<string>;
}
```

---

## Type Definitions

### Repository Context

```typescript
/**
 * Execution context passed to all driver methods.
 * Provides the working directory, logging, and tracking facilities.
 */
export interface RepositoryContext {
  /** Absolute path to the working directory */
  cwd: AbsolutePath;

  /** The VCS command to execute (typically set by the driver itself) */
  cmd: string;

  /** Logger for debug/info/error messages */
  logger: Logger;

  /** Analytics tracker */
  tracker: ServerSideTracker;

  /** Cached config values (populated by getConfigs) */
  knownConfigs?: ReadonlyMap<string, string | undefined>;
}
```

### Capabilities

```typescript
/**
 * Declares which features a VCS driver supports.
 * The UI uses this to show/hide features and adjust behavior.
 */
export interface VCSCapabilities {
  /** Supports `sl log`-style smartlog with revsets */
  smartlog: boolean;

  /** Supports commit phases (public/draft) */
  commitPhases: boolean;

  /** Supports bookmarks (local and remote) */
  bookmarks: boolean;

  /** Supports commit amend (modifying the current commit) */
  amend: boolean;

  /** Supports interactive/partial commit (chunk selection) */
  partialCommit: boolean;

  /** Supports interactive/partial amend */
  partialAmend: boolean;

  /** Supports rebase operations */
  rebase: boolean;

  /** Supports fold (squash multiple commits) */
  fold: boolean;

  /** Supports hide (obsolete commits) */
  hide: boolean;

  /** Supports shelve/stash */
  shelve: boolean;

  /** Supports graft (cherry-pick) */
  graft: boolean;

  /** Supports goto (checkout by revset) */
  goto: boolean;

  /** Supports stack-based operations (debugimportstack/debugexportstack) */
  stackOperations: boolean;

  /** Supports commit cloud sync */
  commitCloud: boolean;

  /** Supports submodule detection */
  submodules: boolean;

  /** Supports system alerts */
  alerts: boolean;

  /** Supports `sl rage`-style debug collection */
  debugInfo: boolean;

  /** Supports successor/predecessor commit tracking (mutation history) */
  mutationTracking: boolean;

  /** Supports push to named remote branches */
  push: boolean;

  /** Supports pull with specific revisions */
  pullRevision: boolean;

  /** List of supported code review submit commands */
  submitCommands: SubmitCommandConfig[];
}

export interface SubmitCommandConfig {
  name: string;
  command: string[];
  supportsDraft: boolean;
  supportsUpdateMessage: boolean;
}
```

### Fetch Options

```typescript
export interface FetchCommitsOptions {
  /**
   * Number of days of draft commits to include.
   * Commits older than this are excluded unless they match other criteria.
   */
  maxDraftDays: number;

  /**
   * Stable commit locations to always include (e.g., pinned commits).
   * These are hashes that should always appear in the smartlog.
   */
  stableLocations: Hash[];

  /**
   * Bookmark names to always include in the smartlog.
   */
  recommendedBookmarks: string[];

  /**
   * Additional revset expression to include.
   * Driver-specific; may be ignored by drivers that don't support revsets.
   */
  additionalRevset?: string;
}
```

### Fetched Data Types

```typescript
/** Wrapper for fetched commit data with timestamps */
export interface FetchedCommits {
  commits: Result<CommitInfo[]>;
  fetchStartTimestamp: number;
  fetchCompletedTimestamp: number;
}

/** Wrapper for fetched status data with timestamps */
export interface FetchedUncommittedChanges {
  files: Result<UncommittedChanges>;
  fetchStartTimestamp: number;
  fetchCompletedTimestamp: number;
}

/** Blame information for a single line */
export interface BlameInfo {
  lineContent: string;
  commit: CommitInfo | undefined;
}

/** Diff statistics */
export interface DiffStats {
  linesAdded: number;
  linesRemoved: number;
}
```

### Resolved Command

```typescript
/**
 * The result of resolving abstract operation args into concrete CLI arguments.
 */
export interface ResolvedCommand {
  /** The CLI command to run (e.g., "sl", "git") */
  command: string;

  /** Resolved command-line arguments */
  args: string[];

  /** Data to pass via stdin, if any */
  stdin?: string;

  /** Environment variables to set */
  env?: Record<string, string>;

  /** Files passed via a temporary file list (for large file sets) */
  fileListPath?: string;
}

export interface ExecParams {
  /** Environment variables for all commands */
  env: Record<string, string>;

  /** Global flags added to every command (e.g., --noninteractive) */
  globalFlags: string[];
}

export interface OperationExecOptions {
  /** Whether to add debug/verbose flags */
  debug?: boolean;
  verbose?: boolean;
}
```

### Watch Configuration

```typescript
/**
 * Configuration for file watching in a repository.
 */
export interface WatchConfig {
  /**
   * Watchman defer patterns. Commands matching these patterns
   * cause Watchman to defer notifications until they complete.
   * Example: ["hg.update", "hg.transaction"] for Sapling.
   */
  watchmanDefers: string[];

  /**
   * Files within the dotdir to watch for dirstate changes.
   * Changes to these files trigger uncommitted changes refresh.
   * Example: ["bookmarks.current", "bookmarks", "dirstate", "merge"]
   */
  dirstateFiles: string[];

  /**
   * Subscription name prefix for Watchman subscriptions.
   * Used to avoid conflicts between different VCS watchers.
   */
  subscriptionPrefix: string;

  /**
   * Glob patterns for files that indicate commit graph changes.
   * Watched relative to the repository root.
   * Example: ["**/*.py", "**/*.ts"] would be too broad;
   * typically watches VCS metadata files.
   */
  commitChangeGlobs?: string[];

  /**
   * Whether this VCS supports EdenFS-specific watching.
   */
  supportsEdenFs: boolean;

  /**
   * Additional directories to watch (relative to dotdir).
   * Example: ["store/journal"] for Sapling.
   */
  additionalWatchDirs: string[];
}
```

### Config Scope

```typescript
export type ConfigScope = 'user' | 'local' | 'global';
```

### Existing Types (Unchanged)

The following types from the existing codebase are used as-is by the driver interface. They are not redefined here:

- **`CommitInfo`** - Commit metadata (hash, author, date, message, bookmarks, etc.)
- **`ChangedFile`** / **`ChangedFileStatus`** - File change information
- **`UncommittedChanges`** - Array of changed files
- **`MergeConflicts`** - Merge conflict state and file list
- **`ShelvedChange`** - Shelved change metadata
- **`CommandArg`** - Abstract command argument (string, revset, file path, config)
- **`ExportStack`** / **`ImportStack`** - Stack operation formats
- **`Comparison`** - Diff comparison specification
- **`RepoInfo`** / **`ValidatedRepoInfo`** - Repository validation result
- **`Hash`**, **`AbsolutePath`**, **`RepoRelativePath`** - Path/hash aliases
- **`Result<T>`** - Success/error wrapper

---

## Method Contracts

### Repository Detection

#### `findRoot(ctx)`

| Aspect | Contract |
|---|---|
| **Behavior** | Walk up directory tree from `ctx.cwd` looking for VCS markers |
| **Sapling** | Looks for `.sl` directory |
| **Git** | Looks for `.git` directory (or `.git` file for worktrees) |
| **Return** | Absolute path to repo root, or `undefined` if not in a repo |
| **Errors** | Should not throw; returns `undefined` on failure |

#### `validateRepo(ctx)`

| Aspect | Contract |
|---|---|
| **Behavior** | Full repo validation: find root, dotdir, detect code review system |
| **Must detect** | Repo root, dotdir path, code review system, pull request domain |
| **Return** | `RepoInfo` (success with `ValidatedRepoInfo`, or error variant) |
| **Errors** | Returns error variants, does not throw |

### Data Fetching

#### `fetchCommits(ctx, options)`

| Aspect | Contract |
|---|---|
| **Behavior** | Fetch commit DAG for smartlog display |
| **Must include** | Working directory parent (`isDot: true`), all draft commits within date range, bookmark targets |
| **Commit fields** | All fields of `CommitInfo` must be populated |
| **Ordering** | Commits should be in topological order (parents before children) |
| **Performance** | Should complete within 5 seconds for typical repos (<1000 draft commits) |
| **Sapling** | `sl log --template ... --rev smartlog(...)` |
| **Git** | `git log --all --format=... --graph` filtered to relevant branches |

#### `fetchStatus(ctx)`

| Aspect | Contract |
|---|---|
| **Behavior** | Get all uncommitted changes in the working directory |
| **Must include** | Modified (M), Added (A), Removed (R), Unknown (?), Missing (!) files |
| **Copy tracking** | Must populate `copy` field for renamed/copied files if VCS tracks copies |
| **Sapling** | `sl status -Tjson --copies` |
| **Git** | `git status --porcelain=v2` |

#### `checkMergeConflicts(ctx)`

| Aspect | Contract |
|---|---|
| **Behavior** | Check if a merge/rebase is in progress with unresolved conflicts |
| **Return** | `MergeConflicts` with state "loaded" if conflicts exist, `undefined` if no merge in progress |
| **Must include** | File list with conflict types, command that caused conflict, commands to continue/abort |
| **Sapling** | `sl resolve --tool internal:dumpjson --all` |
| **Git** | Parse `.git/MERGE_MSG`, check `git status` for unmerged paths |

#### `getFileContents(ctx, path, revset)`

| Aspect | Contract |
|---|---|
| **Behavior** | Return file contents at a specific revision |
| **revset** | "." for working directory parent, a hash for specific commit |
| **Return** | File contents as UTF-8 string |
| **Errors** | Throw if file doesn't exist at that revision |
| **Sapling** | `sl cat <path> --rev <revset>` |
| **Git** | `git show <rev>:<path>` |

### Operations

#### `resolveOperationArgs(ctx, args, options?)`

| Aspect | Contract |
|---|---|
| **Behavior** | Convert abstract `CommandArg[]` into concrete CLI arguments |
| **Must handle** | String args, `repo-relative-file` paths, `config` overrides, all revset types |
| **SucceedableRevset** | Resolve to latest successor if mutation tracking is supported; otherwise use as-is |
| **ExactRevset** | Use the revset string directly, no rewriting |
| **OptimisticRevset** | Use the `.revset` field (the real revset), ignore `.fake` |
| **File lists** | For large file sets, write to temp file and use `--filelist` or equivalent |
| **Config args** | Convert to `--config key=value` flags (Sapling) or equivalent |
| **Global flags** | Prepend flags from `getExecParams().globalFlags` |

### Configuration

#### `getConfig(ctx, name)` / `setConfig(ctx, name, value, scope)`

| Aspect | Contract |
|---|---|
| **Behavior** | Read/write VCS configuration values |
| **Sapling** | `sl config <name>` / `sl config --<scope> <name> <value>` |
| **Git** | `git config <name>` / `git config --<scope> <name> <value>` |
| **Config mapping** | Drivers must map ISL config names to their VCS equivalents. ISL uses Sapling-style dotted names (e.g., `ui.merge`). Git drivers map these to Git config equivalents. |
| **Unknown configs** | Return `undefined` for unknown config names, do not throw |

---

## Operations System

### How Operations Work

Operations are defined on the **client side** as `Operation` subclasses. Each operation produces a `RunnableOperation` containing abstract `CommandArg[]`. The server passes these args to the driver's `resolveOperationArgs()` method to get concrete CLI arguments.

```
Client                         Server                        VCS Driver
  │                              │                              │
  │  RunOperation(args)          │                              │
  │─────────────────────────────►│                              │
  │                              │  resolveOperationArgs(args)  │
  │                              │─────────────────────────────►│
  │                              │  ResolvedCommand             │
  │                              │◄─────────────────────────────│
  │                              │                              │
  │                              │  spawn(command, resolvedArgs) │
  │                              │─────────────────────────────►│
  │  OperationProgress(stdout)   │                              │
  │◄─────────────────────────────│  stdout/stderr stream        │
  │  OperationProgress(exit)     │◄─────────────────────────────│
  │◄─────────────────────────────│                              │
```

### Operation Categories and Driver Mapping

The following table maps each client-side Operation to the VCS commands each driver must execute. Operations not listed in a driver's capabilities will be hidden from the UI.

#### Universal Operations (All Drivers)

| Operation | Sapling | Git | Graphite |
|---|---|---|---|
| CommitOperation | `sl commit --addremove -m <msg>` | `git add <files> && git commit -m <msg>` | `gt create -m <msg>` |
| AmendOperation | `sl amend --addremove` | `git commit --amend` | `gt amend` |
| AmendMessageOperation | `sl metaedit --rev <rev> -m <msg>` | `git commit --amend -m <msg>` (HEAD only) | `gt amend -m <msg>` |
| GotoOperation | `sl goto --rev <rev>` | `git checkout <ref>` | `gt checkout <branch>` |
| PullOperation | `sl pull` | `git fetch --all` | `gt sync` |
| RevertOperation | `sl revert <files>` | `git checkout -- <files>` | `git checkout -- <files>` |
| DiscardOperation | `sl goto --clean .` | `git checkout -- . && git clean -fd` | `git checkout -- .` |
| AddOperation | `sl add <file>` | `git add <file>` | `git add <file>` |
| ForgetOperation | `sl forget <file>` | `git rm --cached <file>` | `git rm --cached <file>` |
| RmOperation | `sl rm <file>` | `git rm <file>` | `git rm <file>` |
| ResolveOperation | `sl resolve --mark <file>` | `git add <file>` (mark resolved) | `git add <file>` |

#### Rebase/History Operations

| Operation | Sapling | Git | Graphite |
|---|---|---|---|
| RebaseOperation | `sl rebase -s <src> -d <dest>` | `git rebase --onto <dest> <src>^` | `gt restack` |
| FoldOperation | `sl fold --exact <range> -m <msg>` | `git reset --soft <base> && git commit -m <msg>` | N/A |
| HideOperation | `sl hide --rev <rev>` | `git branch -D <branch>` (if branch) | N/A |
| GraftOperation | `sl graft <src>` | `git cherry-pick <src>` | N/A |
| UncommitOperation | `sl uncommit` | `git reset --soft HEAD~1` | N/A |

#### Shelve/Stash Operations

| Operation | Sapling | Git | Graphite |
|---|---|---|---|
| ShelveOperation | `sl shelve --unknown` | `git stash push` | `git stash push` |
| UnshelveOperation | `sl unshelve --name <name>` | `git stash pop` or `git stash apply` | `git stash pop` |
| DeleteShelveOperation | `sl shelve --delete <name>` | `git stash drop <ref>` | `git stash drop` |

#### Bookmark/Branch Operations

| Operation | Sapling | Git | Graphite |
|---|---|---|---|
| BookmarkCreateOperation | `sl bookmark <name> --rev <rev>` | `git branch <name> <ref>` | N/A (uses stacks) |
| BookmarkDeleteOperation | `sl bookmark --delete <name>` | `git branch -d <name>` | N/A |

#### Remote Operations

| Operation | Sapling | Git | Graphite |
|---|---|---|---|
| PushOperation | `sl push --rev <rev> --to <branch>` | `git push <remote> <branch>` | `gt submit` |
| PrSubmitOperation | `sl pr submit` | N/A (use Git push) | `gt submit` |

#### Merge Conflict Operations

| Operation | Sapling | Git | Graphite |
|---|---|---|---|
| ContinueOperation | `sl continue` | `git rebase --continue` or `git merge --continue` | `gt continue` |
| AbortMergeOperation | `sl rebase --abort` | `git rebase --abort` or `git merge --abort` | `gt abort` |

---

## File Watching

### Overview

Each driver provides a `WatchConfig` that tells the file watcher what to monitor. The watcher uses Watchman (if available) or falls back to polling.

### Driver-Specific Watch Configurations

#### Sapling

```typescript
{
  watchmanDefers: ['hg.update', 'hg.transaction'],
  dirstateFiles: ['bookmarks.current', 'bookmarks', 'dirstate', 'merge'],
  subscriptionPrefix: 'sapling-smartlog',
  supportsEdenFs: true,
  additionalWatchDirs: ['store/journal'],
}
```

#### Git

```typescript
{
  watchmanDefers: [],
  dirstateFiles: ['HEAD', 'index', 'MERGE_HEAD', 'REBASE_APPLY', 'REBASE_MERGE'],
  subscriptionPrefix: 'champagne-git',
  supportsEdenFs: false,
  additionalWatchDirs: ['refs/heads', 'refs/remotes'],
}
```

#### Graphite

```typescript
{
  // Same as Git, but also watch for Graphite metadata
  watchmanDefers: [],
  dirstateFiles: ['HEAD', 'index', 'MERGE_HEAD', 'REBASE_APPLY', 'REBASE_MERGE'],
  subscriptionPrefix: 'champagne-graphite',
  supportsEdenFs: false,
  additionalWatchDirs: ['refs/heads', 'refs/remotes'],
}
```

---

## Error Handling

### Error Categories

```typescript
export type VCSDriverError =
  | { type: 'command-not-found'; command: string }
  | { type: 'not-a-repository'; cwd: string }
  | { type: 'command-failed'; exitCode: number; stderr: string }
  | { type: 'parse-error'; message: string; rawOutput: string }
  | { type: 'unsupported-operation'; operation: string; driver: string }
  | { type: 'timeout'; command: string; timeoutMs: number }
  | { type: 'concurrent-modification'; message: string };
```

### Error Handling Contracts

1. **Detection errors**: `findRoot()` returns `undefined`, `validateRepo()` returns error variant. Never throw.
2. **Command failures**: Wrap in `Result<T>` with error field. The server handles display.
3. **Parse errors**: Log warning and return best-effort result. Don't crash on unexpected output.
4. **Unsupported operations**: Check `capabilities` before calling optional methods. If called anyway, throw `VCSDriverError` with type `unsupported-operation`.
5. **Timeouts**: Commands have default timeouts. Long operations (pull, push) get extended timeouts.
6. **Transient errors**: Operations may be retried by the server. Drivers should not implement their own retry logic.

### Graceful Degradation

When a driver doesn't support an operation:
1. The `capabilities` object declares it as `false`
2. The server does not send that operation type to the client
3. The client hides the corresponding UI element
4. If a client somehow sends an unsupported operation, the server returns an error message

---

## Driver Detection

### Detection Algorithm

```typescript
async function detectDriver(ctx: RepositoryContext): Promise<VCSDriver> {
  // 1. Check for Sapling repository
  if (await pathExists(path.join(ctx.cwd, '.sl'))) {
    return new SaplingDriver(ctx);
  }

  // 2. Check for Git repository (may be Git, Graphite, or Git Branchless)
  const gitDir = await findGitDir(ctx.cwd);
  if (gitDir) {
    return detectGitVariant(ctx, gitDir);
  }

  // 3. No supported VCS found
  throw new VCSDriverError({
    type: 'not-a-repository',
    cwd: ctx.cwd,
  });
}

async function detectGitVariant(
  ctx: RepositoryContext,
  gitDir: string,
): Promise<VCSDriver> {
  // Check for Graphite (has .graphite directory or gt command available)
  if (await isGraphiteRepo(ctx.cwd)) {
    return new GraphiteDriver(ctx);
  }

  // Check for Git Branchless (has git-branchless extension)
  if (await isGitBranchlessRepo(ctx.cwd)) {
    return new GitBranchlessDriver(ctx);
  }

  // Default to raw Git
  return new GitDriver(ctx);
}
```

### Detection Precedence

1. **Sapling** (.sl directory present) - always takes priority
2. **Graphite** (.git present AND Graphite metadata/CLI detected)
3. **Git Branchless** (.git present AND git-branchless extension detected)
4. **Git** (.git present, no extensions detected)

### Manual Override

Users can force a specific driver via server configuration:

```
--vcs-driver sapling|git|graphite|git-branchless
```

This bypasses auto-detection and uses the specified driver.

---

## Extension Points

### Adding a New Driver

To add support for a new VCS:

1. Create `isl-server/src/vcs/NewVcsDriver.ts` implementing `VCSDriver`
2. Set `capabilities` to reflect what the VCS supports
3. Implement all required methods
4. Add detection logic to `detectDriver()`
5. Add tests covering all implemented methods

### Config Name Mapping

Drivers may need to map ISL config names to their VCS equivalents:

```typescript
// Example: Git driver config mapping
const CONFIG_MAP: Record<string, string> = {
  'ui.merge': 'merge.tool',
  'isl.submitAsDraft': 'champagne.submitAsDraft',
  'amend.autorestack': 'champagne.autorestack',
};
```

Drivers should store ISL-specific configs under a `champagne.*` namespace in the VCS config system.

### Custom Operations

Drivers can add VCS-specific operations not in the base set by:

1. Defining new `Operation` subclasses on the client
2. Setting `runner` to a custom `CommandRunner` value
3. Handling the custom runner in the driver's `resolveOperationArgs()`

### Template System

The Sapling driver uses template strings for output parsing. Other drivers parse their own output formats. The driver interface does not prescribe an output format - only the return types.

---

## Appendix: File Locations

### Files to Create

| File | Purpose |
|---|---|
| `isl-server/src/vcs/VCSDriver.ts` | Interface definition and types |
| `isl-server/src/vcs/types.ts` | Shared types (capabilities, config, watch) |
| `isl-server/src/vcs/SaplingDriver.ts` | Sapling implementation |
| `isl-server/src/vcs/GitDriver.ts` | Git implementation |
| `isl-server/src/vcs/GraphiteDriver.ts` | Graphite implementation |
| `isl-server/src/vcs/GitBranchlessDriver.ts` | Git Branchless implementation |
| `isl-server/src/vcs/detectDriver.ts` | Auto-detection logic |

### Files to Modify

| File | Change |
|---|---|
| `isl-server/src/Repository.ts` | Accept `VCSDriver`, delegate VCS calls |
| `isl-server/src/RepositoryCache.ts` | Pass driver to Repository |
| `isl-server/src/ServerToClientAPI.ts` | Call `detectDriver()` on connection |
| `isl-server/src/commands.ts` | Use driver's `getExecParams()` |
| `isl-server/src/WatchForChanges.ts` | Use driver's `getWatchConfig()` |
