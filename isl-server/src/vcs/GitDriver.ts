/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import type {
  AbsolutePath,
  ChangedFile,
  ChangedFileStatus,
  CodeReviewSystem,
  CommitInfo,
  CommitPhaseType,
  Hash,
  MergeConflicts,
  RepoInfo,
  RepoRelativePath,
  RunnableOperation,
  ShelvedChange,
  ValidatedRepoInfo,
} from 'isl/src/types';
import type {Comparison} from 'shared/Comparison';
import type {EjecaOptions, EjecaReturn} from 'shared/ejeca';
import type {RepositoryContext} from '../serverTypes';
import type {VCSDriver} from './VCSDriver';
import type {
  ConfigScope,
  FetchCommitsOptions,
  ResolvedCommand,
  VCSCapabilities,
  WatchConfig,
} from './types';

import {ConflictType, settableConfigNames} from 'isl/src/types';
import os from 'node:os';
import path from 'node:path';
import {ComparisonType} from 'shared/Comparison';
import {ejeca} from 'shared/ejeca';
import {exists} from 'shared/fs';
import {
  READ_COMMAND_TIMEOUT_MS,
  extractRepoInfoFromUrl,
} from '../commands';
import {attachStableLocations, findMaxCommonPathPrefix} from '../templates';
import {isEjecaError} from '../utils';
import {isGithubEnterprise} from '../github/queryGraphQL';

/**
 * VCS Driver for raw Git.
 *
 * Implements the VCSDriver interface using standard git CLI commands.
 * This is a minimal but functional driver that supports basic ISL operations.
 */
export class GitDriver implements VCSDriver {
  readonly name = 'Git';
  readonly command = 'git';

  readonly capabilities: VCSCapabilities = {
    smartlog: false,
    commitPhases: true,
    bookmarks: true,
    amend: true,
    partialCommit: false, // requires stackOperations (debugimportstack)
    partialAmend: false,  // requires stackOperations (debugimportstack)
    rebase: true,
    fold: true,
    hide: true,
    shelve: true,
    graft: true,
    goto: true,
    stackOperations: false, // no git equivalent of debugexportstack/debugimportstack
    commitCloud: false,     // Sapling-specific
    submodules: true,
    alerts: false,          // Sapling-specific
    debugInfo: false,       // no git equivalent of sl rage
    mutationTracking: false, // git has no predecessor/successor tracking
    push: true,
    pullRevision: true,
    submitCommands: [],
  };

  // ── Repository Detection ──────────────────────────────

  async findRoot(ctx: RepositoryContext): Promise<AbsolutePath | undefined> {
    try {
      const result = await this.runCommand(ctx, ['rev-parse', '--show-toplevel']);
      return result.stdout.trim();
    } catch (error) {
      if (
        ['ENOENT', 'EACCES'].includes((error as {code: string}).code)
      ) {
        ctx.logger.error(`command ${ctx.cmd} not found`, error);
        throw error;
      }
      return undefined;
    }
  }

  async findRoots(ctx: RepositoryContext): Promise<AbsolutePath[] | undefined> {
    // Git doesn't have nested repos like Sapling, but we should still return
    // the repo root in an array to match the interface contract
    try {
      const root = await this.findRoot(ctx);
      return root ? [root] : undefined;
    } catch (error) {
      ctx.logger.error(`Failed to find repository roots starting from ${ctx.cwd}`, error);
      return undefined;
    }
  }

  async findDotDir(ctx: RepositoryContext): Promise<AbsolutePath | undefined> {
    try {
      const result = await this.runCommand(ctx, ['rev-parse', '--absolute-git-dir']);
      return result.stdout.trim();
    } catch {
      return undefined;
    }
  }

  async validateRepo(ctx: RepositoryContext): Promise<RepoInfo> {
    const {cmd, cwd, logger} = ctx;
    const [repoRoot, dotdir] = await Promise.all([
      this.findRoot(ctx).catch((err: Error) => err),
      this.findDotDir(ctx),
    ]);

    if (repoRoot instanceof Error) {
      const cwdExists = await exists(cwd);
      if (!cwdExists) {
        return {type: 'cwdDoesNotExist', cwd};
      }
      return {
        type: 'invalidCommand',
        command: cmd,
        path: process.env.PATH,
      };
    }
    if (repoRoot == null || dotdir == null) {
      return {type: 'cwdNotARepository', cwd};
    }

    // Detect code review system from remote URL
    let codeReviewSystem: CodeReviewSystem;
    const remoteUrl = await this.getConfig(ctx, 'remote.origin.url');
    if (remoteUrl == null || remoteUrl === '') {
      codeReviewSystem = {type: 'none'};
    } else {
      const repoInfo = extractRepoInfoFromUrl(remoteUrl);
      if (
        repoInfo != null &&
        (repoInfo.hostname === 'github.com' || (await isGithubEnterprise(repoInfo.hostname)))
      ) {
        const {owner, repo, hostname} = repoInfo;
        codeReviewSystem = {type: 'github', owner, repo, hostname};
      } else {
        codeReviewSystem = {type: 'unknown', path: remoteUrl};
      }
    }

    const result: RepoInfo = {
      type: 'success',
      command: 'git',
      dotdir,
      repoRoot,
      codeReviewSystem,
      pullRequestDomain: undefined,
      preferredSubmitCommand: undefined,
      isEdenFs: false,
    };
    logger.info('repo info: ', result);
    return result;
  }

