/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

/*
 * This file is synced between fbcode/eden/addons/vscode/extension/api/types.ts and xplat/vscode.
 * The authoritative copy is the one in addons/.
 * Use `yarn sync-api` from addons/ to perform the sync.
 *
 * This file is intended to be self contained so it may be copied/referenced from other extensions,
 * which is why it should not import anything except vscode and why it reimplements many types.
 */

import type * as vscode from 'vscode';

/**
 * This API is exported from the champagne-scm vscode extension.
 * It allows other vscode extensions to interact with Champagne.
 *
 * Usage:
 * ```
 * const api = await vscode.extensions.getExtension('jesselupica.champagne-scm')?.activate();
 * const repo = api?.getRepositoryForPath(cwd);
 * const currentCommit = repo?.getDotCommit();
 * const currentChanges = repo?.getUncommittedChanges();
 * ```
 */
export interface ChampagneExtensionApi {
  version: '1';

  getActiveRepositories(): ChampagneRepository[];
  onDidChangeActiveRepositories(
    callback: (repositories: ChampagneRepository[]) => void,
  ): vscode.Disposable;

  getRepositoryForPath(path: string): ChampagneRepository | undefined;
}

export type ChampagneRepositoryInfo = {
  type: 'success';
  repoRoot: string;
  codeReviewSystem:
    | {
        type: 'github';
        owner: string;
        repo: string;
        /** github enterprise may use a different hostname than 'github.com' */
        hostname: string;
      }
    | {
        type: 'phabricator';
        repo: string;
        callsign?: string;
      }
    | {
        type: 'none';
      }
    | {
        type: 'unknown';
        path?: string;
      };
};

export interface ChampagneRepository {
  info: ChampagneRepositoryInfo;

  /**
   * Run a VCS command in this repo.
   * `runVcsCommand(['status'])` is equivalent to running `sl status` in the terminal.
   *
   * Generally, this should be used for read-only non-mutating commands (status, log, blame, ...),
   * and not mutating operations (pull, commit, rebase, ...),
   * in order to get queueing support and to show progress in the UI.
   */
  runVcsCommand(args: Array<string>): Promise<ChampagneCommandOutput>;

  /**
   * Get the current commit ('.' revset) for this repo. This is cached from the last time it was requested.
   *
   */
  getDotCommit(): ChampagneCommitInfo | undefined;
  /**
   * Subscribe to changes to the current commit ('.' revset) for this repo.
   */
  onChangeDotCommit(callback: (commit: ChampagneCommitInfo | undefined) => void): vscode.Disposable;

  getUncommittedChanges(): ReadonlyArray<ChampagneChangedFile>;
  onChangeUncommittedChanges(
    callback: (changes: ReadonlyArray<ChampagneChangedFile>) => void,
  ): vscode.Disposable;

  /**
   * Get the current stack of commits.
   *
   * Ordered from newest to oldest, with the current commit at the front.
   */
  getCurrentStack(): Promise<ReadonlyArray<ChampagneCommitInfo>>;

  /**
   * Get all commits in the focused branch using focusedbranch(.) revset.
   * Returns all commits that are part of the current focused branch.
   *
   * Ordered from newest to oldest, with the current commit at the front.
   */
  getFullFocusedBranch?(): Promise<ReadonlyArray<ChampagneCommitInfo>>;

  /**
   *
   * Get the diff for the specified commit. If not provided, get the diff for the current commit.
   * @deprecated prefer `diff({type: 'Commit', hash: '...'})`
   */
  getDiff(commit?: string): Promise<string>;

  diff(comparison: ChampagneComparison, options?: {excludeGenerated?: boolean}): Promise<string>;

  /** Filter a list of repo-relative paths to only include generated (fully or partially) files. */
  getGeneratedPaths(paths: Array<string>): Promise<Array<string>>;

  /**
   * Commit uncommitted changes with the provided title and commit message.
   */
  commit(title: string, commitMessage: string): Promise<void>;

  /**
   * Get additional context around the source of a merge conflict.
   */
  getMergeConflictContext(): Promise<ChampagneConflictContext[]>;

  /**
   * Get diff info about the current commit.
   */
  getCurrentCommitDiff(): Promise<ChampagneCurrentCommitDiff>;

