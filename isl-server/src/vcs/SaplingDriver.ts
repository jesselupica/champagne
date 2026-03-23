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
  CommitCloudBackupStatus as CommitCloudBackupStatusType,
  ConfigName,
  Hash,
  MergeConflicts,
  PreferredSubmitCommand,
  RepoInfo,
  RepoRelativePath,
  RunnableOperation,
  SettableConfigName,
  ShelvedChange,
  SubmodulesByRoot,
  Submodule,
  UncommittedChanges,
  ValidatedRepoInfo,
} from 'isl/src/types';
import type {Comparison} from 'shared/Comparison';
import type {EjecaOptions, EjecaReturn} from 'shared/ejeca';
import type {ExportStack, ImportStack} from 'shared/types/stack';
import type {RepositoryContext} from '../serverTypes';
import type {VCSDriver} from './VCSDriver';
import type {
  ConfigScope,
  FetchCommitsOptions,
  ResolvedCommand,
  VCSCapabilities,
  WatchConfig,
} from './types';
import type {ResolveCommandConflictOutput} from '../commands';

import {
  CommitCloudBackupStatus,
  settableConfigNames,
} from 'isl/src/types';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {revsetArgsForComparison} from 'shared/Comparison';
import {ejeca} from 'shared/ejeca';
import {exists} from 'shared/fs';
import {removeLeadingPathSep} from 'shared/pathUtils';
import {notEmpty, nullthrows} from 'shared/utils';
import {Internal} from '../Internal';
import {parseAlerts} from '../alerts';
import {
  MAX_FETCHED_FILES_PER_COMMIT,
  READ_COMMAND_TIMEOUT_MS,
  computeNewConflicts,
  extractRepoInfoFromUrl,
} from '../commands';
import {
  CHANGED_FILES_FIELDS,
  CHANGED_FILES_INDEX,
  CHANGED_FILES_TEMPLATE,
  COMMIT_END_MARK,
  SHELVE_FETCH_TEMPLATE,
  attachStableLocations,
  findMaxCommonPathPrefix,
  getMainFetchTemplate,
  parseCommitInfoOutput,
  parseShelvedCommitsOutput,
} from '../templates';
import {isEjecaError} from '../utils';
import {isGithubEnterprise} from '../github/queryGraphQL';
import {simplifyEjecaError} from 'shared/ejeca';

/**
 * VCS Driver for Sapling SCM.
 *
 * This is the reference implementation. All other drivers model their behavior
 * after what Sapling provides.
 */
export class SaplingDriver implements VCSDriver {
  readonly name = 'Sapling';
  readonly command = 'sl';

  readonly capabilities: VCSCapabilities = {
    smartlog: true,
    commitPhases: true,
    bookmarks: true,
    amend: true,
    partialCommit: true,
    partialAmend: true,
    rebase: true,
    fold: true,
    hide: true,
    shelve: true,
    graft: true,
    goto: true,
    stackOperations: true,
    commitCloud: true,
    submodules: true,
    alerts: true,
    debugInfo: true,
    mutationTracking: true,
    push: true,
    pullRevision: true,
    submitCommands: [
      {name: 'pr', command: ['pr', 'submit'], supportsDraft: true, supportsUpdateMessage: true},
      {
        name: 'ghstack',
        command: ['ghstack', 'submit'],
        supportsDraft: true,
        supportsUpdateMessage: true,
      },
    ],
  };

  // ── Repository Detection ──────────────────────────────

  async findRoot(ctx: RepositoryContext): Promise<AbsolutePath | undefined> {
    try {
      return (await this.runCommand(ctx, ['root'])).stdout;
    } catch (error) {
      if (
        ['ENOENT', 'EACCES'].includes((error as {code: string}).code) ||
        (os.platform() === 'win32' && (error as {exitCode: number}).exitCode === 1)
      ) {
        ctx.logger.error(`command ${ctx.cmd} not found`, error);
        throw error;
      }
      return undefined;
    }
  }