  // ── Data Fetching ─────────────────────────────────────

  async fetchCommits(
    ctx: RepositoryContext,
    _codeReviewSystem: CodeReviewSystem,
    options: FetchCommitsOptions,
  ): Promise<CommitInfo[]> {
    const {maxDraftDays, stableLocations, recommendedBookmarks} = options;

    // Step 1: Get the set of public (remote-reachable) commit hashes
    const publicHashes = new Set<string>();
    try {
      const remoteResult = await this.runCommand(ctx, ['rev-list', '--remotes']);
      for (const line of remoteResult.stdout.trim().split('\n')) {
        if (line) {
          publicHashes.add(line);
        }
      }
    } catch {
      // No remotes, everything is draft
    }

    // Also mark commits reachable from the trunk branch (main/master) as public.
    // This ensures the trunk line always appears on the leftmost column in the graph,
    // regardless of whether a remote exists.
    const TRUNK_BRANCH_NAMES = ['main', 'master'];
    for (const trunkBranch of TRUNK_BRANCH_NAMES) {
      try {
        const trunkResult = await this.runCommand(ctx, ['rev-list', trunkBranch]);
        for (const line of trunkResult.stdout.trim().split('\n')) {
          if (line) {
            publicHashes.add(line);
          }
        }
        break; // Found trunk branch, stop looking
      } catch {
        // Branch doesn't exist, try next name
      }
    }

    // Step 2: Get HEAD hash for isDot marking
    let headHash = '';
    try {
      const headResult = await this.runCommand(ctx, ['rev-parse', 'HEAD']);
      headHash = headResult.stdout.trim();
    } catch {
      // Empty repo with no commits
      return [];
    }

    // Step 3: Build branch maps
    const localBranches = new Map<string, string>(); // hash -> branch names (NUL-separated)
    const remoteBranches = new Map<string, string[]>(); // hash -> remote branch names
    try {
      const refsResult = await this.runCommand(ctx, [
        'for-each-ref',
        '--format=%(objectname) %(refname)',
        'refs/heads/',
        'refs/remotes/',
      ]);
      for (const line of refsResult.stdout.trim().split('\n')) {
        if (!line) {
          continue;
        }
        const spaceIdx = line.indexOf(' ');
        const hash = line.substring(0, spaceIdx);
        const refname = line.substring(spaceIdx + 1);
        if (refname.startsWith('refs/heads/')) {
          const branchName = refname.substring('refs/heads/'.length);
          const existing = localBranches.get(hash);
          localBranches.set(hash, existing ? existing + '\0' + branchName : branchName);
        } else if (refname.startsWith('refs/remotes/')) {
          const remoteName = refname.substring('refs/remotes/'.length);
          if (remoteName.endsWith('/HEAD')) {
            continue;
          }
          const existing = remoteBranches.get(hash) ?? [];
          existing.push(remoteName);
          remoteBranches.set(hash, existing);
        }
      }
    } catch {
      // No refs
    }

    // Step 4: Get commit log
    // Use %x00 (git's hex escape) as field separator since Node.js doesn't allow
    // literal NUL bytes in command arguments
    const FIELD_SEP = '\x00'; // for parsing output
    const RECORD_SEP = '<<COMMIT_END>>';
    const format = [
      '%H',      // hash
      '%P',      // parent hashes (space-separated)
      '%an',     // author name
      '%ae',     // author email
      '%cI',     // committer date ISO
      '%s',      // subject (first line)
      '%b',      // body (everything after first line)
    ].join('%x00') + RECORD_SEP;

    // Build log args: always include HEAD, branches, and any stable/recommended locations
    const logArgs = [
      'log',
      '--all',
      '--format=' + format,
      '--topo-order',
    ];

    // Filter draft commits by date if maxDraftDays is set
    const draftDateCutoff = maxDraftDays != null
      ? new Date(Date.now() - maxDraftDays * 24 * 60 * 60 * 1000)
      : undefined;

    let logOutput: string;
    try {
      const logResult = await this.runCommand(ctx, logArgs);
      logOutput = logResult.stdout;
    } catch {
      return [];
    }

    // Resolve stable locations and recommended bookmarks to hashes
    const stableHashes = new Set(stableLocations.map(l => l.hash));
    const recommendedBranchHashes = new Set<string>();
    for (const bookmark of recommendedBookmarks) {
      try {
        const result = await this.runCommand(ctx, ['rev-parse', bookmark]);
        recommendedBranchHashes.add(result.stdout.trim());
      } catch {
        // bookmark not found
      }
    }

    const commits: CommitInfo[] = [];
    const records = logOutput.split(RECORD_SEP);
    for (const record of records) {
      const trimmed = record.trim();
      if (!trimmed) {
        continue;
      }
      const fields = trimmed.split(FIELD_SEP);
      if (fields.length < 7) {
        continue;
      }
      const [hash, parentsStr, authorName, authorEmail, dateStr, subject, body] = fields;
      const parents = parentsStr ? parentsStr.split(' ').filter(Boolean) : [];
      const phase: CommitPhaseType = publicHashes.has(hash) ? 'public' : 'draft';
      const isDot = hash === headHash;
      const commitDate = new Date(dateStr);

      // Apply date filter for draft commits, but always include:
      // - public commits, HEAD, stable locations, recommended bookmarks
      if (
        draftDateCutoff != null &&
        phase === 'draft' &&
        !isDot &&
        !stableHashes.has(hash) &&
        !recommendedBranchHashes.has(hash) &&
        commitDate < draftDateCutoff
      ) {
        continue;
      }

      // Get bookmarks (local branches) for this commit
      const bookmarksStr = localBranches.get(hash);
      const bookmarks = bookmarksStr ? bookmarksStr.split('\0') : [];

      // Get remote bookmarks for this commit
      const remoteBookmarksList = remoteBranches.get(hash) ?? [];

      // Get file list for draft commits (skip for public to avoid huge codemods)
      let filePathsSample: RepoRelativePath[] = [];
      let totalFileCount = 0;
      if (phase === 'draft') {
        try {
          const filesResult = await this.runCommand(ctx, [
            'diff-tree',
            '--no-commit-id',
            '-r',
            '--name-only',
            hash,
          ]);
          const files = filesResult.stdout.trim().split('\n').filter(Boolean);
          totalFileCount = files.length;
          filePathsSample = files.slice(0, 25);
        } catch {
          // Ignore
        }
      }

      // Build full description: body already excludes the subject line
      const description = body ? subject + '\n' + body : subject;

      commits.push({
        title: subject,
        hash,
        parents,
        grandparents: [],
        phase,
        isDot,
        author: `${authorName} <${authorEmail}>`,
        date: new Date(dateStr),
        description,
        bookmarks,
        remoteBookmarks: remoteBookmarksList,
        filePathsSample,
        totalFileCount,
        maxCommonPathPrefix: findMaxCommonPathPrefix([...filePathsSample]),
      });
    }

    attachStableLocations(commits, stableLocations);

    return commits;
  }

