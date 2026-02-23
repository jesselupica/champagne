/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import type {
  AbsolutePath,
  CommitInfo,
  Hash,
  RepoRelativePath,
  StableInfo,
} from 'isl/src/types';

/**
 * Declares which features a VCS driver supports.
 * The UI and server use this to show/hide features and adjust behavior.
 */
export interface VCSCapabilities {
  /** Supports revset-based smartlog queries */
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

/**
 * Options controlling which commits to include in the smartlog fetch.
 */
export interface FetchCommitsOptions {
  /**
   * Number of days of draft commits to include.
   * `undefined` means no date restriction (show all).
   */
  maxDraftDays: number | undefined;

  /**
   * Stable commit locations to always include (e.g., pinned commits).
   */
  stableLocations: Array<StableInfo>;

  /**
   * Bookmark names to always include in the smartlog.
   */
  recommendedBookmarks: string[];

  /**
   * Additional revset fragments to include (driver-specific).
   */
  additionalRevsetFragments?: string[];
}

/** Blame information for a single line. */
export interface BlameInfo {
  lineContent: string;
  commit: CommitInfo | undefined;
}

/** Diff statistics (lines added/removed). */
export interface DiffStats {
  linesAdded: number;
  linesRemoved: number;
}

/**
 * The result of resolving abstract operation args into concrete CLI arguments.
 */
export interface ResolvedCommand {
  /** Resolved command-line arguments */
  args: string[];

  /** Data to pass via stdin, if any */
  stdin?: string;

  /** Additional environment variables for this command */
  env?: Record<string, string>;
}

/**
 * Environment and global flags for command execution.
 */
export interface ExecParams {
  /** Environment variables for all commands */
  env: Record<string, string>;

  /** Global flags added to every command (e.g., --noninteractive) */
  globalFlags: string[];
}

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
   * Whether this VCS supports EdenFS-specific watching.
   */
  supportsEdenFs: boolean;

  /**
   * Additional directories to watch (relative to dotdir).
   * Example: ["store/journal"] for Sapling.
   */
  additionalWatchDirs: string[];
}

export type ConfigScope = 'user' | 'local' | 'system';

/**
 * Absolute path to a file within the repo, to be resolved relative to repo root.
 */
export type RepoFile = {
  type: 'repo-relative-file';
  path: RepoRelativePath;
};

/**
 * Helper to compute the longest common path prefix for changed files.
 * Re-exported for use outside the driver.
 */
export function absolutePathForFileInRepo(
  file: string,
  repoRoot: AbsolutePath,
): AbsolutePath {
  const path_ = require('node:path');
  return path_.join(repoRoot, file);
}
