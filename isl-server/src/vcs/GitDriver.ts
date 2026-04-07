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
import fs from 'node:fs/promises';
import {realpathSync} from 'node:fs';
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

  // Cache for public commit hashes (trunk commits). Rebuilt when trunk HEAD changes.
  private cachedPublicHashes: Set<string> | null = null;
  private cachedPublicHashesTrunkHead: string | null = null;
  private cachedPublicHashesTimestamp = 0;
  private static readonly PUBLIC_HASHES_TTL_MS = 60_000; // 1 minute

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
      const rawRoot = result.stdout.trim();
      // Resolve symlinks so that path comparisons are consistent regardless
      // of whether the caller used a symlinked path (e.g. /var → /private/var on macOS).
      return await fs.realpath(rawRoot);
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

    // Step 1: Get the set of public commit hashes.
    // "Public" = commits on the trunk branch (main/master). Feature branch commits
    // remain "draft" even if pushed to a remote, matching Sapling's phase semantics.
    // We check origin/<trunk> first (remote truth), then fall back to local <trunk>.
    // The result is cached and invalidated when trunk HEAD changes or TTL expires.
    const publicHashes = await this.getPublicHashes(ctx);

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
        '--count=2000',
        '--sort=-committerdate',
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

    // Build log args: always include HEAD, branches, and any stable/recommended locations.
    // Cap at MAX_LOG_COMMITS to avoid RangeError: Invalid string length on very large
    // repos where git log --all output can exceed Node.js's string size limit.
    const MAX_LOG_COMMITS = 10_000;
    const logArgs = [
      'log',
      'HEAD',
      '--glob=refs/heads/',
      '--glob=refs/remotes/origin/',
      '--format=' + format,
      '--topo-order',
      '--max-count=' + MAX_LOG_COMMITS,
    ];

    // When maxDraftDays is set, let git filter by date so we avoid fetching the
    // entire history on large repos. The JS-side draftDateCutoff below still acts
    // as a secondary filter for edge cases (e.g. author date vs commit date).
    const draftDateCutoff = maxDraftDays != null
      ? new Date(Date.now() - maxDraftDays * 24 * 60 * 60 * 1000)
      : undefined;
    if (draftDateCutoff != null) {
      logArgs.push('--since=' + draftDateCutoff.toISOString());
    }

    let logOutput: string;
    try {
      const logResult = await this.runCommand(ctx, logArgs);
      logOutput = logResult.stdout;
    } catch {
      return [];
    }

    // When using --since, branch tips older than the cutoff are excluded by git.
    // Fetch them separately so branches always appear in the UI regardless of age.
    if (draftDateCutoff != null) {
      try {
        const branchTipArgs = [
          'log',
          '--format=' + format,
          '--no-walk',
          ...Array.from(localBranches.values())
            .flatMap(names => names.split('\0'))
            .map(name => 'refs/heads/' + name),
        ];
        if (branchTipArgs.length > 4) { // has actual branch refs beyond the base args
          const tipsResult = await this.runCommand(ctx, branchTipArgs);
          logOutput += tipsResult.stdout;
        }
      } catch {
        // Branch tips query failed — continue with what we have
      }
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
    const seenHashes = new Set<string>();
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
      if (seenHashes.has(hash)) {
        continue;
      }
      seenHashes.add(hash);
      const parents = parentsStr ? parentsStr.split(' ').filter(Boolean) : [];
      const phase: CommitPhaseType = publicHashes.has(hash) ? 'public' : 'draft';
      const isDot = hash === headHash;
      const commitDate = new Date(dateStr);

      // Apply date filter for draft commits, but always include:
      // - public commits, HEAD, stable locations, recommended bookmarks,
      //   and commits with local branches (so branch tags are always visible)
      if (
        draftDateCutoff != null &&
        phase === 'draft' &&
        !isDot &&
        !localBranches.has(hash) &&
        !stableHashes.has(hash) &&
        !recommendedBranchHashes.has(hash) &&
        commitDate < draftDateCutoff
      ) {
        continue;
      }

      // Get bookmarks (local branches) for this commit
      const bookmarksStr = localBranches.get(hash);
      const bookmarks = bookmarksStr ? bookmarksStr.split('\0') : [];

      // Always include remote bookmarks so the UI can show where the remote is,
      // even when a local branch with the same name is on the same commit.
      const remoteBookmarksList = remoteBranches.get(hash) ?? [];

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
        filePathsSample: [],
        totalFileCount: 0,
        maxCommonPathPrefix: '',
      });
    }

    attachStableLocations(commits, stableLocations);

    return commits;
  }

  /**
   * Get public commit hashes with caching. Invalidated when trunk HEAD changes or TTL expires.
   */
  private async getPublicHashes(ctx: RepositoryContext): Promise<Set<string>> {
    // Check if cache is still valid
    const now = Date.now();
    if (
      this.cachedPublicHashes != null &&
      now - this.cachedPublicHashesTimestamp < GitDriver.PUBLIC_HASHES_TTL_MS
    ) {
      // Quick check: has trunk HEAD changed?
      try {
        const headResult = await this.runCommand(ctx, ['rev-parse', 'refs/remotes/origin/HEAD']);
        const currentHead = headResult.stdout.trim();
        if (currentHead === this.cachedPublicHashesTrunkHead) {
          return this.cachedPublicHashes;
        }
      } catch {
        // If we can't check, just use the TTL
        return this.cachedPublicHashes;
      }
    }

    const publicHashes = new Set<string>();

    // Detect shallow clones — rev-list results are truncated at the graft boundary.
    // In a shallow clone, we use --first-parent to reduce traversal cost since the
    // full history isn't available anyway.
    let isShallow = false;
    try {
      const shallowResult = await this.runCommand(ctx, ['rev-parse', '--is-shallow-repository']);
      isShallow = shallowResult.stdout.trim() === 'true';
    } catch {
      // Old git versions don't support --is-shallow-repository
    }

    // Detect the default branch dynamically
    const trunkCandidates: string[] = [];
    try {
      const symResult = await this.runCommand(ctx, [
        'symbolic-ref',
        '--short',
        'refs/remotes/origin/HEAD',
      ]);
      const detectedBranch = symResult.stdout.trim().replace(/^origin\//, '');
      if (detectedBranch) {
        trunkCandidates.push(detectedBranch);
      }
    } catch {
      // symbolic-ref not set — fall through to well-known names
    }
    for (const name of ['main', 'master']) {
      if (!trunkCandidates.includes(name)) {
        trunkCandidates.push(name);
      }
    }

    const MAX_PUBLIC_HASHES = 50_000;
    let trunkHead: string | null = null;
    for (const trunkBranch of trunkCandidates) {
      for (const ref of [`origin/${trunkBranch}`, trunkBranch]) {
        try {
          const revListArgs = [
            'rev-list',
            '--max-count=' + MAX_PUBLIC_HASHES,
            // In shallow clones, use --first-parent to reduce traversal cost
            ...(isShallow ? ['--first-parent'] : []),
            ref,
          ];
          const trunkResult = await this.runCommand(ctx, revListArgs);
          for (const line of trunkResult.stdout.trim().split('\n')) {
            if (line) {
              publicHashes.add(line);
            }
          }
          // Capture the HEAD of trunk for cache invalidation
          trunkHead = trunkResult.stdout.trim().split('\n')[0] ?? null;
          break;
        } catch {
          // Ref doesn't exist, try next
        }
      }
      if (publicHashes.size > 0) {
        break;
      }
    }

    // Update cache
    this.cachedPublicHashes = publicHashes;
    this.cachedPublicHashesTrunkHead = trunkHead;
    this.cachedPublicHashesTimestamp = now;

    return publicHashes;
  }

  async populateCommitFileInfo(
    ctx: RepositoryContext,
    commits: CommitInfo[],
  ): Promise<CommitInfo[]> {
    const draftCommits = commits.filter(c => c.phase === 'draft');
    if (draftCommits.length === 0) {
      return commits;
    }

    const stdinInput = draftCommits.map(c => c.hash).join('\n') + '\n';
    const batchResult = await this.runCommand(
      ctx,
      ['diff-tree', '--stdin', '-r', '--name-only', '--no-renames'],
      {input: stdinInput},
    );
    // Output format: each commit produces a line with its hash, followed by file lines.
    const lines = batchResult.stdout.split('\n');
    let currentHash: string | null = null;
    let currentFiles: string[] = [];
    const filesByHash = new Map<string, string[]>();

    for (const line of lines) {
      if (/^[0-9a-f]{40}$/.test(line)) {
        if (currentHash != null) {
          filesByHash.set(currentHash, currentFiles);
        }
        currentHash = line;
        currentFiles = [];
      } else if (line && currentHash != null) {
        currentFiles.push(line);
      }
    }
    if (currentHash != null) {
      filesByHash.set(currentHash, currentFiles);
    }

    for (const commit of draftCommits) {
      const files = filesByHash.get(commit.hash) ?? [];
      commit.totalFileCount = files.length;
      commit.filePathsSample = files.slice(0, 25) as RepoRelativePath[];
      commit.maxCommonPathPrefix = findMaxCommonPathPrefix([...commit.filePathsSample]);
    }

    return commits;
  }

  async fetchStatus(ctx: RepositoryContext): Promise<ChangedFile[]> {
    const result = await this.runCommand(ctx, [
      'status',
      '--porcelain=v2',
      '-unormal',
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
      const statusResult = await this.runCommand(ctx, ['status', '--porcelain=v2', '-unormal']);
      for (const line of statusResult.stdout.split('\n')) {
        if (line.startsWith('u ')) {
          // Porcelain v2 unmerged: u <XY> <sub> <m1> <m2> <m3> <mW> <h1> <h2> <h3> <path>
          const parts = line.split(' ');
          const xy = parts[1]; // e.g. UU, AA, DU, UD, AU, UA, DD
          const filePath = parts.slice(10).join(' ');
          conflictFiles.push({
            path: filePath,
            status: 'U',
            conflictType: gitConflictXYToType(xy),
          });
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

  async hasPotentialOperation(dotdir: string): Promise<boolean> {
    return (
      (await exists(path.join(dotdir, 'rebase-merge'))) ||
      (await exists(path.join(dotdir, 'rebase-apply'))) ||
      (await exists(path.join(dotdir, 'MERGE_HEAD'))) ||
      (await exists(path.join(dotdir, 'CHERRY_PICK_HEAD')))
    );
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
    // Convert absolute path to repo-relative.
    // Resolve symlinks on both sides so that path.relative works correctly
    // even when the caller passes a symlinked path (e.g. /var → /private/var on macOS).
    const root = await this.findRoot(ctx);
    let resolvedFilePath = filePath;
    if (path.isAbsolute(filePath)) {
      try {
        resolvedFilePath = await fs.realpath(filePath);
      } catch {
        // File may not exist at this revision; use the path as-is
      }
    }
    const relativePath = root ? path.relative(root, resolvedFilePath) : resolvedFilePath;
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
    // Convert absolute path to repo-relative for git.
    // Resolve symlinks on both sides so path.relative works on macOS (/var → /private/var).
    const root = await this.findRoot(ctx);
    let resolvedFilePath = filePath;
    if (path.isAbsolute(filePath)) {
      try {
        resolvedFilePath = await fs.realpath(filePath);
      } catch {
        // File may not exist yet; use as-is
      }
    }
    const relativePath = root && path.isAbsolute(resolvedFilePath) ? path.relative(root, resolvedFilePath) : resolvedFilePath;
    const BLAME_TIMEOUT_MS = 300_000; // 5 minutes — blame on large files is slow but shouldn't hang forever
    const result = await this.runCommand(
      ctx,
      ['blame', '--porcelain', '--no-progress', '--no-ignore-revs-file', rev, '--', relativePath],
      undefined,
      BLAME_TIMEOUT_MS,
    );

    return this.parseBlameOutput(result.stdout);
  }

  /**
   * Parse the output of `git blame --porcelain` into an array of
   * `{line, node}` entries.
   *
   * The porcelain format is:
   *   <40-hex-hash> <orig-line> <final-line> <count>
   *   [metadata lines — only present on first occurrence of each hash]
   *   \t<line content>
   *
   * Subsequent occurrences of the same hash omit the metadata block and
   * only emit the hash header + optional filename + content line.
   */
  parseBlameOutput(output: string): Array<{line: string; node: string}> {
    const lines: Array<{line: string; node: string}> = [];
    const outputLines = output.split('\n');

    for (let i = 0; i < outputLines.length; i++) {
      const blameLine = outputLines[i];
      // Blame header lines start with a 40-char hex hash
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
      '--no-ext-diff',
      '--no-textconv',
      '--unified=' + String(contextLines),
    ]);
    return result.stdout;
  }

  async getChangedFiles(ctx: RepositoryContext, hash: Hash): Promise<ChangedFile[]> {
    const result = await this.runCommand(ctx, [
      'diff-tree',
      '--no-commit-id',
      '-r',
      '--no-renames',
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

    const stashLines = stashListOutput.split('\n').filter(Boolean);

    // Fetch file info for all stashes in parallel (capped at 5 concurrent)
    const MAX_CONCURRENT_STASH_SHOW = 5;
    const shelves: ShelvedChange[] = [];
    for (let i = 0; i < stashLines.length; i += MAX_CONCURRENT_STASH_SHOW) {
      const batch = stashLines.slice(i, i + MAX_CONCURRENT_STASH_SHOW);
      const results = await Promise.all(batch.map(async (line) => {
        const [hash, name, dateStr, description] = line.split('\x00');

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

        return {
          hash,
          name,
          date: new Date(dateStr),
          filesSample,
          totalFileCount,
          description: description ?? '',
        } as ShelvedChange;
      }));
      shelves.push(...results);
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
      const args = ['diff', '--stat', '--no-renames', '--no-ext-diff', '--no-textconv', hash + '^', hash];
      if (exclusions.length > 0) {
        args.push('--', '.', ...exclusions);
      }
      const result = await this.runCommand(ctx, args);
      return this.parseSlocFrom(result.stdout);
    } catch {
      // Root commit has no parent; use --root with diff-tree
      try {
        const exclusions = excludeFiles.flatMap(file => [':(exclude)' + file]);
        const args = ['diff-tree', '--stat', '--no-renames', '--root', hash];
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
    includeFiles: string[],
  ): Promise<number | undefined> {
    try {
      const args = ['diff', '--stat', '--no-renames', '--no-ext-diff', '--no-textconv'];
      if (includeFiles.length > 0) {
        args.push('--', ...includeFiles);
      }
      const result = await this.runCommand(ctx, args);
      return this.parseSlocFrom(result.stdout);
    } catch {
      return undefined;
    }
  }

  async getPendingAmendDiffStats(
    ctx: RepositoryContext,
    includeFiles: string[],
  ): Promise<number | undefined> {
    try {
      const args = ['diff', '--stat', '--no-renames', '--no-ext-diff', '--no-textconv', 'HEAD^'];
      if (includeFiles.length > 0) {
        args.push('--', ...includeFiles);
      }
      const result = await this.runCommand(ctx, args);
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
    // Resolve symlinks in cwd and repoRoot so path.relative works correctly
    // (e.g. macOS /tmp -> /private/tmp). Without this, path.relative produces
    // paths like "../../private/tmp/..." that escape the repo.
    let resolvedCwd: string;
    let resolvedRepoRoot: string;
    try {
      resolvedCwd = realpathSync(cwd);
      resolvedRepoRoot = realpathSync(repoRoot);
    } catch {
      resolvedCwd = cwd;
      resolvedRepoRoot = repoRoot;
    }
    // Collect git -c key=value global options separately from the command args.
    // Some operations (e.g. AmendOperation) place config objects before the command
    // in their args list. Processing them into a separate array ensures args[0] is
    // always the command name so the translations below can identify it correctly.
    const configArgs: string[] = [];
    const args: string[] = [];
    for (const arg of operation.args) {
      if (typeof arg === 'object') {
        switch (arg.type) {
          case 'config':
            if (!(settableConfigNames as ReadonlyArray<string>).includes(arg.key)) {
              throw new Error(`config ${arg.key} not allowed`);
            }
            configArgs.push('-c', `${arg.key}=${arg.value}`);
            continue;
          case 'repo-relative-file':
            args.push(path.normalize(path.relative(resolvedCwd, path.join(resolvedRepoRoot, arg.path))));
            continue;
          case 'repo-relative-file-list':
            // Git doesn't have listfile0, pass files individually
            for (const p of arg.paths) {
              args.push(path.normalize(path.relative(resolvedCwd, path.join(resolvedRepoRoot, p))));
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
      const hasAddremove = args.includes('--addremove');
      const filteredArgs = args.slice(1).filter(a => a !== '--addremove');
      // --addremove means stage all tracked modifications/deletions before committing
      const allFlag = hasAddremove ? ['--all'] : [];
      return {args: [...configArgs, 'commit', ...allFlag, ...filteredArgs], stdin};
    }
    if (args[0] === 'amend') {
      // AmendToOperation: sl amend --to <target> [files...]
      const toIdx = args.indexOf('--to');
      if (toIdx !== -1) {
        const target = args[toIdx + 1];
        if (!target) throw new Error('amend --to requires a target commit');
        const files = args.filter((a, i, arr) =>
          a !== 'amend' && a !== '--to' && arr[i - 1] !== '--to',
        );
        const stashFiles = files.length > 0 ? `-- ${files.map(f => `"${f.replace(/"/g, '\\"')}"`).join(' ')}` : '';
        const escapedTarget = target.replace(/"/g, '\\"');

        const script = [
          'set -e',
          `ORIG_BRANCH=$(git symbolic-ref --short HEAD 2>/dev/null || true)`,
          `ORIG_TIP=$(git rev-parse HEAD)`,
          `TARGET_SHA=$(git rev-parse "${escapedTarget}")`,
          `git stash push ${stashFiles}`,
          `git checkout "${escapedTarget}"`,
          `git stash pop`,
          files.length > 0
            ? `git add ${files.map(f => `"${f.replace(/"/g, '\\"')}"`).join(' ')}`
            : `git add -A`,
          `git commit --amend --no-edit`,
          `NEW_TARGET=$(git rev-parse HEAD)`,
          // If there were commits above the target, rebase them onto the new amended commit.
          // Use `if !` to capture rebase failure so we can abort cleanly (POSIX sh, no trap needed).
          `if [ "$ORIG_TIP" != "$TARGET_SHA" ]; then`,
          // $NEW_TARGET, $TARGET_SHA, $ORIG_TIP, $NEW_TIP are intentionally unquoted — single SHAs, word-split is harmless
          `  if ! git rebase --update-refs --onto $NEW_TARGET $TARGET_SHA $ORIG_TIP; then`,
          `    git rebase --abort 2>/dev/null || true`,
          `    exit 1`,
          `  fi`,
          `  NEW_TIP=$(git rev-parse HEAD)`,
          `  if [ -n "$ORIG_BRANCH" ]; then git branch -f "$ORIG_BRANCH" $NEW_TIP && git checkout "$ORIG_BRANCH"; else git checkout --detach $NEW_TIP; fi`,
          `else`,
          // HEAD case: force-update branch pointer to new amended commit
          `  if [ -n "$ORIG_BRANCH" ]; then git branch -f "$ORIG_BRANCH" $NEW_TARGET && git checkout "$ORIG_BRANCH"; else git checkout --detach $NEW_TARGET; fi`,
          `fi`,
        ].join('\n');

        return {args: ['__shell__', script], stdin};
      }

      const out: string[] = [...configArgs, 'commit', '--amend'];
      let hasMessage = false;
      for (let i = 1; i < args.length; i++) {
        if (args[i] === '--addremove') continue;
        if (args[i] === '--user') { out.push('--author', args[++i]); continue; }
        if (args[i] === '--message') hasMessage = true;
        out.push(args[i]);
      }
      // Without --message, git commit --amend would open an editor. Use --no-edit
      // to reuse the existing commit message without invoking any editor.
      if (!hasMessage) out.push('--no-edit');
      return {args: out, stdin};
    }
    if (args[0] === 'metaedit') {
      let hash: string | undefined;
      let msg: string | undefined;
      let author: string | undefined;
      for (let i = 1; i < args.length; i++) {
        if (args[i] === '--rev' && i + 1 < args.length) hash = args[++i];
        else if (args[i] === '--message' && i + 1 < args.length) msg = args[++i];
        else if (args[i] === '--user' && i + 1 < args.length) author = args[++i];
      }
      if (!msg) throw new Error('metaedit requires --message');

      const escapedMsg = msg.replace(/'/g, "'\\''");
      const authorFlag = author ? ` --author '${author.replace(/'/g, "'\\''")}'` : '';
      // TARGET is either the specified hash or HEAD (for HEAD-only amend)
      const targetRef = hash ?? 'HEAD';

      // Strategy (matches FoldOperation pattern for non-HEAD operations):
      // 1. Save current branch and HEAD tip
      // 2. Resolve target to full SHA (for reliable comparison)
      // 3. Check out the target commit
      // 4. Amend its message
      // 5. If HEAD was above the target, rebase the stack onto the new amended commit
      // 6. Restore the branch pointer
      const script = [
        'set -e',
        `ORIG_BRANCH=$(git symbolic-ref --short HEAD 2>/dev/null || true)`,
        `ORIG_TIP=$(git rev-parse HEAD)`,
        // Resolve target to full SHA so we can compare with ORIG_TIP
        `TARGET_SHA=$(git rev-parse "${targetRef}")`,
        `git checkout "${targetRef}"`,
        `git commit --amend --only --message '${escapedMsg}'${authorFlag}`,
        `NEW_HASH=$(git rev-parse HEAD)`,
        // Only rebase stack if there were commits above the target
        `if [ "$ORIG_TIP" != "$TARGET_SHA" ]; then`,
        // $NEW_HASH, $TARGET_SHA, $ORIG_TIP are intentionally unquoted — single SHAs, word-split is harmless
        `  if ! git rebase --update-refs --onto $NEW_HASH $TARGET_SHA $ORIG_TIP; then`,
        `    git rebase --abort 2>/dev/null || true`,
        `    exit 1`,
        `  fi`,
        `  NEW_TIP=$(git rev-parse HEAD)`,
        `  if [ -n "$ORIG_BRANCH" ]; then git branch -f "$ORIG_BRANCH" $NEW_TIP && git checkout "$ORIG_BRANCH"; else git checkout --detach $NEW_TIP; fi`,
        `else`,
        // branch -f needed: if targetRef was a SHA (not "HEAD"), checkout detaches HEAD;
        // amend creates NEW_HASH in detached state but branch still points at old SHA
        `  # Force-update branch: if target was a SHA (not "HEAD"), checkout detaches HEAD`,
        `  # and amend creates NEW_HASH in detached state without moving the branch pointer`,
        `  if [ -n "$ORIG_BRANCH" ]; then git branch -f "$ORIG_BRANCH" $NEW_HASH && git checkout "$ORIG_BRANCH"; else git checkout --detach $NEW_HASH; fi`,
        `fi`,
      ].join('\n');

      return {args: ['__shell__', script], stdin};
    }
    if (args[0] === 'goto') {
      if (args.includes('--clean')) {
        // Discard all working directory changes
        const files = args.filter(a => a !== 'goto' && a !== '--clean');
        return {args: ['checkout', '--', ...files], stdin};
      }
      // goto --rev HASH → stash if dirty, checkout, then pop stash
      const revIdx = args.indexOf('--rev');
      const hash = revIdx !== -1 ? args[revIdx + 1] : args[1];
      if (!hash) throw new Error('goto requires --rev');

      // Note: if the stashed changes conflict with the target commit, stash pop
      // will leave the working directory in a conflicted state (set -e aborts at pop).
      // This is a known limitation of the git stash approach; tracking as a follow-up.
      const script = [
        'set -e',
        // Count tracked changed files (exclude untracked ??); -gt 0 means stash needed
        'HAS_CHANGES=$(git --no-optional-locks status --porcelain | grep -v "^??" | wc -l | tr -d " ")',
        `if [ "$HAS_CHANGES" -gt 0 ]; then`,
        `  git stash push`,
        `  git checkout "${hash}"`,
        `  git stash pop`,
        `else`,
        `  git checkout "${hash}"`,
        `fi`,
      ].join('\n');
      return {args: ['__shell__', script], stdin};
    }
    if (args[0] === 'revert') {
      const revIdx = args.indexOf('--rev');
      const hash = revIdx !== -1 ? args[revIdx + 1] : 'HEAD';
      const files = args.slice(1).filter((a, i, arr) =>
        a !== '--rev' && arr[i - 1] !== '--rev'
      );
      return {args: ['checkout', hash, '--', ...files], stdin};
    }
    if (args[0] === 'addremove') {
      // `sl addremove [files]` → `git add -- <files>` or `git add -A` for all
      // git add handles both untracked (?) and deleted (!) files correctly
      const files = args.slice(1);
      if (files.length > 0) {
        return {args: ['add', '--', ...files], stdin};
      } else {
        return {args: ['add', '-A'], stdin};
      }
    }
    if (args[0] === 'forget') {
      // `sl forget <file>` → `git rm --cached <file>`
      return {args: ['rm', '--cached', ...args.slice(1)], stdin};
    }
    if (args[0] === 'fold') {
      return this.translateFoldToGit(args, stdin);
    }
    if (args[0] === 'hide') {
      return this.translateHideToGit(args, stdin);
    }
    if (args[0] === 'pull') {
      if (args.includes('--rev')) {
        return this.translatePullRevToGit(args);
      }
      // Plain pull = fetch only (do not merge into working directory)
      return {args: ['fetch', '--all'], stdin};
    }
    if (args[0] === 'bookmark') {
      if (args[1] === '--delete') {
        return {args: ['branch', '-d', args[2]], stdin};
      }
      if (args[1] === '--move') {
        // bookmark --move NAME --rev HASH → git branch -f NAME HASH
        const name = args[2];
        const revIdx = args.indexOf('--rev');
        const hash = revIdx !== -1 ? args[revIdx + 1] : 'HEAD';
        return {args: ['branch', '-f', name, hash], stdin};
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
      // --abort: detect which operation is in progress and abort it.
      // Uses git rev-parse --git-path to resolve paths correctly in git worktrees,
      // where .git is a file (not a directory) pointing to the actual git dir.
      if (args.includes('--abort')) {
        // Note: git's internal directory names are lowercase (rebase-merge, rebase-apply)
        // while sentinel files are uppercase (MERGE_HEAD, CHERRY_PICK_HEAD).
        const script =
          'REBASE_MERGE=$(git rev-parse --git-path rebase-merge); ' +
          'REBASE_APPLY=$(git rev-parse --git-path rebase-apply); ' +
          'MERGE_HEAD=$(git rev-parse --git-path MERGE_HEAD); ' +
          'CHERRY_PICK_HEAD=$(git rev-parse --git-path CHERRY_PICK_HEAD); ' +
          'if [ -d "$REBASE_MERGE" ] || [ -d "$REBASE_APPLY" ]; then git rebase --abort; ' +
          'elif [ -f "$MERGE_HEAD" ]; then git merge --abort; ' +
          'elif [ -f "$CHERRY_PICK_HEAD" ]; then git cherry-pick --abort; ' +
          'else echo "No operation in progress" && exit 1; fi';
        return {args: ['__shell__', script], stdin};
      }
      // --quit: save already-rebased commits, then abort (approximates sl rebase --quit).
      // Uses git rev-parse --git-path for worktree-safe path resolution.
      if (args.includes('--quit')) {
        // Note: $REWRITTEN is intentionally unquoted so the shell word-splits the
        // space-separated commit hashes into individual cherry-pick arguments.
        const script =
          'REBASE_MERGE=$(git rev-parse --git-path rebase-merge); ' +
          'REWRITTEN=$(cat "$REBASE_MERGE/rewritten-list" 2>/dev/null | awk \'{print $2}\' | tr \'\\n\' \' \') && ' +
          'git rebase --abort && ' +
          'if [ -n "$REWRITTEN" ]; then git cherry-pick $REWRITTEN; fi';
        return {args: ['__shell__', script], stdin};
      }
      if (args.includes('--keep')) {
        const revIdx = args.indexOf('--rev');
        const src = revIdx !== -1 ? args[revIdx + 1] : undefined;
        let dest: string | undefined;
        for (let i = 1; i < args.length; i++) {
          if ((args[i] === '--dest' || args[i] === '-d') && i + 1 < args.length) dest = args[++i];
        }
        if (!src) throw new Error('rebase --keep requires --rev');
        if (dest) {
          // Quote src and dest to prevent shell injection
          return {args: ['__shell__', `git checkout "${dest}" && git cherry-pick "${src}"`], stdin};
        }
        return {args: ['cherry-pick', src], stdin};
      }
      // BulkRebaseOperation: sl rebase --rev SRC1 --rev SRC2 -d DEST
      // (uses --rev, not -s; means cherry-pick each rev onto dest)
      if (args.includes('--rev') && !args.includes('-s') && !args.includes('--source')) {
        const revs: string[] = [];
        let dest: string | undefined;
        for (let i = 1; i < args.length; i++) {
          if (args[i] === '--rev' && i + 1 < args.length) revs.push(args[++i]);
          else if ((args[i] === '-d' || args[i] === '--dest') && i + 1 < args.length) dest = args[++i];
        }
        if (!dest) throw new Error('rebase --rev requires -d <dest>');
        if (revs.length === 0) throw new Error('rebase --rev requires at least one --rev');
        const script = `git checkout "${dest}" && git cherry-pick ${revs.map(r => `"${r}"`).join(' ')}`;
        return {args: ['__shell__', script], stdin};
      }
      // Standard rebase: -s SRC -d DEST → rebase --onto DEST SRC^ SRC
      let src: string | undefined;
      let dest: string | undefined;
      for (let i = 1; i < args.length; i++) {
        if ((args[i] === '-s' || args[i] === '--source') && i + 1 < args.length) src = args[++i];
        else if ((args[i] === '-d' || args[i] === '--dest') && i + 1 < args.length) dest = args[++i];
      }
      if (!src || !dest) throw new Error('rebase requires -s and -d');

      // RebaseAllDraftCommitsOperation: src is a Sapling revset like draft() or draft()&date(-N)
      // Note: draft()&date(-N) is accepted but the date filter is intentionally not applied —
      // git has no revset equivalent. We rebase all local (draft) commits regardless of age.
      if (src.startsWith('draft()')) {
        // "draft commits" = commits not yet on any remote tracking branch
        // Find the merge-base with origin, then rebase everything above it
        const script =
          `BASE=$(git merge-base HEAD origin/HEAD 2>/dev/null || ` +
          `git merge-base HEAD origin/main 2>/dev/null || ` +
          `git merge-base HEAD origin/master 2>/dev/null || ` +
          `git rev-list --max-parents=0 HEAD | tail -1) && [ -n "$BASE" ] && ` +
          `git rebase --update-refs --onto "${dest}" $BASE HEAD`;
        // $BASE is intentionally unquoted — it is a single SHA and must word-split for git rebase
        return {args: ['__shell__', script], stdin};
      }

      // Sapling's -s means "source and all descendants". Git's rebase --onto needs
      // an explicit endpoint. Find the branch tip that descends from SRC so the
      // entire stack is rebased, not just the single source commit.
      const escapedSrc = src.replace(/"/g, '\\"');
      const escapedDest = dest.replace(/"/g, '\\"');
      const script = [
        'set -e',
        `SRC="${escapedSrc}"`,
        `DEST="${escapedDest}"`,
        // Find branch tip: look for a local branch whose tip is a strict descendant of SRC.
        // git branch --contains lists branches that have SRC in their history;
        // git merge-base --is-ancestor SRC TIP confirms TIP descends from SRC.
        'TIP=""',
        'for hash in $(git branch --contains "$SRC" --format="%(objectname)"); do',
        '  if [ "$hash" != "$SRC" ] && git merge-base --is-ancestor "$SRC" "$hash" 2>/dev/null; then',
        '    TIP="$hash"',
        '    break',
        '  fi',
        'done',
        // If no descendant found, SRC is the tip itself (leaf commit)
        'if [ -z "$TIP" ]; then TIP="$SRC"; fi',
        // --update-refs moves any branch pointers within the rebased range
        'git rebase --update-refs --onto "$DEST" "$SRC"^ "$TIP"',
      ].join('\n');
      return {args: ['__shell__', script], stdin};
    }
    if (args[0] === 'graft') {
      return {args: ['cherry-pick', ...args.slice(1)], stdin};
    }
    if (args[0] === 'uncommit') {
      return {args: ['reset', '--soft', 'HEAD~1'], stdin};
    }
    if (args[0] === 'resolve') {
      if (args.includes('--mark')) {
        const files = args.filter(a => a !== 'resolve' && a !== '--mark');
        // Use a shell script to handle both existing files (git add) and
        // deleted files (git rm) — e.g. rename conflicts where the original
        // file no longer exists on disk.
        const fileArgs = files.map(f => `"${String(f).replace(/"/g, '\\"')}"`).join(' ');
        const script = `for f in ${fileArgs}; do if [ -e "$f" ]; then git add -- "$f"; else git rm -f -- "$f" 2>/dev/null || true; fi; done`;
        return {args: ['__shell__', script], stdin};
      }
      if (args.includes('--unmark')) {
        const files = args.filter(a => a !== 'resolve' && a !== '--unmark');
        return {args: ['rm', '--cached', ...files], stdin};
      }
      // resolve --tool internal:dumpjson --all (conflict detection, not a user action)
      if (args.includes('--tool') && args[args.indexOf('--tool') + 1] === 'internal:dumpjson') {
        return {args, stdin};
      }
      const toolIdx = args.indexOf('--tool');
      const hasAll = args.includes('--all');
      if (toolIdx !== -1) {
        const tool = args[toolIdx + 1];
        if (!tool) throw new Error('resolve --tool requires a tool name');
        // Find file arg: last positional that isn't a flag or the tool value
        const fileArgs = args.filter((a, i) =>
          a !== 'resolve' && a !== '--tool' && a !== tool && a !== '--all' &&
          !String(a).startsWith('-') && i !== toolIdx + 1
        );
        const file = fileArgs[0];
        if (tool === 'internal:merge-local' || tool === 'internal:merge-other' || tool === 'internal:union') {
          if (!file) throw new Error(`resolve --tool ${tool} requires a file argument`);
        }
        if (tool === 'internal:merge-local') {
          const escapedFile = String(file).replace(/"/g, '\\"');
          // For delete/modify conflicts, --ours may fail if our side deleted the file.
          // In that case, "take ours" means accept the deletion (git rm).
          const script = [
            'set -e',
            `FILE="${escapedFile}"`,
            'if git checkout --ours -- "$FILE" 2>/dev/null; then',
            '  git add "$FILE"',
            'else',
            '  git rm -f "$FILE" 2>/dev/null || git add "$FILE"',
            'fi',
          ].join('\n');
          return {args: ['__shell__', script], stdin};
        }
        if (tool === 'internal:merge-other') {
          const escapedFile = String(file).replace(/"/g, '\\"');
          // For delete/modify conflicts, --theirs may fail if their side deleted the file.
          // In that case, "take theirs" means accept the deletion (git rm).
          const script = [
            'set -e',
            `FILE="${escapedFile}"`,
            'if git checkout --theirs -- "$FILE" 2>/dev/null; then',
            '  git add "$FILE"',
            'else',
            '  git rm -f "$FILE" 2>/dev/null || git add "$FILE"',
            'fi',
          ].join('\n');
          return {args: ['__shell__', script], stdin};
        }
        if (tool === 'internal:union') {
          const escapedFile = String(file).replace(/"/g, '\\"');
          const script = [
            'set -e',
            `FILE="${escapedFile}"`,
            // Check if the file is LFS-tracked by inspecting the "ours" stage for a pointer header.
            // If so, skip the three-way merge (which would corrupt the pointer) and just keep ours.
            'OURS_CONTENT=$(git show :2:"$FILE")',
            'if echo "$OURS_CONTENT" | head -1 | grep -q "^version https://git-lfs"; then',
            '  echo "$OURS_CONTENT" > "$FILE"',
            '  git add "$FILE"',
            '  exit 0',
            'fi',
            'TMPBASE=$(mktemp -t git-isl-union)',
            'trap \'rm -f "$TMPBASE-ours" "$TMPBASE-base" "$TMPBASE-theirs"\' EXIT',
            'echo "$OURS_CONTENT" > "$TMPBASE-ours"',
            'git show :1:"$FILE" > "$TMPBASE-base"',
            'git show :3:"$FILE" > "$TMPBASE-theirs"',
            'git merge-file --union "$TMPBASE-ours" "$TMPBASE-base" "$TMPBASE-theirs" || true',
            'cp "$TMPBASE-ours" "$FILE"',
            'git add "$FILE"',
          ].join('\n');
          return {args: ['__shell__', script], stdin};
        }
        // External merge tool: git mergetool --tool=<tool> [<file>]
        const escapedTool = tool.replace(/'/g, "'\\''");
        if (hasAll || file === undefined) {
          const script = `git mergetool --tool='${escapedTool}'`;
          return {args: ['__shell__', script], stdin};
        }
        const escapedFile = String(file).replace(/"/g, '\\"');
        const script = `git mergetool --tool='${escapedTool}' "${escapedFile}"`;
        return {args: ['__shell__', script], stdin};
      }
      // resolve --all (no --tool): run mergetool on all unresolved files
      if (hasAll) {
        return {args: ['__shell__', 'git mergetool'], stdin};
      }
      return {args, stdin};
    }
    if (args[0] === 'continue') {
      // Detect which operation is in progress and run the correct --continue command.
      // Use git rev-parse --git-path for worktree safety (avoids hardcoded .git/ paths).
      // Note: git's internal directory names are lowercase (rebase-merge, rebase-apply)
      // while sentinel files are uppercase (MERGE_HEAD, CHERRY_PICK_HEAD).
      const script =
        'REBASE_MERGE=$(git rev-parse --git-path rebase-merge); ' +
        'REBASE_APPLY=$(git rev-parse --git-path rebase-apply); ' +
        'MERGE_HEAD=$(git rev-parse --git-path MERGE_HEAD); ' +
        'CHERRY_PICK_HEAD=$(git rev-parse --git-path CHERRY_PICK_HEAD); ' +
        'if [ -d "$REBASE_MERGE" ] || [ -d "$REBASE_APPLY" ]; then GIT_EDITOR=true git rebase --continue; ' +
        // git merge --continue is equivalent but git commit --no-edit works on Git < 2.12
        'elif [ -f "$MERGE_HEAD" ]; then git commit --no-edit; ' +
        'elif [ -f "$CHERRY_PICK_HEAD" ]; then GIT_EDITOR=true git cherry-pick --continue; ' +
        'else echo "No operation in progress" && exit 1; fi';
      return {args: ['__shell__', script], stdin};
    }
    if (args[0] === 'purge') {
      const files = args.filter(a => a !== 'purge' && a !== '--files' && a !== '--abort-on-err');
      const rmCmds = files.map(f => `rm -f "${f}"`).join(' && ');
      return {args: ['__shell__', rmCmds || 'true'], stdin};
    }
    if (args[0] === 'push') {
      let rev: string | undefined, branch: string | undefined, remote: string | undefined;
      for (let i = 1; i < args.length; i++) {
        if (args[i] === '--rev' && i + 1 < args.length) rev = args[++i];
        else if (args[i] === '--to' && i + 1 < args.length) branch = args[++i];
        else if (!args[i].startsWith('-')) remote = args[i];
      }
      if (rev && branch) {
        return {args: ['push', remote ?? 'origin', `${rev}:${branch}`], stdin};
      }
      return {args: [...configArgs, ...args], stdin};
    }

    return {args: [...configArgs, ...args], stdin};
  }

  /**
   * Translate `fold --exact BOTTOM::TOP --message MSG` into a shell script that:
   * 1. Saves the current branch and HEAD tip
   * 2. Detaches at TOP and collapses down to BOTTOM^ using reset --soft
   * 3. Commits the folded result with the provided message
   * 4. If there were commits above TOP, rebases them onto the new folded commit
   * 5. Restores the branch pointer
   *
   * This approach limits the squash to exactly the BOTTOM::TOP range, avoiding
   * the bug where `rebase -i BOTTOM^` would include commits above TOP (e.g. HEAD).
   */
  private translateFoldToGit(args: string[], stdin: string | undefined): ResolvedCommand {
    const exactIdx = args.indexOf('--exact');
    const msgIdx = args.indexOf('--message');
    if (exactIdx === -1 || msgIdx === -1) {
      throw new Error('fold requires --exact <revset> and --message <msg>');
    }

    const revset = String(args[exactIdx + 1]);
    const msg = String(args[msgIdx + 1]);
    const parts = revset.split('::');
    if (parts.length !== 2) throw new Error(`fold: unsupported revset format: ${revset}`);

    const [bottomHash, topHash] = parts;
    // Escape single quotes in message for shell
    const escapedMsg = msg.replace(/'/g, "'\\''");

    // Strategy:
    // 1. Save the current branch name and HEAD tip
    // 2. Detach at topHash and collapse down to bottomHash^
    // 3. Commit the folded result
    // 4. If there were commits above topHash, rebase them onto the new fold
    // 5. Restore the branch pointer
    const script = [
      `ORIG_BRANCH=$(git symbolic-ref --short HEAD 2>/dev/null || true)`,
      `ORIG_TIP=$(git rev-parse HEAD)`,
      `TOP_SHA=$(git rev-parse "${topHash}")`,
      // $FOLD, $ORIG_TIP, $NEW_TIP and $TOP_SHA are intentionally unquoted — they are
      // single 40-char SHAs from git rev-parse; word-splitting is harmless and required
      // as positional arguments to git commands.
      `git checkout "${topHash}"`,
      `git reset --soft "${bottomHash}^"`,
      `git commit --message '${escapedMsg}'`,
      `FOLD=$(git rev-parse HEAD)`,
      // Only rebase if there were commits above topHash
      `if [ "$ORIG_TIP" != "$TOP_SHA" ]; then`,
      `  if ! git rebase --update-refs --onto $FOLD "${topHash}" $ORIG_TIP; then`,
      `    git rebase --abort 2>/dev/null || true`,
      `    exit 1`,
      `  fi`,
      `  NEW_TIP=$(git rev-parse HEAD)`,
      `  if [ -n "$ORIG_BRANCH" ]; then git branch -f "$ORIG_BRANCH" $NEW_TIP && git checkout "$ORIG_BRANCH"; else git checkout --detach $NEW_TIP; fi`,
      `else`,
      `  if [ -n "$ORIG_BRANCH" ]; then git branch -f "$ORIG_BRANCH" $FOLD && git checkout "$ORIG_BRANCH"; fi`,
      `fi`,
    ].join('\n');

    return {args: ['__shell__', script], stdin};
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
   * Finds all local branches that contain the hash anywhere in their history
   * via `git branch --contains` and deletes them. If the currently checked-out
   * branch is one being deleted, detaches HEAD to the hidden commit's parent first.
   */
  private translateHideToGit(args: string[], stdin: string | undefined): ResolvedCommand {
    const revIdx = args.indexOf('--rev');
    if (revIdx === -1) throw new Error('hide requires --rev <hash>');
    const hash = args[revIdx + 1];
    if (!hash) throw new Error('hide --rev requires a hash value');

    const script = [
      // Collect the list of branches to delete (contains the hidden commit anywhere in history)
      `BRANCHES=$(git branch --contains "${hash}" --format='%(refname:short)' 2>/dev/null)`,
      // Get the current branch name (empty string if in detached HEAD state)
      `CURRENT=$(git symbolic-ref --short HEAD 2>/dev/null || echo '')`,
      // If the current branch is in the delete list, detach HEAD to the parent first
      `if [ -n "$CURRENT" ] && echo "$BRANCHES" | grep -qxF "$CURRENT"; then git checkout --detach "${hash}^"; fi`,
      // Delete each branch in the list
      `echo "$BRANCHES" | while IFS= read -r b; do if [ -n "$b" ]; then git branch -D "$b"; fi; done`,
    ].join(' && ');

    return {args: ['__shell__', script], stdin};
  }

  getExecParams(
    args_: string[],
    cwd: string,
    options_?: EjecaOptions,
    env?: Record<string, string>,
  ): {command: string; args: string[]; options: EjecaOptions} {
    // Strip Sapling-specific global flags that git doesn't support.
    // Repository.runOperation may prepend --verbose or --debug for sl, but
    // git only accepts a small set of global options (not --verbose/--debug).
    const args = [...args_];
    while (args.length > 0 && (args[0] === '--verbose' || args[0] === '--debug')) {
      args.shift();
    }

    const newEnv = {
      GIT_EDITOR: 'false',
      ...options_?.env,
      ...env,
      GIT_TERMINAL_PROMPT: '0',
      GIT_LFS_SKIP_SMUDGE: '1',
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

    return {command: this.command, args: ['--no-optional-locks', ...args], options};
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

    // Prioritize working tree changes, fall back to index.
    // In porcelain v2:  X = index vs HEAD,  Y = working-tree vs index
    if (workTree === 'M') {
      return 'M';
    }
    if (workTree === 'D') {
      // File is missing from disk but the deletion has NOT been staged yet.
      // This is Sapling's '!' (missing), not 'R' (staged removal).
      return '!';
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
      // Deletion is staged in the index — this is Sapling's 'R' (removed).
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

/**
 * Map git's porcelain v2 unmerged XY status to ConflictType.
 *
 * In rebase context: "ours" (X) = destination (where we're rebasing onto),
 * "theirs" (Y) = source (the commits being rebased).
 */
function gitConflictXYToType(xy: string): ConflictType {
  switch (xy) {
    case 'AA':
      return ConflictType.BothAdded;
    case 'DD':
      return ConflictType.BothDeleted;
    case 'DU':
      return ConflictType.DeletedByDest;
    case 'UD':
      return ConflictType.DeletedBySource;
    case 'AU':
      return ConflictType.AddedByDest;
    case 'UA':
      return ConflictType.AddedBySource;
    default:
      // UU and anything unexpected
      return ConflictType.BothChanged;
  }
}