  async fetchStatus(ctx: RepositoryContext): Promise<ChangedFile[]> {
    const result = await this.runCommand(ctx, [
      'status',
      '--porcelain=v2',
      '-uall',
    ]);
    const files: ChangedFile[] = [];
    for (const line of result.stdout.split('\n')) {
      if (!line) {
        continue;
      }
      if (line.startsWith('1 ')) {
        // Changed (ordinary) entry: 1 XY sub mH mI mW hH hI path
        const parts = line.split(' ');
        // parts[0] = '1', parts[1] = XY, ... parts[8] = path
        // But path might have spaces. Everything from index 8 onward is the path.
        const xy = parts[1];
        const pathParts = parts.slice(8);
        const filePath = pathParts.join(' ');
        const status = this.porcelainStatusToChanged(xy);
        if (status) {
          files.push({path: filePath, status});
        }
      } else if (line.startsWith('2 ')) {
        // Renamed/copied entry: 2 XY sub mH mI mW hH hI X{score} path\torigPath
        const parts = line.split('\t');
        const beforeTab = parts[0].split(' ');
        const xy = beforeTab[1];
        const filePath = parts[0].split(' ').slice(9).join(' ');
        const origPath = parts[1];
        const status = this.porcelainStatusToChanged(xy);
        if (status) {
          files.push({path: filePath, status, copy: origPath});
        }
      } else if (line.startsWith('? ')) {
        // Untracked: ? path
        const filePath = line.substring(2);
        files.push({path: filePath, status: '?'});
      } else if (line.startsWith('u ')) {
        // Unmerged entry: u XY sub m1 m2 m3 mW h1 h2 h3 path
        const parts = line.split(' ');
        const filePath = parts.slice(10).join(' ');
        files.push({path: filePath, status: 'U'});
      }
    }
    return files;
  }

  async checkMergeConflicts(
    ctx: RepositoryContext,
    previousConflicts: MergeConflicts | undefined,
  ): Promise<MergeConflicts | undefined> {
    const fetchStartTimestamp = Date.now();

    // Detect what kind of operation is in progress
    const dotdir = await this.findDotDir(ctx);
    if (!dotdir) {
      return undefined;
    }

    let command: string | undefined;
    let toAbort: string | undefined;
    let toContinue: string | undefined;

    if (await exists(path.join(dotdir, 'rebase-merge'))) {
      command = 'rebase';
      toAbort = 'git rebase --abort';
      toContinue = 'git rebase --continue';
    } else if (await exists(path.join(dotdir, 'rebase-apply'))) {
      command = 'rebase';
      toAbort = 'git rebase --abort';
      toContinue = 'git rebase --continue';
    } else if (await exists(path.join(dotdir, 'MERGE_HEAD'))) {
      command = 'merge';
      toAbort = 'git merge --abort';
      toContinue = 'git merge --continue';
    } else if (await exists(path.join(dotdir, 'CHERRY_PICK_HEAD'))) {
      command = 'cherry-pick';
      toAbort = 'git cherry-pick --abort';
      toContinue = 'git cherry-pick --continue';
    }

    if (!command) {
      return undefined;
    }

    // Get conflicting files from status
    const conflictFiles: Array<ChangedFile & {conflictType: ConflictType}> = [];
    try {
      const statusResult = await this.runCommand(ctx, ['status', '--porcelain=v2', '-uall']);
      for (const line of statusResult.stdout.split('\n')) {
        if (line.startsWith('u ')) {
          const parts = line.split(' ');
          const filePath = parts.slice(10).join(' ');
          conflictFiles.push({path: filePath, status: 'U', conflictType: ConflictType.BothChanged});
        }
      }
    } catch {
      // If status fails during conflict, still report the conflict
    }

    // Get hashes involved
    let localHash: string | undefined;
    let otherHash: string | undefined;
    try {
      const headResult = await this.runCommand(ctx, ['rev-parse', 'HEAD']);
      localHash = headResult.stdout.trim();
    } catch {
      // ignore
    }
    try {
      if (command === 'merge') {
        const {readFile} = await import('node:fs/promises');
        const mergeHead = await readFile(path.join(dotdir, 'MERGE_HEAD'), 'utf-8');
        otherHash = mergeHead.trim();
      } else if (command === 'cherry-pick') {
        const {readFile} = await import('node:fs/promises');
        const cherryPickHead = await readFile(path.join(dotdir, 'CHERRY_PICK_HEAD'), 'utf-8');
        otherHash = cherryPickHead.trim();
      }
    } catch {
      // ignore
    }

    return {
      state: 'loaded',
      command,
      toContinue: toContinue!,
      toAbort: toAbort!,
      files: conflictFiles,
      fetchStartTimestamp,
      fetchCompletedTimestamp: Date.now(),
      hashes: {local: localHash, other: otherHash},
    };
  }

