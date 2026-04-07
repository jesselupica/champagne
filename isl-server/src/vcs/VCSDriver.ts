/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import type {
  AbsolutePath,
  Alert,
  ChangedFile,
  CodeReviewSystem,
  CommitCloudSyncState,
  CommitInfo,
  CommandArg,
  FetchedCommits,
  FetchedUncommittedChanges,
  Hash,
  MergeConflicts,
  RepoInfo,
  RepoRelativePath,
  RunnableOperation,
  ShelvedChange,
  SubmodulesByRoot,
  ValidatedRepoInfo,
} from 'isl/src/types';
import type {Comparison} from 'shared/Comparison';
import type {EjecaOptions, EjecaReturn} from 'shared/ejeca';
import type {ExportStack, ImportStack} from 'shared/types/stack';
import type {RepositoryContext} from '../serverTypes';
import type {
  BlameInfo,
  ConfigScope,
  DiffStats,
  ExecParams,
  FetchCommitsOptions,
  ResolvedCommand,
  VCSCapabilities,
  WatchConfig,
} from './types';

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
   * Walks up the directory tree from `ctx.cwd` looking for VCS markers.
   * Returns undefined if not in a repository (does not throw).
   */
  findRoot(ctx: RepositoryContext): Promise<AbsolutePath | undefined>;

  /**
   * Find additional repository roots (e.g., nested repos, submodules).
   * Returns undefined if nested roots are not supported.
   */
  findRoots(ctx: RepositoryContext): Promise<AbsolutePath[] | undefined>;

  /**
   * Find the VCS metadata directory (.sl, .git, etc.).
   * Returns undefined if not in a repository.
   */
  findDotDir(ctx: RepositoryContext): Promise<AbsolutePath | undefined>;

  /**
   * Validate a repository and return its info.
   * Detects repo root, dotdir, code review system, and other metadata.
   * Returns error variants rather than throwing.
   */
  validateRepo(ctx: RepositoryContext): Promise<RepoInfo>;

  // ── Data Fetching ─────────────────────────────────────

  /**
   * Fetch the commit graph for the smartlog view.
   *
   * Must return commits including:
   * - The working directory parent (marked with isDot=true)
   * - All draft (local) commits within the date range
   * - Relevant public commits (branch points, bookmarks)
   * - Remote bookmarks and local bookmarks
   */
  fetchCommits(
    ctx: RepositoryContext,
    codeReviewSystem: CodeReviewSystem,
    options: FetchCommitsOptions,
  ): Promise<CommitInfo[]>;

  /**
   * Fetch the working directory status (uncommitted changes).
   * Returns all modified, added, removed, unknown, and missing files.
   */
  /**
   * Populate filePathsSample and totalFileCount on draft commits.
   * Called asynchronously after initial commit fetch to avoid blocking the UI.
   * Mutates the commits array in place; returns the same array.
   */
  populateCommitFileInfo?(ctx: RepositoryContext, commits: CommitInfo[]): Promise<CommitInfo[]>;

  fetchStatus(ctx: RepositoryContext): Promise<ChangedFile[]>;

  /**
   * Check for active merge conflicts.
   * Returns undefined if no merge/rebase is in progress.
   */
  checkMergeConflicts(
    ctx: RepositoryContext,
    previousConflicts: MergeConflicts | undefined,
  ): Promise<MergeConflicts | undefined>;

  /**
   * Fast check: are there signs a merge/rebase/cherry-pick might be in progress?
   * Used as a cheap gate before calling the more expensive checkMergeConflicts.
   */
  hasPotentialOperation(dotdir: string): Promise<boolean>;

  /**
   * Fetch details for specific commits by hash.
   * Used for blame, commit lookups, and on-demand fetching.
   */
  lookupCommits(
    ctx: RepositoryContext,
    codeReviewSystem: CodeReviewSystem,
    hashes: Hash[],
  ): Promise<CommitInfo[]>;

  /**
   * Get the contents of a file at a specific revision.
   * `revset` is "." for working directory parent, or a hash for a specific commit.
   */
  getFileContents(
    ctx: RepositoryContext,
    path: AbsolutePath,
    revset: string,
  ): Promise<string>;

  /**
   * Get line-by-line blame information for a file.
   * Returns an array of {lineContent, commit hash} tuples. Commit details
   * should be looked up separately via lookupCommits.
   */
  getBlame(
    ctx: RepositoryContext,
    filePath: string,
    hash: Hash,
  ): Promise<Array<{line: string; node: string}>>;

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
   * Returns undefined if the computation fails.
   */
  getDiffStats(
    ctx: RepositoryContext,
    hash: Hash,
    excludeFiles: string[],
  ): Promise<number | undefined>;

  /**
   * Get diff statistics for pending (uncommitted) changes.
   */
  getPendingDiffStats(
    ctx: RepositoryContext,
    includeFiles: string[],
  ): Promise<number | undefined>;

  /**
   * Get diff statistics for pending amend changes (diff against parent of .).
   */
  getPendingAmendDiffStats(
    ctx: RepositoryContext,
    includeFiles: string[],
  ): Promise<number | undefined>;

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
   */
  getConfigs<T extends string>(
    ctx: RepositoryContext,
    names: ReadonlyArray<T>,
  ): Promise<Map<T, string>>;

  /**
   * Write a configuration value at the specified scope.
   */
  setConfig(
    ctx: RepositoryContext,
    scope: ConfigScope,
    name: string,
    value: string,
  ): Promise<void>;

  // ── Command Execution ─────────────────────────────────

  /**
   * Run a raw VCS command with the given args.
   * This is the low-level execution method used by all other methods.
   */
  runCommand(
    ctx: RepositoryContext,
    args: string[],
    options?: EjecaOptions,
    timeout?: number,
  ): Promise<EjecaReturn>;

  /**
   * Convert abstract operation args into concrete CLI arguments.
   * Handles revset resolution, file path normalization, config args, etc.
   */
  normalizeOperationArgs(
    cwd: string,
    repoRoot: AbsolutePath,
    operation: RunnableOperation,
  ): ResolvedCommand;

  /**
   * Get environment variables and flags needed to run commands.
   */
  getExecParams(
    args: string[],
    cwd: string,
    options?: EjecaOptions,
    env?: Record<string, string>,
  ): {command: string; args: string[]; options: EjecaOptions};

  /**
   * Get the merge tool configuration.
   * Returns the name of the configured merge tool, or null for the default.
   */
  getMergeTool(ctx: RepositoryContext): Promise<string | null>;

  /**
   * Get environment variables to set when running merge tools.
   * Returns undefined to use the driver's default behavior, or
   * an object with env vars to set (empty object = use system merge tool).
   */
  getMergeToolEnvVars(ctx: RepositoryContext): Promise<Record<string, string> | undefined>;

  // ── File Watching ─────────────────────────────────────

  /**
   * Get the file watching configuration for this repository.
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
  ): Promise<string>;

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
   * Collect debugging information (e.g., `sl rage`).
   * Returns a paste/dump identifier string.
   */
  collectDebugInfo?(ctx: RepositoryContext): Promise<string>;

  /**
   * Get commit cloud sync state.
   * Only available if capabilities.commitCloud is true.
   */
  getCommitCloudState?(ctx: RepositoryContext): Promise<CommitCloudSyncState>;
}