  async findRoots(ctx: RepositoryContext): Promise<AbsolutePath[] | undefined> {
    try {
      return (await this.runCommand(ctx, ['debugroots'])).stdout.split('\n').reverse();
    } catch (error) {
      ctx.logger.error(`Failed to find repository roots starting from ${ctx.cwd}`, error);
      return undefined;
    }
  }

  async findDotDir(ctx: RepositoryContext): Promise<AbsolutePath | undefined> {
    try {
      return (await this.runCommand(ctx, ['root', '--dotdir'])).stdout;
    } catch (error) {
      ctx.logger.error(`Failed to find repository dotdir in ${ctx.cwd}`, error);
      return undefined;
    }
  }

  async validateRepo(ctx: RepositoryContext): Promise<RepoInfo> {
    const {cmd, cwd, logger} = ctx;
    const [repoRoot, repoRoots, dotdir, configs] = await Promise.all([
      this.findRoot(ctx).catch((err: Error) => err),
      this.findRoots(ctx),
      this.findDotDir(ctx),
      this.getConfigs(ctx, [
        'paths.default',
        'github.pull_request_domain',
        'github.preferred_submit_command',
        'phrevset.callsign',
      ] as const),
    ]);
    const pathsDefault = configs.get('paths.default') ?? '';
    const preferredSubmitCommand = configs.get('github.preferred_submit_command');

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

    let codeReviewSystem: CodeReviewSystem;
    let pullRequestDomain;
    if (Internal.isMononokePath?.(pathsDefault)) {
      const repo = pathsDefault.slice(pathsDefault.lastIndexOf('/') + 1);
      codeReviewSystem = {type: 'phabricator', repo, callsign: configs.get('phrevset.callsign')};
    } else if (pathsDefault === '') {
      codeReviewSystem = {type: 'none'};
    } else {
      const repoInfo = extractRepoInfoFromUrl(pathsDefault);
      if (
        repoInfo != null &&
        (repoInfo.hostname === 'github.com' || (await isGithubEnterprise(repoInfo.hostname)))
      ) {
        const {owner, repo, hostname} = repoInfo;
        codeReviewSystem = {type: 'github', owner, repo, hostname};
      } else {
        codeReviewSystem = {type: 'unknown', path: pathsDefault};
      }
      pullRequestDomain = configs.get('github.pull_request_domain');
    }

    // Check for EdenFS
    const isEdenFs = await exists(path.join(repoRoot as string, '.eden'));

    const result: RepoInfo = {
      type: 'success',
      command: cmd,
      dotdir,
      repoRoot,
      repoRoots,
      codeReviewSystem,
      pullRequestDomain,
      preferredSubmitCommand: preferredSubmitCommand as PreferredSubmitCommand | undefined,
      isEdenFs,
    };
    logger.info('repo info: ', result);
    return result;
  }

  // ── Data Fetching ─────────────────────────────────────

  async fetchCommits(
    ctx: RepositoryContext,
    codeReviewSystem: CodeReviewSystem,
    options: FetchCommitsOptions,
  ): Promise<CommitInfo[]> {
    const {maxDraftDays, stableLocations, recommendedBookmarks, additionalRevsetFragments} =
      options;

    const primaryRevset = '(interestingbookmarks() + heads(draft()))';
    const revset = `smartlog(${[
      maxDraftDays == null
        ? primaryRevset
        : `(${primaryRevset} & date(-${maxDraftDays}))`,
      '.', // always include wdir parent
      ...stableLocations.map(location => `present(${location.hash})`),
      ...recommendedBookmarks.map(bookmark => `present(${bookmark})`),
      ...(additionalRevsetFragments ?? []),
    ]
      .filter(notEmpty)
      .join(' + ')})`;

    const template = getMainFetchTemplate(codeReviewSystem);

    const proc = await this.runCommand(ctx, ['log', '--template', template, '--rev', revset]);
    const commits = parseCommitInfoOutput(ctx.logger, proc.stdout.trim(), codeReviewSystem);

    attachStableLocations(commits, stableLocations);

    // For git-backed repos, ensure the main/master branch appears as a bookmark.
    // Sapling doesn't report the default git branch (e.g. "main") as a bookmark,
    // so we detect it from git and inject it.
    await this.injectGitMainBranchBookmark(ctx, commits);

    return commits;
  }