  async lookupCommits(
    ctx: RepositoryContext,
    _codeReviewSystem: CodeReviewSystem,
    hashes: Hash[],
  ): Promise<CommitInfo[]> {
    if (hashes.length === 0) {
      return [];
    }

    const FIELD_SEP = '\x00'; // for parsing output
    const RECORD_SEP = '<<COMMIT_END>>';
    const format = [
      '%H', '%P', '%an', '%ae', '%cI', '%s', '%b',
    ].join('%x00') + RECORD_SEP;

    let headHash = '';
    try {
      headHash = (await this.runCommand(ctx, ['rev-parse', 'HEAD'])).stdout.trim();
    } catch {
      // ignore
    }

    const result = await this.runCommand(ctx, [
      'log',
      '--no-walk',
      '--format=' + format,
      ...hashes,
    ]);

    const commits: CommitInfo[] = [];
    for (const record of result.stdout.split(RECORD_SEP)) {
      const trimmed = record.trim();
      if (!trimmed) {
        continue;
      }
      const fields = trimmed.split(FIELD_SEP);
      if (fields.length < 7) {
        continue;
      }
      const [hash, parentsStr, authorName, authorEmail, dateStr, subject, body] = fields;
      const parents = parentsStr ? parentsStr.split(' ').filter(Boolean) : [];
      const description = body ? subject + '\n' + body : subject;

      commits.push({
        title: subject,
        hash,
        parents,
        grandparents: [],
        phase: 'draft',
        isDot: hash === headHash,
        author: `${authorName} <${authorEmail}>`,
        date: new Date(dateStr),
        description,
        bookmarks: [],
        remoteBookmarks: [],
        filePathsSample: [],
        totalFileCount: 0,
        maxCommonPathPrefix: '',
      });
    }
    return commits;
  }

  async getFileContents(
    ctx: RepositoryContext,
    filePath: AbsolutePath,
    revset: string,
  ): Promise<string> {
    // Map '.' to HEAD for git
    const rev = revset === '.' ? 'HEAD' : revset;
    // Convert absolute path to repo-relative
    const root = await this.findRoot(ctx);
    const relativePath = root ? path.relative(root, filePath) : filePath;
    const result = await this.runCommand(
      ctx,
      ['show', `${rev}:${relativePath}`],
      {stripFinalNewline: false},
    );
    return result.stdout;
  }

  async getBlame(
    ctx: RepositoryContext,
    filePath: string,
    hash: Hash,
  ): Promise<Array<{line: string; node: string}>> {
    const rev = hash === '.' ? 'HEAD' : hash;
    // Convert absolute path to repo-relative for git
    const root = await this.findRoot(ctx);
    const relativePath = root && path.isAbsolute(filePath) ? path.relative(root, filePath) : filePath;
    const result = await this.runCommand(
      ctx,
      ['blame', '--porcelain', '--no-ignore-revs-file', rev, '--', relativePath],
      undefined,
      0, // no timeout
    );

    const lines: Array<{line: string; node: string}> = [];
    const output = result.stdout;
    const outputLines = output.split('\n');

    for (let i = 0; i < outputLines.length; i++) {
      const blameLine = outputLines[i];
      // Blame header lines start with a hash (40 hex chars)
      if (/^[0-9a-f]{40}/.test(blameLine)) {
        const commitHash = blameLine.substring(0, 40);
        // Scan forward to find the content line (starts with \t)
        for (let j = i + 1; j < outputLines.length; j++) {
          if (outputLines[j].startsWith('\t')) {
            lines.push({
              line: outputLines[j].substring(1),
              node: commitHash,
            });
            i = j;
            break;
          }
        }
      }
    }
    return lines;
  }