  // TODO: refresh
  // TODO: moveFile / copyFile
  // TODO: run operations (commit, amend, discard, purge, rebase, pull, ...)
  // TODO: get latest commit message from code review provider
}

type RepoRelativePath = string;
export type ChampagneCommitInfo = {
  title: string;
  hash: string;
  author: string;
  date: Date;
  /**
   * This matches the "parents" information from source control without the
   * "null" hash. Most of the time a commit has 1 parent. For merges there
   * could be 2 or more parents. The initial commit (and initial commits of
   * other merged-in repos) have no parents.
   */
  parents: ReadonlyArray<string>;
  phase: 'public' | 'draft';
  /**
   * Whether this commit is the "." (working directory parent).
   * It is the parent of "wdir()" or the "You are here" virtual commit.
   */
  isDot: boolean;
  /** Simple string commit message. Use parsed commit messages to find specific fields. */
  description: string;
  bookmarks: ReadonlyArray<string>;
  remoteBookmarks: ReadonlyArray<string>;
  /** First few file paths changed in this commit (it's a subset for performance). Empty for public commits. */
  filePathsSample: ReadonlyArray<RepoRelativePath>;
  /** Total number of changed files in this commit. */
  totalFileCount: number;
  /** Diff number or pull request number for this commit, if applicable. */
  diffId?: string;
};

export type ChampagneChangedFile = {
  path: RepoRelativePath;
  status: 'A' | 'M' | 'R' | '?' | '!' | 'U' | 'Resolved';
  /**
   * If this file is copied from another, this is the path of the original file
   * If this file is renamed from another, this is the path of the original file, and another change of type 'R' will exist.
   * */
  copy?: RepoRelativePath;
};

export type ChampagneCommandOutput = {
  stdout: string;
  stderr: string;
  exitCode: number;
  killed?: boolean;
};

export type ChampagneComparison =
  | {
      type: 'Commit';
      hash: string;
    }
  | {
      type: 'Uncommitted' | 'Head' | 'Stack';
    };

export type ChampagneCurrentCommitDiff = {
  message: string;
  files: ReadonlyArray<DiffFile>;
};

/** Unified diff represent in a JSON-friendly format. */
export type DiffFile = {
  /** File path on the left side (previous version). */
  aPath: RepoPath;
  /** File path on the right side (current version). */
  bPath: RepoPath;
  /**
   * File flag on the left side (previous version).
   * '': normal; 'x': executable; 'l': symlink; 'a': absent (deleted); 'm': submodule.
   * Cannot be ".".
   */
  aFlag: FileFlag;
  /** File flag on the right side (current version). */
  bFlag: FileFlag;
  /** Unified diff. See `DiffLine`. */
  lines: ReadonlyArray<DiffLine>;
};

/** Path in the repository. Uses '/' path separator on all platforms. */
export type RepoPath = string;

/**
 * - 'x': executable.
 * - 'l': symlink.
 * - 'm': submodule.
 * - 'a': absent (deleted), only used in ISL, not by debugimportstack.
 * - '.': unchanged, only used by debugimportstack.
 */
export type FileFlag = '' | 'x' | 'l' | 'm' | 'a' | '.';

/** A line in unified diff. */
export type DiffLine = {
  /**
   * Line number on the left side (previous version).
   * Starting from 0.
   * `null` means the line does not exist on the left side,
   * aka. the line was added.
   */
  a: number | null;
  /**
   * Line number on the right side (current version).
   * Starting from 0.
   * `null` means the line does not exist on the right side,
   * aka. the line was deleted.
   */
  b: number | null;
  /**
   * Line content.
   * Trailing new-line is preserved.
   * The last line might have no trailing new-line.
   */
  content: string;
};

/**
 * Useful context about conflicting file(s)
 **/
export type ChampagneConflictContext = {
  // If we can guess the commit that introduced the conflicting content on the "local" side (or "dest" when rebasing):
  conflicting_local?: {description: string; diff: string; hash: string};
  // Info about the "other" (or "source" when rebasing) commit:
  conflicting_other: {description: string; diff: string; hash: string};
  // Conflicting file path
  file: string;
};