  /**
   * Detect the git main/master branch and add it as a bookmark on the matching commit.
   * Sapling doesn't expose the default git branch as a bookmark, so we read it from git directly.
   */
  private async injectGitMainBranchBookmark(
    ctx: RepositoryContext,
    commits: CommitInfo[],
  ): Promise<void> {
    try {
      // Get the default branch name (e.g. "main" or "master")
      const branchResult = await ejeca('git', ['symbolic-ref', '--short', 'HEAD'], {
        cwd: ctx.cwd,
      });
      const branchName = branchResult.stdout.trim();
      if (!branchName) {
        return;
      }

      // Check if any commit already has this as a bookmark
      const alreadyHasBookmark = commits.some(
        c =>
          c.bookmarks.includes(branchName) ||
          c.remoteBookmarks.includes(branchName) ||
          c.remoteBookmarks.includes(`remote/${branchName}`),
      );
      if (alreadyHasBookmark) {
        return;
      }

      // Get the hash this branch points to
      const hashResult = await ejeca('git', ['rev-parse', branchName], {
        cwd: ctx.cwd,
      });
      const branchHash = hashResult.stdout.trim();

      // Find the commit and add the bookmark
      const commit = commits.find(c => c.hash === branchHash);
      if (commit) {
        commit.bookmarks = [...commit.bookmarks, branchName];
      }
    } catch {
      // Not a git repo or git not available — skip silently
    }
  }

  async fetchStatus(ctx: RepositoryContext): Promise<ChangedFile[]> {
    const proc = await this.runCommand(ctx, ['status', '-Tjson', '--copies']);
    const files = (JSON.parse(proc.stdout) as UncommittedChanges).map(change => ({
      ...change,
      path: removeLeadingPathSep(change.path),
    }));
    return files;
  }

  async checkMergeConflicts(
    ctx: RepositoryContext,
    previousConflicts: MergeConflicts | undefined,
  ): Promise<MergeConflicts | undefined> {
    let output: ResolveCommandConflictOutput;
    const fetchStartTimestamp = Date.now();
    try {
      const proc = await this.runCommand(ctx, [
        'resolve',
        '--tool',
        'internal:dumpjson',
        '--all',
      ]);
      output = JSON.parse(proc.stdout) as ResolveCommandConflictOutput;
    } catch {
      return undefined;
    }

    return computeNewConflicts(previousConflicts ?? {state: 'loading'}, output, fetchStartTimestamp);
  }

  async hasPotentialOperation(dotdir: string): Promise<boolean> {
    return exists(path.join(dotdir, 'merge'));
  }

  async lookupCommits(
    ctx: RepositoryContext,
    codeReviewSystem: CodeReviewSystem,
    hashes: Hash[],
  ): Promise<CommitInfo[]> {
    if (hashes.length === 0) {
      return [];
    }
    const template = getMainFetchTemplate(codeReviewSystem);
    const proc = await this.runCommand(ctx, [
      'log',
      '--template',
      template,
      '--rev',
      hashes.join('+'),
    ]);
    return parseCommitInfoOutput(ctx.logger, proc.stdout.trim(), codeReviewSystem);
  }

  async getFileContents(
    ctx: RepositoryContext,
    filePath: AbsolutePath,
    revset: string,
  ): Promise<string> {
    const options = {stripFinalNewline: false};
    return (await this.runCommand(ctx, ['cat', filePath, '--rev', revset], options)).stdout;
  }

  async getBlame(
    ctx: RepositoryContext,
    filePath: string,
    hash: Hash,
  ): Promise<Array<{line: string; node: string}>> {
    const output = await this.runCommand(
      ctx,
      ['blame', filePath, '-Tjson', '--change', '--rev', hash],
      undefined,
      /* don't timeout */ 0,
    );
    const blame = JSON.parse(output.stdout) as Array<{lines: Array<{line: string; node: string}>}>;
    if (blame.length === 0) {
      return [];
    }
    return blame[0].lines;
  }