  async getDiff(
    ctx: RepositoryContext,
    comparison: Comparison,
    contextLines = 4,
  ): Promise<string> {
    const args = this.diffArgsForComparison(comparison);
    const result = await this.runCommand(ctx, [
      'diff',
      ...args,
      '--no-prefix',
      '--unified=' + String(contextLines),
    ]);
    return result.stdout;
  }

  async getChangedFiles(ctx: RepositoryContext, hash: Hash): Promise<ChangedFile[]> {
    const result = await this.runCommand(ctx, [
      'diff-tree',
      '--no-commit-id',
      '-r',
      '--name-status',
      hash,
    ]);

    const files: ChangedFile[] = [];
    for (const line of result.stdout.trim().split('\n')) {
      if (!line) {
        continue;
      }
      const parts = line.split('\t');
      if (parts.length < 2) {
        continue;
      }
      const statusChar = parts[0].charAt(0);
      let status: ChangedFileStatus;
      switch (statusChar) {
        case 'A':
          status = 'A';
          break;
        case 'M':
          status = 'M';
          break;
        case 'D':
          status = 'R';
          break;
        case 'R':
          // Git rename: tab-separated original\tnew
          status = 'A';
          break;
        default:
          status = 'M';
      }
      const filePath = statusChar === 'R' && parts.length >= 3 ? parts[2] : parts[1];
      files.push({path: filePath, status});
    }
    return files;
  }

  async getShelvedChanges(ctx: RepositoryContext): Promise<ShelvedChange[]> {
    let stashListOutput: string;
    try {
      const result = await this.runCommand(ctx, [
        'stash',
        'list',
        '--format=%H%x00%gd%x00%cI%x00%s',
      ]);
      stashListOutput = result.stdout.trim();
    } catch {
      return [];
    }

    if (!stashListOutput) {
      return [];
    }

    const shelves: ShelvedChange[] = [];
    for (const line of stashListOutput.split('\n')) {
      if (!line) {
        continue;
      }
      const [hash, name, dateStr, description] = line.split('\x00');

      // Get files for this stash
      let filesSample: ChangedFile[] = [];
      let totalFileCount = 0;
      try {
        const showResult = await this.runCommand(ctx, [
          'stash',
          'show',
          '--name-status',
          name,
        ]);
        const fileLines = showResult.stdout.trim().split('\n').filter(Boolean);
        totalFileCount = fileLines.length;
        filesSample = fileLines.slice(0, 25).map(fileLine => {
          const parts = fileLine.split('\t');
          const statusChar = parts[0].charAt(0);
          let status: ChangedFileStatus;
          switch (statusChar) {
            case 'A':
              status = 'A';
              break;
            case 'D':
              status = 'R';
              break;
            default:
              status = 'M';
          }
          return {path: parts[1] ?? parts[0], status};
        });
      } catch {
        // ignore
      }

      shelves.push({
        hash,
        name,
        date: new Date(dateStr),
        filesSample,
        totalFileCount,
        description: description ?? '',
      });
    }
    return shelves;
  }

  async getDiffStats(
    ctx: RepositoryContext,
    hash: Hash,
    excludeFiles: string[],
  ): Promise<number | undefined> {
    try {
      // Build exclude patterns using git pathspec exclusion syntax
      const exclusions = excludeFiles.flatMap(file => [':(exclude)' + file]);

      // Use diff against first parent. For merge commits, this shows what the merge brought in.
      // Use -- separator before paths to avoid ambiguity
      const args = ['diff', '--stat', hash + '^', hash];
      if (exclusions.length > 0) {
        args.push('--', '.', ...exclusions);
      }
      const result = await this.runCommand(ctx, args);
      return this.parseSlocFrom(result.stdout);
    } catch {
      // Root commit has no parent; use --root with diff-tree
      try {
        const exclusions = excludeFiles.flatMap(file => [':(exclude)' + file]);
        const args = ['diff-tree', '--stat', '--root', hash];
        if (exclusions.length > 0) {
          args.push('--', '.', ...exclusions);
        }
        const result = await this.runCommand(ctx, args);
        return this.parseSlocFrom(result.stdout);
      } catch {
        return undefined;
      }
    }
  }

  async getPendingDiffStats(
    ctx: RepositoryContext,
    _includeFiles: string[],
  ): Promise<number | undefined> {
    try {
      const result = await this.runCommand(ctx, ['diff', '--stat']);
      return this.parseSlocFrom(result.stdout);
    } catch {
      return undefined;
    }
  }

  async getPendingAmendDiffStats(
    ctx: RepositoryContext,
    _includeFiles: string[],
  ): Promise<number | undefined> {
    try {
      const result = await this.runCommand(ctx, ['diff', '--stat', 'HEAD^']);
      return this.parseSlocFrom(result.stdout);
    } catch {
      return undefined;
    }
  }

  // ── Configuration ─────────────────────────────────────

  async getConfig(ctx: RepositoryContext, name: string): Promise<string | undefined> {
    try {
      const result = await this.runCommand(ctx, ['config', '--get', name]);
      return result.stdout.trim();
    } catch {
      return undefined;
    }
  }

  async getConfigs<T extends string>(
    ctx: RepositoryContext,
    names: ReadonlyArray<T>,
  ): Promise<Map<T, string>> {
    const configMap = new Map<T, string>();
    for (const name of names) {
      const value = await this.getConfig(ctx, name);
      if (value != null) {
        configMap.set(name, value);
      }
    }
    return configMap;
  }