  async getDiff(
    ctx: RepositoryContext,
    comparison: Comparison,
    contextLines = 4,
  ): Promise<string> {
    const output = await this.runCommand(ctx, [
      'diff',
      ...revsetArgsForComparison(comparison),
      '--noprefix',
      '--no-binary',
      '--nodate',
      '--unified',
      String(contextLines),
    ]);
    return output.stdout;
  }

  async getChangedFiles(ctx: RepositoryContext, hash: Hash): Promise<ChangedFile[]> {
    const output = (
      await this.runCommand(ctx, ['log', '--template', CHANGED_FILES_TEMPLATE, '--rev', hash])
    ).stdout;

    const [chunk] = output.split(COMMIT_END_MARK, 1);
    const lines = chunk.trim().split('\n');
    if (lines.length < Object.keys(CHANGED_FILES_FIELDS).length) {
      return [];
    }

    return [
      ...(JSON.parse(lines[CHANGED_FILES_INDEX.filesModified]) as string[]).map(p => ({
        path: p,
        status: 'M' as const,
      })),
      ...(JSON.parse(lines[CHANGED_FILES_INDEX.filesAdded]) as string[]).map(p => ({
        path: p,
        status: 'A' as const,
      })),
      ...(JSON.parse(lines[CHANGED_FILES_INDEX.filesRemoved]) as string[]).map(p => ({
        path: p,
        status: 'R' as const,
      })),
    ];
  }

  async getShelvedChanges(ctx: RepositoryContext): Promise<ShelvedChange[]> {
    const output = (
      await this.runCommand(ctx, ['log', '--rev', 'shelved()', '--template', SHELVE_FETCH_TEMPLATE])
    ).stdout;
    const shelves = parseShelvedCommitsOutput(ctx.logger, output.trim());
    shelves.sort((a, b) => b.date.getTime() - a.date.getTime());
    return shelves;
  }

  async getDiffStats(
    ctx: RepositoryContext,
    hash: Hash,
    excludeFiles: string[],
  ): Promise<number | undefined> {
    const exclusions = excludeFiles.flatMap(file => ['-X', file]);
    const output = (
      await this.runCommand(ctx, [
        'diff',
        '--stat',
        '-B',
        '-X',
        '**__generated__**',
        ...exclusions,
        '-c',
        hash,
      ])
    ).stdout;
    return this.parseSlocFrom(output);
  }

  async getPendingDiffStats(
    ctx: RepositoryContext,
    includeFiles: string[],
  ): Promise<number | undefined> {
    if (includeFiles.length === 0) {
      return undefined;
    }
    const inclusions = includeFiles.flatMap(file => ['-I', file]);
    const output = (
      await this.runCommand(ctx, [
        'diff',
        '--stat',
        '-B',
        '-X',
        '**__generated__**',
        ...inclusions,
      ])
    ).stdout;
    return this.parseSlocFrom(output);
  }

  async getPendingAmendDiffStats(
    ctx: RepositoryContext,
    includeFiles: string[],
  ): Promise<number | undefined> {
    if (includeFiles.length === 0) {
      return undefined;
    }
    const inclusions = includeFiles.flatMap(file => ['-I', file]);
    const output = (
      await this.runCommand(ctx, [
        'diff',
        '--stat',
        '-B',
        '-X',
        '**__generated__**',
        ...inclusions,
        '-r',
        '.^',
      ])
    ).stdout;
    if (output.trim() === '') {
      return undefined;
    }
    return this.parseSlocFrom(output);
  }

  // ── Configuration ─────────────────────────────────────

  async getConfig(ctx: RepositoryContext, name: string): Promise<string | undefined> {
    try {
      return (await this.runCommand(ctx, ['config', name])).stdout;
    } catch {
      return undefined;
    }
  }