  async setConfig(
    ctx: RepositoryContext,
    scope: ConfigScope,
    name: string,
    value: string,
  ): Promise<void> {
    const scopeFlag = scope === 'user' ? '--global' : scope === 'system' ? '--system' : '--local';
    await this.runCommand(ctx, ['config', scopeFlag, name, value]);
  }

  // ── Command Execution ─────────────────────────────────

  async runCommand(
    ctx: RepositoryContext,
    args: string[],
    options?: EjecaOptions,
    timeout: number = READ_COMMAND_TIMEOUT_MS,
  ): Promise<EjecaReturn> {
    const {command, args: resolvedArgs, options: resolvedOptions} = this.getExecParams(
      args,
      ctx.cwd,
      options,
    );
    ctx.logger.log('run command: ', ctx.cwd, command, resolvedArgs[0]);
    const result = ejeca(command, resolvedArgs, resolvedOptions);

    let timedOut = false;
    let timeoutId: NodeJS.Timeout | undefined;
    if (timeout > 0) {
      timeoutId = setTimeout(() => {
        result.kill('SIGTERM', {forceKillAfterTimeout: 5_000});
        ctx.logger.error(`Timed out waiting for ${command} ${resolvedArgs[0]} to finish`);
        timedOut = true;
      }, timeout);
      result.on('exit', () => {
        clearTimeout(timeoutId);
      });
    }

    try {
      const val = await result;
      return val;
    } catch (err: unknown) {
      if (isEjecaError(err)) {
        if (err.killed) {
          if (timedOut) {
            throw new Error('Timed out');
          }
          throw new Error('Killed');
        }
      }
      ctx.logger.error(`Error running ${command} ${resolvedArgs[0]}: ${err?.toString()}`);
      throw err;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  normalizeOperationArgs(
    cwd: string,
    repoRoot: AbsolutePath,
    operation: RunnableOperation,
  ): ResolvedCommand {
    const illegalArgs = new Set(['--git-dir', '--work-tree']);
    let stdin = operation.stdin;
    const args: string[] = [];
    for (const arg of operation.args) {
      if (typeof arg === 'object') {
        switch (arg.type) {
          case 'config':
            if (!(settableConfigNames as ReadonlyArray<string>).includes(arg.key)) {
              throw new Error(`config ${arg.key} not allowed`);
            }
            args.push('-c', `${arg.key}=${arg.value}`);
            continue;
          case 'repo-relative-file':
            args.push(path.normalize(path.relative(cwd, path.join(repoRoot, arg.path))));
            continue;
          case 'repo-relative-file-list':
            // Git doesn't have listfile0, pass files individually
            for (const p of arg.paths) {
              args.push(path.normalize(path.relative(cwd, path.join(repoRoot, p))));
            }
            continue;
          case 'exact-revset':
            if (arg.revset.startsWith('-')) {
              throw new Error('invalid revset');
            }
            args.push(arg.revset);
            continue;
          case 'succeedable-revset':
            // Git has no successor tracking; use hash directly
            args.push(arg.revset);
            continue;
          case 'optimistic-revset':
            // Git has no successor tracking; use hash directly
            args.push(arg.revset);
            continue;
        }
      }
      if (illegalArgs.has(arg)) {
        throw new Error(`argument '${arg}' is not allowed`);
      }
      args.push(arg);
    }

    // Translate Sapling-style commands to git equivalents
    if (args[0] === 'commit') {
      return {args: args.filter(a => a !== '--addremove'), stdin};
    }
    if (args[0] === 'amend') {
      const out: string[] = ['commit', '--amend'];
      for (let i = 1; i < args.length; i++) {
        if (args[i] === '--addremove') continue;
        if (args[i] === '--user') { out.push('--author', args[++i]); continue; }
        out.push(args[i]);
      }
      return {args: out, stdin};
    }
    if (args[0] === 'metaedit') {
      const out: string[] = ['commit', '--amend'];
      for (let i = 1; i < args.length; i++) {
        if (args[i] === '--rev') { i++; continue; }  // drop --rev HASH
        if (args[i] === '--user') { out.push('--author', args[++i]); continue; }
        out.push(args[i]);
      }
      return {args: out, stdin};
    }
    if (args[0] === 'goto') {
      if (args.includes('--clean')) {
        // Discard all working directory changes
        const files = args.filter(a => a !== 'goto' && a !== '--clean');
        return {args: ['checkout', '--', ...files], stdin};
      }
      // goto --rev HASH → checkout HASH
      const revIdx = args.indexOf('--rev');
      const hash = revIdx !== -1 ? args[revIdx + 1] : args[1];
      return {args: ['checkout', hash], stdin};
    }
    if (args[0] === 'revert') {
      const revIdx = args.indexOf('--rev');
      const hash = revIdx !== -1 ? args[revIdx + 1] : 'HEAD';
      const files = args.slice(1).filter((a, i, arr) =>
        a !== '--rev' && arr[i - 1] !== '--rev'
      );
      return {args: ['checkout', hash, '--', ...files], stdin};
    }
    if (args[0] === 'forget') {
      // `sl forget <file>` → `git rm --cached <file>`
      return {args: ['rm', '--cached', ...args.slice(1)], stdin};
    }
    if (args[0] === 'fold') {
      return this.translateFoldToGit(args);
    }
    if (args[0] === 'hide') {
      return this.translateHideToGit(args);
    }
    if (args[0] === 'pull' && args.includes('--rev')) {
      return this.translatePullRevToGit(args);
    }
    if (args[0] === 'bookmark') {
      if (args[1] === '--delete') {
        return {args: ['branch', '-d', args[2]], stdin};
      }
      // bookmark NAME --rev HASH → branch NAME HASH
      const name = args[1];
      const revIdx = args.indexOf('--rev');
      const hash = revIdx !== -1 ? args[revIdx + 1] : 'HEAD';
      return {args: ['branch', name, hash], stdin};
    }
    if (args[0] === 'shelve') {
      if (args[1] === '--delete') {
        return {args: ['stash', 'drop'], stdin};
      }
      const out: string[] = ['stash', 'push'];
      let name: string | undefined;
      const files: string[] = [];
      for (let i = 1; i < args.length; i++) {
        if (args[i] === '--unknown') { out.push('-u'); continue; }
        if (args[i] === '--name' && i + 1 < args.length) { name = args[++i]; continue; }
        files.push(args[i]);
      }
      if (name) out.push('-m', name);
      if (files.length > 0) out.push('--', ...files);
      return {args: out, stdin};
    }
    if (args[0] === 'unshelve') {
      const keep = args.includes('--keep');
      return {args: ['stash', keep ? 'apply' : 'pop'], stdin};
    }
    if (args[0] === 'rebase') {
      if (args.includes('--keep')) {
        // RebaseKeepOperation: copy without moving → cherry-pick
        const revIdx = args.indexOf('--rev');
        const src = revIdx !== -1 ? args[revIdx + 1] : undefined;
        if (!src) throw new Error('rebase --keep requires --rev');
        return {args: ['cherry-pick', src], stdin};
      }
      // Standard rebase: -s SRC -d DEST → rebase --onto DEST SRC^ SRC
      let src: string | undefined;
      let dest: string | undefined;
      for (let i = 1; i < args.length; i++) {
        if ((args[i] === '-s' || args[i] === '--source') && i + 1 < args.length) src = args[++i];
        else if ((args[i] === '-d' || args[i] === '--dest') && i + 1 < args.length) dest = args[++i];
      }
      if (!src || !dest) throw new Error('rebase requires -s and -d');
      return {args: ['rebase', '--onto', dest, src + '^', src], stdin};
    }
    if (args[0] === 'graft') {
      return {args: ['cherry-pick', ...args.slice(1)], stdin};
    }
    if (args[0] === 'uncommit') {
      return {args: ['reset', '--soft', 'HEAD~1'], stdin};
    }

    return {args, stdin};
  }

  /**
   * Translate `fold --exact HASH1::HASH2 --message MSG` into
   * `rebase -i BOTTOM^` with:
   * - GIT_SEQUENCE_EDITOR: sed that changes all picks after the first to `squash`
   * - GIT_EDITOR: shell script that writes the new message to the editor file
   *
   * The `squash` directive causes git to open the editor for the combined message.
   * Our GIT_EDITOR replaces the editor file content with the desired message.
   */
  private translateFoldToGit(args: string[]): ResolvedCommand {
    let revset: string | undefined;
    let message: string | undefined;
    for (let i = 1; i < args.length; i++) {
      if (args[i] === '--exact' && i + 1 < args.length) {
        revset = args[++i];
      } else if (args[i] === '--message' && i + 1 < args.length) {
        message = args[++i];
      }
    }
    if (!revset || !message) {
      throw new Error('fold requires --exact <revset> and --message <msg>');
    }

    // Sapling revset HASH1::HASH2 — extract the bottom hash
    const rangeMatch = /^([0-9a-f]+)::([0-9a-f]+)$/.exec(revset);
    if (!rangeMatch) {
      throw new Error(`fold: unsupported revset format: ${revset}`);
    }
    const bottomHash = rangeMatch[1];

    // sed: change every `pick` after the first line to `squash`
    const sequenceEditor = `sed -i '2,$ s/^pick/squash/'`;

    // Shell script that overwrites the commit-message editor file with our message.
    // ISL_FOLD_MESSAGE is passed via env to avoid shell escaping issues.
    const commitEditor = `sh -c 'printf "%s" "$ISL_FOLD_MESSAGE" > "$1"' --`;

    return {
      args: ['rebase', '-i', bottomHash + '^'],
      env: {
        GIT_SEQUENCE_EDITOR: sequenceEditor,
        GIT_EDITOR: commitEditor,
        ISL_FOLD_MESSAGE: message,
      },
    };
  }

  /**
   * Translate `pull --rev HASH` to `git fetch origin HASH`.
   */
  private translatePullRevToGit(args: string[]): ResolvedCommand {
    let rev: string | undefined;
    for (let i = 1; i < args.length; i++) {
      if (args[i] === '--rev' && i + 1 < args.length) {
        rev = args[++i];
      }
    }
    if (!rev) {
      throw new Error('pull --rev requires a revision');
    }
    return {args: ['fetch', 'origin', rev]};
  }

  /**
   * Translate `hide --rev HASH` to git commands that make the commit unreachable.
   *
   * Finds all local branches pointing at the hash and deletes them via
   * `for-each-ref --points-at`. If no branch points at it, the commit is
   * already unreachable from branch refs and we just need to ensure HEAD
   * isn't on it.
   */
  private translateHideToGit(args: string[]): ResolvedCommand {
    let hash: string | undefined;
    for (let i = 1; i < args.length; i++) {
      if (args[i] === '--rev' && i + 1 < args.length) {
        hash = args[++i];
      }
    }
    if (!hash) {
      throw new Error('hide requires --rev <hash>');
    }

    // Shell script: find branches at this hash, delete them.
    // If HEAD is detached at this hash, move to parent first.
    // Uses sh -c so we can run multiple git commands.
    const script = [
      // Move HEAD to parent if detached at this commit
      `if [ "$(git rev-parse HEAD)" = "${hash}" ]; then git checkout --detach ${hash}^; fi`,
      // Delete all local branches pointing at this commit
      `for b in $(git for-each-ref --format="%(refname:short)" --points-at ${hash} refs/heads/); do git branch -D "$b"; done`,
    ].join(' && ');

    // Return as a shell command rather than a git command.
    // getExecParams will be called with these args, but we override the command to sh.
    return {
      args: ['__shell__', script],
    };
  }

  getExecParams(
    args_: string[],
    cwd: string,
    options_?: EjecaOptions,
    env?: Record<string, string>,
  ): {command: string; args: string[]; options: EjecaOptions} {
    const args = [...args_];

    const newEnv = {
      GIT_EDITOR: 'false',
      ...options_?.env,
      ...env,
      GIT_TERMINAL_PROMPT: '0',
      EDITOR: undefined,
      VISUAL: undefined,
    } as unknown as NodeJS.ProcessEnv;

    let langEnv = newEnv.LANG ?? process.env.LANG;
    if (langEnv === undefined || !langEnv.toUpperCase().endsWith('UTF-8')) {
      langEnv = 'C.UTF-8';
    }
    newEnv.LANG = langEnv;

    const options: EjecaOptions = {
      ...options_,
      env: newEnv,
      cwd,
    };

    // Handle shell commands (used by hide translation)
    if (args[0] === '__shell__') {
      return {command: 'sh', args: ['-c', args[1]], options};
    }

    return {command: this.command, args, options};
  }

  async getMergeTool(ctx: RepositoryContext): Promise<string | null> {
    if (ctx.cachedMergeTool !== undefined) {
      return ctx.cachedMergeTool;
    }
    const tool = await this.getConfig(ctx, 'merge.tool');
    const mergeTool = tool ?? null;
    ctx.cachedMergeTool = mergeTool;
    return mergeTool;
  }

  async getMergeToolEnvVars(_ctx: RepositoryContext): Promise<Record<string, string> | undefined> {
    // Git handles merge tools through its own config
    return undefined;
  }

  // ── File Watching ─────────────────────────────────────

  getWatchConfig(_repoInfo: ValidatedRepoInfo): WatchConfig {
    return {
      watchmanDefers: [],
      dirstateFiles: ['HEAD', 'index', 'MERGE_HEAD', 'REBASE_HEAD', 'CHERRY_PICK_HEAD'],
      subscriptionPrefix: 'git-smartlog',
      supportsEdenFs: false,
      additionalWatchDirs: ['refs/heads', 'refs/remotes'],
    };
  }

  // ── Private Helpers ───────────────────────────────────

  /**
   * Convert git porcelain v2 XY status codes to ChangedFileStatus.
   */
  private porcelainStatusToChanged(xy: string): ChangedFileStatus | null {
    const index = xy[0];
    const workTree = xy[1];

    // Prioritize working tree changes, fall back to index
    if (workTree === 'M') {
      return 'M';
    }
    if (workTree === 'D') {
      return 'R'; // R = removed in ISL terminology
    }
    if (workTree === 'A') {
      return 'A';
    }
    if (index === 'A' || index === 'C') {
      return 'A';
    }
    if (index === 'M') {
      return 'M';
    }
    if (index === 'D') {
      return 'R';
    }
    if (index === 'R') {
      return 'A'; // rename shows as add
    }
    return null;
  }

  /**
   * Convert a Comparison to git diff arguments.
   */
  private diffArgsForComparison(comparison: Comparison): string[] {
    switch (comparison.type) {
      case ComparisonType.UncommittedChanges:
        return ['HEAD'];
      case ComparisonType.HeadChanges:
        return ['HEAD^', 'HEAD'];
      case ComparisonType.StackChanges:
        return ['HEAD'];
      case ComparisonType.Committed:
        return [comparison.hash + '^', comparison.hash];
      case ComparisonType.SinceLastCodeReviewSubmit:
        return [comparison.hash + '^', comparison.hash];
    }
  }

  private parseSlocFrom(output: string): number {
    const lines = output.trim().split('\n');
    const changes = lines[lines.length - 1];
    const insertionsMatch = /(\d+) insertions?\(\+\)/.exec(changes);
    const deletionsMatch = /(\d+) deletions?\(-\)/.exec(changes);
    const insertions = parseInt(insertionsMatch?.[1] ?? '0', 10);
    const deletions = parseInt(deletionsMatch?.[1] ?? '0', 10);
    return insertions + deletions;
  }
}