  async getConfigs<T extends string>(
    ctx: RepositoryContext,
    names: ReadonlyArray<T>,
  ): Promise<Map<T, string>> {
    const configMap: Map<T, string> = new Map();
    try {
      const sections = new Set<string>(names.flatMap(name => name.split('.').at(0) ?? []));
      const result = await this.runCommand(ctx, ['config', '-Tjson'].concat([...sections]));
      const configs: [{name: T; value: string}] = JSON.parse(result.stdout);
      for (const config of configs) {
        configMap.set(config.name, config.value);
      }
    } catch (e) {
      ctx.logger.error(`failed to read configs from ${ctx.cwd}: ${e}`);
    }
    return configMap;
  }

  async setConfig(
    ctx: RepositoryContext,
    scope: ConfigScope,
    name: string,
    value: string,
  ): Promise<void> {
    await this.runCommand(ctx, ['config', `--${scope}`, name, value]);
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
    const illegalArgs = new Set(['--cwd', '--config', '--insecure', '--repository', '-R']);
    let stdin = operation.stdin;
    const args: string[] = [];
    // Resolve symlinks in cwd and repoRoot so path.relative works correctly
    // (e.g. macOS /tmp -> /private/tmp)
    let resolvedCwd: string;
    let resolvedRepoRoot: string;
    try {
      resolvedCwd = fs.realpathSync(cwd);
      resolvedRepoRoot = fs.realpathSync(repoRoot);
    } catch {
      resolvedCwd = cwd;
      resolvedRepoRoot = repoRoot;
    }
    for (const arg of operation.args) {
      if (typeof arg === 'object') {
        switch (arg.type) {
          case 'config':
            if (!(settableConfigNames as ReadonlyArray<string>).includes(arg.key)) {
              throw new Error(`config ${arg.key} not allowed`);
            }
            args.push('--config', `${arg.key}=${arg.value}`);
            continue;
          case 'repo-relative-file':
            args.push(path.normalize(path.relative(resolvedCwd, path.join(resolvedRepoRoot, arg.path))));
            continue;
          case 'repo-relative-file-list':
            args.push('listfile0:-');
            if (stdin != null) {
              throw new Error('stdin already set when using repo-relative-file-list');
            }
            stdin = arg.paths
              .map(p => path.normalize(path.relative(resolvedCwd, path.join(resolvedRepoRoot, p))))
              .join('\0');
            continue;
          case 'exact-revset':
            if (arg.revset.startsWith('-')) {
              throw new Error('invalid revset');
            }
            args.push(arg.revset);
            continue;
          case 'succeedable-revset':
            args.push(`max(successors(${arg.revset}))`);
            continue;
          case 'optimistic-revset':
            args.push(`max(successors(${arg.revset}))`);
            continue;
        }
      }
      if (illegalArgs.has(arg)) {
        throw new Error(`argument '${arg}' is not allowed`);
      }
      args.push(arg);
    }
    return {args, stdin};
  }

  getExecParams(
    args_: string[],
    cwd: string,
    options_?: EjecaOptions,
    env?: Record<string, string>,
  ): {command: string; args: string[]; options: EjecaOptions} {
    let args = [...args_, '--noninteractive'];
    if (process.platform !== 'win32') {
      args = args.map(arg => arg.replace(/\\\\/g, '\\'));
    }
    const [commandName] = args;
    const EXCLUDE_FROM_BLACKBOX = new Set(['cat', 'config', 'diff', 'log', 'show', 'status']);
    if (EXCLUDE_FROM_BLACKBOX.has(commandName)) {
      args.push('--config', 'extensions.blackbox=!');
    }
    const editor = os.platform() === 'win32' ? 'exit /b 1' : 'false';
    const newEnv = {
      ...options_?.env,
      ...env,
      HGENCODING: 'UTF-8',
      SL_ENCODING: 'UTF-8',
      SL_AUTOMATION: 'true',
      SL_AUTOMATION_EXCEPT: 'ghrevset,phrevset,progress,sniff,username',
      EDITOR: undefined,
      VISUAL: undefined,
      HGUSER: undefined,
      HGEDITOR: editor,
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

    if (args_[0] === 'status') {
      args.push('--config', 'fsmonitor.watchman-query-lock=True');
    }

    if (options.ipc) {
      args.push('--config', 'progress.renderer=nodeipc');
    }

    return {command: this.command, args, options};
  }

  async getMergeTool(ctx: RepositoryContext): Promise<string | null> {
    if (ctx.cachedMergeTool !== undefined) {
      return ctx.cachedMergeTool;
    }
    const tool = ctx.knownConfigs?.get('ui.merge' as ConfigName) ?? 'internal:merge';
    let usesCustomMerge = tool !== 'internal:merge';

    if (usesCustomMerge) {
      const customToolUsesGui =
        (await this.getConfig(ctx, `merge-tools.${tool}.gui`))?.toLowerCase() === 'true';
      if (!customToolUsesGui) {
        ctx.logger.warn(
          `configured custom merge tool '${tool}' is not a GUI tool, using :merge3 instead`,
        );
        usesCustomMerge = false;
      } else {
        ctx.logger.info(`using configured custom GUI merge tool ${tool}`);
      }
    } else {
      ctx.logger.info(`using default :merge3 merge tool`);
    }

    const mergeTool = usesCustomMerge ? tool : null;
    ctx.cachedMergeTool = mergeTool;
    return mergeTool;
  }

  async getMergeToolEnvVars(ctx: RepositoryContext): Promise<Record<string, string> | undefined> {
    const tool = await this.getMergeTool(ctx);
    return tool != null ? {} : {HGMERGE: ':merge3', SL_MERGE: ':merge3'};
  }

  // ── File Watching ─────────────────────────────────────

  getWatchConfig(_repoInfo: ValidatedRepoInfo): WatchConfig {
    return {
      watchmanDefers: ['hg.update', 'hg.transaction'],
      dirstateFiles: ['bookmarks.current', 'bookmarks', 'dirstate', 'merge'],
      subscriptionPrefix: 'sapling-smartlog',
      supportsEdenFs: true,
      additionalWatchDirs: ['store/journal'],
    };
  }

  // ── Optional / Capability-Gated Methods ───────────────

  async exportStack(
    ctx: RepositoryContext,
    revs: string,
    assumeTracked?: string[],
  ): Promise<ExportStack> {
    const args = ['debugexportstack', '--rev', revs];
    if (assumeTracked && assumeTracked.length > 0) {
      for (const file of assumeTracked) {
        args.push('--assume-tracked', file);
      }
    }
    const result = await this.runCommand(ctx, args);
    return JSON.parse(result.stdout) as ExportStack;
  }

  async importStack(ctx: RepositoryContext, stack: ImportStack): Promise<string> {
    const result = await this.runCommand(ctx, ['debugimportstack'], {
      input: JSON.stringify(stack),
    });
    return result.stdout;
  }

  async fetchSubmodules(
    ctx: RepositoryContext,
    repoRoots: AbsolutePath[],
  ): Promise<SubmodulesByRoot> {
    const submoduleMap: SubmodulesByRoot = new Map();
    await Promise.all(
      repoRoots.map(async root => {
        try {
          const proc = await this.runCommand(ctx, [
            'debuggitmodules',
            '--json',
            '--repo',
            root,
          ]);
          const submodules = JSON.parse(proc.stdout) as Submodule[];
          submoduleMap.set(root, {value: submodules?.length === 0 ? undefined : submodules});
        } catch (err) {
          let error = err;
          if (isEjecaError(error)) {
            error = error.stderr.includes('unknown command')
              ? Error('debuggitmodules command is not supported by your sapling version.')
              : simplifyEjecaError(error);
          }
          ctx.logger.error('Error fetching submodules: ', error);
          submoduleMap.set(root, {error: new Error(err as string)});
        }
      }),
    );
    return submoduleMap;
  }

  async getActiveAlerts(ctx: RepositoryContext): Promise<Alert[]> {
    const result = await this.runCommand(ctx, ['config', '-Tjson', 'alerts'], {reject: false});
    if (result.exitCode !== 0 || !result.stdout) {
      return [];
    }
    try {
      const configs = JSON.parse(result.stdout) as [{name: string; value: unknown}];
      return parseAlerts(configs);
    } catch {
      return [];
    }
  }

  async collectDebugInfo(ctx: RepositoryContext): Promise<string> {
    const output = await this.runCommand(ctx, ['rage'], undefined, 90_000);
    const match = /P\d{9,}/.exec(output.stdout);
    if (match) {
      return match[0];
    }
    throw new Error('No paste found in rage output: ' + output.stdout);
  }

  async getCommitCloudState(ctx: RepositoryContext): Promise<CommitCloudSyncState> {
    const lastChecked = new Date();

    const [extension, backupStatuses, cloudStatus] = await Promise.allSettled([
      this.getConfig(ctx, 'extensions.commitcloud'),
      this.fetchCommitCloudBackupStatuses(ctx),
      this.fetchCommitCloudStatus(ctx),
    ]);
    if (extension.status === 'fulfilled' && extension.value !== '') {
      return {lastChecked, isDisabled: true};
    }

    if (backupStatuses.status === 'rejected') {
      return {lastChecked, syncError: backupStatuses.reason};
    } else if (cloudStatus.status === 'rejected') {
      return {lastChecked, workspaceError: cloudStatus.reason};
    }

    return {
      lastChecked,
      ...cloudStatus.value,
      commitStatuses: backupStatuses.value,
    };
  }

  // ── Private Helpers ───────────────────────────────────

  private async fetchCommitCloudBackupStatuses(
    ctx: RepositoryContext,
  ): Promise<Map<Hash, CommitCloudBackupStatusType>> {
    const revset = 'draft() - backedup()';
    const template = `{dict(
      hash="{node}",
      backingup="{backingup}",
      date="{date|isodatesec}"
      )|json}\n`;

    const output = await this.runCommand(ctx, [
      'log',
      '--rev',
      revset,
      '--template',
      template,
    ]);

    const rawObjects = output.stdout.trim().split('\n');
    const parsedObjects = rawObjects
      .map(rawObject => {
        try {
          return JSON.parse(rawObject) as {hash: Hash; backingup: 'True' | 'False'; date: string};
        } catch {
          return null;
        }
      })
      .filter(notEmpty);

    const now = new Date();
    const TEN_MIN = 10 * 60 * 1000;
    return new Map(
      parsedObjects.map(obj => [
        obj.hash,
        obj.backingup === 'True'
          ? CommitCloudBackupStatus.InProgress
          : now.valueOf() - new Date(obj.date).valueOf() < TEN_MIN
            ? CommitCloudBackupStatus.Pending
            : CommitCloudBackupStatus.Failed,
      ]),
    );
  }

  private async fetchCommitCloudStatus(ctx: RepositoryContext): Promise<{
    lastBackup: Date | undefined;
    currentWorkspace: string;
    workspaceChoices: string[];
  }> {
    const [cloudStatusOutput, cloudListOutput] = await Promise.all([
      this.runCommand(ctx, ['cloud', 'status']),
      this.runCommand(ctx, ['cloud', 'list']),
    ]);

    const currentWorkspace =
      /Workspace: ([a-zA-Z/0-9._-]+)/.exec(cloudStatusOutput.stdout)?.[1] ?? 'default';
    const lastSyncTimeStr = /Last Sync Time: (.*)/.exec(cloudStatusOutput.stdout)?.[1];
    const lastBackup = lastSyncTimeStr != null ? new Date(lastSyncTimeStr) : undefined;
    const workspaceChoices = cloudListOutput.stdout
      .split('\n')
      .map(line => /^ {8}([a-zA-Z/0-9._-]+)(?: \(connected\))?/.exec(line)?.[1] as string)
      .filter(l => l != null);

    return {lastBackup, currentWorkspace, workspaceChoices};
  }

  private parseSlocFrom(output: string): number {
    const lines = output.trim().split('\n');
    const changes = lines[lines.length - 1];
    const diffStatRe = /\d+ files changed, (\d+) insertions\(\+\), (\d+) deletions\(-\)/;
    const diffStatMatch = changes.match(diffStatRe);
    const insertions = parseInt(diffStatMatch?.[1] ?? '0', 10);
    const deletions = parseInt(diffStatMatch?.[2] ?? '0', 10);
    return insertions + deletions;
  }
}
