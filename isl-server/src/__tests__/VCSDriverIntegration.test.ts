/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import type {VCSDriver} from '../vcs/VCSDriver';
import type {FetchCommitsOptions} from '../vcs/types';
import type {RepositoryContext} from '../serverTypes';
import type {ServerPlatform} from '../serverPlatform';
import type {RunnableOperation, ValidatedRepoInfo} from 'isl/src/types';

import {execFile as execFileCb} from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {promisify} from 'node:util';
import {ComparisonType} from 'shared/Comparison';
import {mockLogger} from 'shared/testUtils';
import {makeServerSideTracker} from '../analytics/serverSideTracker';
import {SaplingDriver} from '../vcs/SaplingDriver';
import {GitDriver} from '../vcs/GitDriver';

const execFile = promisify(execFileCb);

const mockTracker = makeServerSideTracker(
  mockLogger,
  {platformName: 'test'} as ServerPlatform,
  '0.1',
  jest.fn(),
);

const defaultFetchOptions: FetchCommitsOptions = {
  maxDraftDays: undefined,
  stableLocations: [],
  recommendedBookmarks: [],
};

/**
 * VCS-agnostic helper functions passed into the test suite.
 * Each VCS provides its own implementations.
 */
interface VCSHelpers {
  init: (dir: string) => Promise<void>;
  commit: (dir: string, msg: string, file: string, content: string) => Promise<void>;
  getHead: (dir: string) => Promise<string>;
  /** Checkout/goto a specific hash */
  checkout: (dir: string, hash: string) => Promise<void>;
  /** Create a named branch/bookmark pointing at a hash */
  createBranch: (dir: string, name: string, hash: string) => Promise<void>;
  /** Create a named branch and switch to it */
  createAndCheckoutBranch: (dir: string, name: string) => Promise<void>;
  /** Move a branch/bookmark to point at a different hash */
  moveBranch: (dir: string, name: string, hash: string) => Promise<void>;
  /** Delete a branch/bookmark */
  deleteBranch: (dir: string, name: string) => Promise<void>;
  /** Rebase current branch onto target hash */
  rebase: (dir: string, onto: string) => Promise<void>;
  /** Rebase --onto: transplant commits from oldBase..branch onto newBase */
  rebaseOnto: (dir: string, newBase: string, oldBase: string, branch: string) => Promise<void>;
  /** Abort an in-progress rebase */
  rebaseAbort: (dir: string) => Promise<void>;
  /** Amend the current commit's message */
  amend: (dir: string, msg: string) => Promise<void>;
  /** Shelve/stash working changes with a name */
  shelve: (dir: string, name: string) => Promise<void>;
  /** Unshelve/unstash the most recent shelved change */
  unshelve: (dir: string) => Promise<void>;
}

// ── Sapling Helpers ──────────────────────────────────

const saplingHelpers: VCSHelpers = {
  async init(dir) {
    await execFile('sl', ['init', '--config=format.use-eager-repo=True'], {cwd: dir});
  },
  async commit(dir, msg, file, content) {
    await fs.writeFile(path.join(dir, file), content);
    await execFile('sl', ['add', file], {cwd: dir});
    await execFile('sl', ['commit', '-m', msg], {cwd: dir});
  },
  async getHead(dir) {
    const {stdout} = await execFile('sl', ['log', '-r', '.', '--template', '{node}'], {cwd: dir});
    return stdout.trim();
  },
  async checkout(dir, hash) {
    await execFile('sl', ['goto', hash], {cwd: dir});
  },
  async createBranch(dir, name, hash) {
    await execFile('sl', ['bookmark', name, '--rev', hash], {cwd: dir});
  },
  async createAndCheckoutBranch(dir, name) {
    await execFile('sl', ['bookmark', name], {cwd: dir});
  },
  async moveBranch(dir, name, hash) {
    await execFile('sl', ['bookmark', name, '--rev', hash, '--force'], {cwd: dir});
  },
  async deleteBranch(dir, name) {
    await execFile('sl', ['bookmark', '--delete', name], {cwd: dir});
  },
  async rebase(dir, onto) {
    await execFile('sl', ['rebase', '-d', onto], {cwd: dir});
  },
  async rebaseOnto(dir, newBase, oldBase, branch) {
    await execFile('sl', ['rebase', '-s', branch, '-d', newBase], {cwd: dir});
  },
  async rebaseAbort(dir) {
    await execFile('sl', ['rebase', '--abort'], {cwd: dir});
  },
  async amend(dir, msg) {
    await execFile('sl', ['amend', '-m', msg], {cwd: dir});
  },
  async shelve(dir, name) {
    await execFile('sl', ['shelve', '-n', name], {cwd: dir});
  },
  async unshelve(dir) {
    await execFile('sl', ['unshelve'], {cwd: dir});
  },
};

// ── Git Helpers ──────────────────────────────────────

const gitHelpers: VCSHelpers = {
  async init(dir) {
    await execFile('git', ['init'], {cwd: dir});
    await execFile('git', ['config', 'user.email', 'test@test.com'], {cwd: dir});
    await execFile('git', ['config', 'user.name', 'Test User'], {cwd: dir});
  },
  async commit(dir, msg, file, content) {
    await fs.writeFile(path.join(dir, file), content);
    await execFile('git', ['add', file], {cwd: dir});
    await execFile('git', ['commit', '-m', msg], {cwd: dir});
  },
  async getHead(dir) {
    const {stdout} = await execFile('git', ['rev-parse', 'HEAD'], {cwd: dir});
    return stdout.trim();
  },
  async checkout(dir, hash) {
    await execFile('git', ['checkout', hash], {cwd: dir});
  },
  async createBranch(dir, name, hash) {
    await execFile('git', ['branch', name, hash], {cwd: dir});
  },
  async createAndCheckoutBranch(dir, name) {
    await execFile('git', ['checkout', '-b', name], {cwd: dir});
  },
  async moveBranch(dir, name, hash) {
    await execFile('git', ['branch', '-f', name, hash], {cwd: dir});
  },
  async deleteBranch(dir, name) {
    await execFile('git', ['branch', '-D', name], {cwd: dir});
  },
  async rebase(dir, onto) {
    await execFile('git', ['rebase', onto], {cwd: dir});
  },
  async rebaseOnto(dir, newBase, oldBase, branch) {
    await execFile('git', ['rebase', '--onto', newBase, oldBase, branch], {cwd: dir});
  },
  async rebaseAbort(dir) {
    await execFile('git', ['rebase', '--abort'], {cwd: dir});
  },
  async amend(dir, msg) {
    await execFile('git', ['commit', '--amend', '-m', msg], {cwd: dir});
  },
  async shelve(dir, name) {
    await execFile('git', ['stash', 'push', '-m', name], {cwd: dir});
  },
  async unshelve(dir) {
    await execFile('git', ['stash', 'pop'], {cwd: dir});
  },
};

// ── Reusable Test Suite ────────────────────────────────

function runVCSDriverTests(
  driverName: string,
  createDriver: () => VCSDriver,
  helpers: VCSHelpers,
) {
  describe(`${driverName} Driver Integration Tests`, () => {
    let tmpDir: string;
    let ctx: RepositoryContext;
    let driver: VCSDriver;

    beforeEach(async () => {
      const rawTmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'champagne-test-'));
      // Resolve symlinks so that path comparisons work consistently on macOS
      // where /var is a symlink to /private/var.
      tmpDir = await fs.realpath(rawTmpDir);
      await helpers.init(tmpDir);
      driver = createDriver();
      ctx = {
        cmd: driver.command,
        cwd: tmpDir,
        logger: mockLogger,
        tracker: mockTracker,
      };
    });

    afterEach(async () => {
      await fs.rm(tmpDir, {recursive: true, force: true});
    });

    // ── Repository Detection ──────────────────────────

    describe('Repository Detection', () => {
      it('findRoot returns repo root from subdirectory', async () => {
        const sub = path.join(tmpDir, 'sub');
        await fs.mkdir(sub);
        const subCtx = {...ctx, cwd: sub};
        const root = await driver.findRoot(subCtx);
        expect(root).toBe(tmpDir);
      });

      it('findRoot returns undefined for non-repo dir', async () => {
        const nonRepo = await fs.mkdtemp(path.join(os.tmpdir(), 'not-a-repo-'));
        try {
          const nonRepoCtx = {...ctx, cwd: nonRepo};
          const root = await driver.findRoot(nonRepoCtx);
          expect(root).toBeUndefined();
        } finally {
          await fs.rm(nonRepo, {recursive: true, force: true});
        }
      });

      it('findDotDir returns metadata directory', async () => {
        const dotdir = await driver.findDotDir(ctx);
        expect(dotdir).toBeDefined();
        expect(typeof dotdir).toBe('string');
      });

      it('validateRepo returns success for valid repo', async () => {
        const result = await driver.validateRepo(ctx);
        expect(result.type).toBe('success');
        if (result.type === 'success') {
          expect(result.repoRoot).toBe(tmpDir);
          expect(result.dotdir).toBeDefined();
        }
      });

      it('validateRepo returns error for non-repo', async () => {
        const nonRepo = await fs.mkdtemp(path.join(os.tmpdir(), 'not-a-repo-'));
        try {
          const nonRepoCtx = {...ctx, cwd: nonRepo};
          const result = await driver.validateRepo(nonRepoCtx);
          expect(result.type).toBe('cwdNotARepository');
        } finally {
          await fs.rm(nonRepo, {recursive: true, force: true});
        }
      });
    });

    // ── Commit Fetching ───────────────────────────────

    describe('Commit Fetching', () => {
      it('fetchCommits returns commits after creating commits', async () => {
        await helpers.commit(tmpDir, 'first', 'a.txt', 'a');
        await helpers.commit(tmpDir, 'second', 'b.txt', 'b');
        await helpers.commit(tmpDir, 'third', 'c.txt', 'c');
        const commits = await driver.fetchCommits(ctx, {type: 'none'}, defaultFetchOptions);
        expect(commits.length).toBeGreaterThanOrEqual(3);
      });

      it('fetchCommits marks HEAD as isDot', async () => {
        await helpers.commit(tmpDir, 'first', 'a.txt', 'a');
        await helpers.commit(tmpDir, 'second', 'b.txt', 'b');
        const commits = await driver.fetchCommits(ctx, {type: 'none'}, defaultFetchOptions);
        const dotCommits = commits.filter(c => c.isDot);
        expect(dotCommits.length).toBe(1);
      });

      it('fetchCommits includes hash, title, author, date', async () => {
        await helpers.commit(tmpDir, 'test commit', 'file.txt', 'content');
        const commits = await driver.fetchCommits(ctx, {type: 'none'}, defaultFetchOptions);
        expect(commits.length).toBeGreaterThan(0);
        for (const commit of commits) {
          expect(commit.hash).toBeTruthy();
          expect(commit.hash.length).toBeGreaterThanOrEqual(12);
          expect(commit.title).toBeTruthy();
          expect(commit.author).toBeTruthy();
          expect(commit.date).toBeInstanceOf(Date);
          expect(commit.date.getTime()).toBeGreaterThan(0);
        }
      });

      it('fetchCommits includes parent hashes', async () => {
        await helpers.commit(tmpDir, 'first', 'a.txt', 'a');
        await helpers.commit(tmpDir, 'second', 'b.txt', 'b');
        const commits = await driver.fetchCommits(ctx, {type: 'none'}, defaultFetchOptions);
        const withParents = commits.filter(c => c.parents.length > 0);
        expect(withParents.length).toBeGreaterThan(0);
      });
    });

    // ── Status / Uncommitted Changes ──────────────────

    describe('Status / Uncommitted Changes', () => {
      it('fetchStatus returns empty for clean working directory', async () => {
        await helpers.commit(tmpDir, 'initial', 'file.txt', 'content');
        const status = await driver.fetchStatus(ctx);
        expect(status).toEqual([]);
      });

      it('fetchStatus detects modified file', async () => {
        await helpers.commit(tmpDir, 'initial', 'file.txt', 'original');
        await fs.writeFile(path.join(tmpDir, 'file.txt'), 'modified');
        const status = await driver.fetchStatus(ctx);
        const modified = status.find(f => f.path === 'file.txt');
        expect(modified).toBeDefined();
        expect(modified!.status).toBe('M');
      });

      it('fetchStatus detects added file', async () => {
        await helpers.commit(tmpDir, 'initial', 'file.txt', 'content');
        await fs.writeFile(path.join(tmpDir, 'new.txt'), 'new content');
        await execFile(driver.command, ['add', 'new.txt'], {cwd: tmpDir});
        const status = await driver.fetchStatus(ctx);
        const added = status.find(f => f.path === 'new.txt');
        expect(added).toBeDefined();
        expect(added!.status).toBe('A');
      });

      it('fetchStatus detects removed file', async () => {
        await helpers.commit(tmpDir, 'initial', 'file.txt', 'content');
        await execFile(driver.command, ['rm', 'file.txt'], {cwd: tmpDir});
        const status = await driver.fetchStatus(ctx);
        const removed = status.find(f => f.path === 'file.txt');
        expect(removed).toBeDefined();
        expect(removed!.status).toBe('R');
      });

      it('fetchStatus detects untracked file', async () => {
        await helpers.commit(tmpDir, 'initial', 'file.txt', 'content');
        await fs.writeFile(path.join(tmpDir, 'untracked.txt'), 'untracked');
        const status = await driver.fetchStatus(ctx);
        const untracked = status.find(f => f.path === 'untracked.txt');
        expect(untracked).toBeDefined();
        expect(untracked!.status).toBe('?');
      });

      it('fetchStatus detects missing (!) file deleted from disk but not staged', async () => {
        await helpers.commit(tmpDir, 'initial', 'file.txt', 'content');
        // Delete directly without staging — this is a '!' (missing) file in sapling terms
        await fs.unlink(path.join(tmpDir, 'file.txt'));
        const status = await driver.fetchStatus(ctx);
        const missing = status.find(f => f.path === 'file.txt');
        expect(missing).toBeDefined();
        expect(missing!.status).toBe('!');
      });
    });

    // ── File Contents ─────────────────────────────────

    describe('File Contents', () => {
      it('getFileContents returns file at HEAD', async () => {
        await helpers.commit(tmpDir, 'initial', 'file.txt', 'hello world');
        const contents = await driver.getFileContents(ctx, path.join(tmpDir, 'file.txt'), '.');
        expect(contents).toContain('hello world');
      });

      it('getFileContents returns file at specific commit', async () => {
        await helpers.commit(tmpDir, 'v1', 'file.txt', 'version one');
        const hash1 = await helpers.getHead(tmpDir);
        await helpers.commit(tmpDir, 'v2', 'file.txt', 'version two');
        const contents = await driver.getFileContents(ctx, path.join(tmpDir, 'file.txt'), hash1);
        expect(contents).toContain('version one');
      });
    });

    // ── Blame ─────────────────────────────────────────

    describe('Blame', () => {
      it('getBlame returns line-by-line attribution', async () => {
        await helpers.commit(tmpDir, 'initial', 'file.txt', 'line1\nline2\nline3\n');
        const hash = await helpers.getHead(tmpDir);
        const blame = await driver.getBlame(ctx, path.join(tmpDir, 'file.txt'), hash);
        expect(blame.length).toBe(3);
        for (const entry of blame) {
          expect(entry.node).toBeTruthy();
          expect(entry.node.length).toBeGreaterThanOrEqual(12);
          expect(typeof entry.line).toBe('string');
        }
      });

      it('getBlame returns correct commit hash per line', async () => {
        await helpers.commit(tmpDir, 'first two lines', 'file.txt', 'line1\nline2\n');
        const hash1 = await helpers.getHead(tmpDir);

        await fs.writeFile(path.join(tmpDir, 'file.txt'), 'line1\nline2\nline3\n');
        await execFile(driver.command, ['add', 'file.txt'], {cwd: tmpDir});
        await execFile(driver.command, ['commit', '-m', 'add third line'], {cwd: tmpDir});
        const hash2 = await helpers.getHead(tmpDir);

        const blame = await driver.getBlame(ctx, path.join(tmpDir, 'file.txt'), hash2);
        expect(blame.length).toBe(3);
        expect(blame[0].node).toBe(hash1);
        expect(blame[1].node).toBe(hash1);
        expect(blame[2].node).toBe(hash2);
      });
    });

    // ── Changed Files ─────────────────────────────────

    describe('Changed Files', () => {
      it('getChangedFiles returns files modified in a commit', async () => {
        await helpers.commit(tmpDir, 'initial', 'a.txt', 'a');
        await helpers.commit(tmpDir, 'add both', 'b.txt', 'b');
        const hash = await helpers.getHead(tmpDir);
        const files = await driver.getChangedFiles(ctx, hash);
        expect(files.length).toBeGreaterThan(0);
        expect(files.find(f => f.path === 'b.txt')).toBeDefined();
      });

      it('getChangedFiles returns empty for initial commit', async () => {
        await helpers.commit(tmpDir, 'initial', 'file.txt', 'content');
        const hash = await helpers.getHead(tmpDir);
        const files = await driver.getChangedFiles(ctx, hash);
        // Root commits may or may not return files depending on VCS. Should not crash.
        expect(Array.isArray(files)).toBe(true);
      });

      it('getChangedFiles returns multiple files', async () => {
        await helpers.commit(tmpDir, 'initial', 'a.txt', 'a');
        await fs.writeFile(path.join(tmpDir, 'b.txt'), 'b');
        await fs.writeFile(path.join(tmpDir, 'c.txt'), 'c');
        await execFile(driver.command, ['add', 'b.txt', 'c.txt'], {cwd: tmpDir});
        await execFile(driver.command, ['commit', '-m', 'add b and c'], {cwd: tmpDir});
        const hash = await helpers.getHead(tmpDir);

        const files = await driver.getChangedFiles(ctx, hash);
        expect(files.length).toBe(2);
        const paths = files.map(f => f.path).sort();
        expect(paths).toEqual(['b.txt', 'c.txt']);
      });
    });

    // ── Diff ──────────────────────────────────────────

    describe('Diff', () => {
      it('getDiff returns unified diff for working changes', async () => {
        await helpers.commit(tmpDir, 'initial', 'file.txt', 'original\n');
        await fs.writeFile(path.join(tmpDir, 'file.txt'), 'modified\n');
        const diff = await driver.getDiff(ctx, {type: ComparisonType.UncommittedChanges});
        expect(diff).toContain('-original');
        expect(diff).toContain('+modified');
      });

      it('getDiff returns diff for specific commit', async () => {
        await helpers.commit(tmpDir, 'initial', 'file.txt', 'original\n');
        await helpers.commit(tmpDir, 'change', 'file.txt', 'changed\n');
        const hash = await helpers.getHead(tmpDir);
        const diff = await driver.getDiff(ctx, {type: ComparisonType.Committed, hash});
        expect(diff).toContain('-original');
        expect(diff).toContain('+changed');
      });

      it('getDiff for HeadChanges works on the first (root) commit', async () => {
        await helpers.commit(tmpDir, 'root commit', 'file.txt', 'content\n');
        // HeadChanges uses HEAD^ internally — must not crash on root commit
        const diff = await driver.getDiff(ctx, {type: ComparisonType.HeadChanges});
        expect(typeof diff).toBe('string');
      });
    });

    // ── Shelve / Stash ────────────────────────────────

    describe('Shelve/Stash', () => {
      it('getShelvedChanges returns empty when nothing shelved', async () => {
        await helpers.commit(tmpDir, 'initial', 'file.txt', 'content');
        const shelves = await driver.getShelvedChanges(ctx);
        expect(shelves).toEqual([]);
      });

      it('getShelvedChanges returns shelved change after shelve', async () => {
        await helpers.commit(tmpDir, 'initial', 'file.txt', 'content');
        await fs.writeFile(path.join(tmpDir, 'file.txt'), 'modified');
        await helpers.shelve(tmpDir, 'test-shelve');

        const shelves = await driver.getShelvedChanges(ctx);
        expect(shelves.length).toBeGreaterThanOrEqual(1);
        expect(shelves[0].name).toBeTruthy();
        expect(shelves[0].date).toBeInstanceOf(Date);
      });

      it('shelve removes changes from working dir', async () => {
        await helpers.commit(tmpDir, 'initial', 'file.txt', 'original');
        await fs.writeFile(path.join(tmpDir, 'file.txt'), 'modified');

        let status = await driver.fetchStatus(ctx);
        expect(status.find(f => f.path === 'file.txt')).toBeDefined();

        await helpers.shelve(tmpDir, 'test-shelve');

        status = await driver.fetchStatus(ctx);
        expect(status.find(f => f.path === 'file.txt')).toBeUndefined();
      });

      it('shelve and unshelve preserves changes', async () => {
        await helpers.commit(tmpDir, 'initial', 'file.txt', 'original');
        await fs.writeFile(path.join(tmpDir, 'file.txt'), 'modified for shelve');

        await helpers.shelve(tmpDir, 'round-trip');

        let status = await driver.fetchStatus(ctx);
        expect(status.find(f => f.path === 'file.txt')).toBeUndefined();

        await helpers.unshelve(tmpDir);

        status = await driver.fetchStatus(ctx);
        expect(status.find(f => f.path === 'file.txt')).toBeDefined();
        const content = await fs.readFile(path.join(tmpDir, 'file.txt'), 'utf-8');
        expect(content).toBe('modified for shelve');
      });

      it('multiple shelves tracked independently', async () => {
        await helpers.commit(tmpDir, 'initial', 'file.txt', 'original');

        await fs.writeFile(path.join(tmpDir, 'file.txt'), 'change1');
        await helpers.shelve(tmpDir, 'shelve-one');

        await fs.writeFile(path.join(tmpDir, 'file.txt'), 'change2');
        await helpers.shelve(tmpDir, 'shelve-two');

        const shelves = await driver.getShelvedChanges(ctx);
        expect(shelves.length).toBe(2);
        expect(new Set(shelves.map(s => s.name)).size).toBe(2);
      });
    });

    // ── Configuration ─────────────────────────────────

    describe('Configuration', () => {
      it('getConfig returns undefined for missing config', async () => {
        const value = await driver.getConfig(ctx, 'nonexistent.key.12345');
        expect(value).toBeUndefined();
      });

      it('setConfig and getConfig round-trip', async () => {
        await driver.setConfig(ctx, 'local', 'isl.test-key', 'test-value');
        const value = await driver.getConfig(ctx, 'isl.test-key');
        expect(value).toBe('test-value');
      });
    });

    // ── Merge Conflicts ───────────────────────────────

    describe('Merge Conflicts', () => {
      it('checkMergeConflicts returns undefined when no conflict', async () => {
        await helpers.commit(tmpDir, 'initial', 'file.txt', 'content');
        const conflicts = await driver.checkMergeConflicts(ctx, undefined);
        expect(conflicts).toBeUndefined();
      });

      it('checkMergeConflicts detects conflict during rebase', async () => {
        await helpers.commit(tmpDir, 'base', 'file.txt', 'base content');
        const hashBase = await helpers.getHead(tmpDir);

        await helpers.commit(tmpDir, 'change-A', 'file.txt', 'content from A');
        const hashA = await helpers.getHead(tmpDir);

        await helpers.checkout(tmpDir, hashBase);
        await helpers.createAndCheckoutBranch(tmpDir, 'conflict-branch');
        await helpers.commit(tmpDir, 'change-B', 'file.txt', 'content from B');

        try {
          await helpers.rebase(tmpDir, hashA);
        } catch {
          // Expected to fail with conflict
        }

        const conflicts = await driver.checkMergeConflicts(ctx, undefined);
        expect(conflicts).toBeDefined();
        expect(conflicts!.state).toBe('loaded');
        if (conflicts!.state === 'loaded') {
          expect(conflicts!.files.length).toBeGreaterThan(0);
          expect(conflicts!.files[0].path).toBe('file.txt');
        }
      });

      it('abort rebase returns to pre-rebase state', async () => {
        await helpers.commit(tmpDir, 'base', 'file.txt', 'base content');
        const hashBase = await helpers.getHead(tmpDir);

        await helpers.commit(tmpDir, 'change-A', 'file.txt', 'content from A');
        const hashA = await helpers.getHead(tmpDir);

        await helpers.checkout(tmpDir, hashBase);
        await helpers.createAndCheckoutBranch(tmpDir, 'abort-branch');
        await helpers.commit(tmpDir, 'change-B', 'file.txt', 'content from B');
        const hashB = await helpers.getHead(tmpDir);

        try {
          await helpers.rebase(tmpDir, hashA);
        } catch {
          // Expected
        }

        let conflicts = await driver.checkMergeConflicts(ctx, undefined);
        expect(conflicts).toBeDefined();

        await helpers.rebaseAbort(tmpDir);

        conflicts = await driver.checkMergeConflicts(ctx, undefined);
        expect(conflicts).toBeUndefined();

        const currentHead = await helpers.getHead(tmpDir);
        expect(currentHead).toBe(hashB);
      });
    });

    // ── Operation Arg Normalization ───────────────────

    describe('normalizeOperationArgs', () => {
      it('handles string args', () => {
        const result = driver.normalizeOperationArgs(tmpDir, tmpDir, {
          args: ['commit', '-m', 'msg'],
          id: 'test',
          runner: 0 as any,
          trackEventName: 'test' as any,
        });
        expect(result.args).toEqual(['commit', '-m', 'msg']);
      });

      it('resolves repo-relative-file', () => {
        const result = driver.normalizeOperationArgs(tmpDir, tmpDir, {
          args: [{type: 'repo-relative-file', path: 'foo.txt'}],
          id: 'test',
          runner: 0 as any,
          trackEventName: 'test' as any,
        });
        expect(result.args).toContain('foo.txt');
      });

      it('resolves exact-revset', () => {
        const result = driver.normalizeOperationArgs(tmpDir, tmpDir, {
          args: [{type: 'exact-revset', revset: 'abc123'}],
          id: 'test',
          runner: 0 as any,
          trackEventName: 'test' as any,
        });
        expect(result.args).toContain('abc123');
      });

      it('rejects illegal args', () => {
        const illegalArg = driver.command === 'git' ? '--git-dir' : '--cwd';
        expect(() =>
          driver.normalizeOperationArgs(tmpDir, tmpDir, {
            args: [illegalArg],
            id: 'test',
            runner: 0 as any,
            trackEventName: 'test' as any,
          }),
        ).toThrow();
      });
    });

    // ── Commit Stacks ─────────────────────────────────

    describe('Commit Stacks', () => {
      it('fetchCommits shows linear stack', async () => {
        await helpers.commit(tmpDir, 'A', 'a.txt', 'a');
        const hashA = await helpers.getHead(tmpDir);
        await helpers.commit(tmpDir, 'B', 'b.txt', 'b');
        const hashB = await helpers.getHead(tmpDir);
        await helpers.commit(tmpDir, 'C', 'c.txt', 'c');
        const hashC = await helpers.getHead(tmpDir);

        const commits = await driver.fetchCommits(ctx, {type: 'none'}, defaultFetchOptions);
        const commitMap = new Map(commits.map(c => [c.hash, c]));

        expect(commitMap.get(hashC)).toBeDefined();
        expect(commitMap.get(hashB)).toBeDefined();
        expect(commitMap.get(hashC)!.parents).toContain(hashB);
        expect(commitMap.get(hashB)!.parents).toContain(hashA);
      });

      it('fetchCommits shows correct isDot after checkout', async () => {
        await helpers.commit(tmpDir, 'A', 'a.txt', 'a');
        await helpers.commit(tmpDir, 'B', 'b.txt', 'b');
        const hashB = await helpers.getHead(tmpDir);
        await helpers.commit(tmpDir, 'C', 'c.txt', 'c');

        await helpers.checkout(tmpDir, hashB);

        const commits = await driver.fetchCommits(ctx, {type: 'none'}, defaultFetchOptions);
        const commitB = commits.find(c => c.hash === hashB);
        expect(commitB).toBeDefined();
        expect(commitB!.isDot).toBe(true);
        expect(commits.filter(c => c.hash !== hashB && c.isDot).length).toBe(0);
      });

      it('fetchCommits shows branching commits', async () => {
        await helpers.commit(tmpDir, 'base', 'base.txt', 'base');
        const hashBase = await helpers.getHead(tmpDir);

        await helpers.commit(tmpDir, 'branch-A', 'a.txt', 'a');
        const hashA = await helpers.getHead(tmpDir);

        await helpers.checkout(tmpDir, hashBase);
        await helpers.createAndCheckoutBranch(tmpDir, 'branch2');
        await helpers.commit(tmpDir, 'branch-B', 'b.txt', 'b');
        const hashB = await helpers.getHead(tmpDir);

        const commits = await driver.fetchCommits(ctx, {type: 'none'}, defaultFetchOptions);
        const commitA = commits.find(c => c.hash === hashA);
        const commitB = commits.find(c => c.hash === hashB);
        expect(commitA).toBeDefined();
        expect(commitB).toBeDefined();
        expect(commitA!.parents).toContain(hashBase);
        expect(commitB!.parents).toContain(hashBase);
      });

      it('fetchCommits reflects amend', async () => {
        await helpers.commit(tmpDir, 'original message', 'file.txt', 'content');
        await helpers.amend(tmpDir, 'amended message');

        const commits = await driver.fetchCommits(ctx, {type: 'none'}, defaultFetchOptions);
        const amended = commits.find(c => c.isDot);
        expect(amended).toBeDefined();
        expect(amended!.title).toBe('amended message');
      });
    });

    // ── Bookmark/Branch Operations ────────────────────

    describe('Bookmark/Branch Operations', () => {
      it('create bookmark/branch on commit', async () => {
        await helpers.commit(tmpDir, 'initial', 'file.txt', 'content');
        const hash = await helpers.getHead(tmpDir);

        await helpers.createBranch(tmpDir, 'feature', hash);

        const commits = await driver.fetchCommits(ctx, {type: 'none'}, defaultFetchOptions);
        const target = commits.find(c => c.hash === hash);
        expect(target).toBeDefined();
        expect(target!.bookmarks).toContain('feature');
      });

      it('move bookmark/branch to different commit', async () => {
        await helpers.commit(tmpDir, 'A', 'a.txt', 'a');
        const hashA = await helpers.getHead(tmpDir);
        await helpers.commit(tmpDir, 'B', 'b.txt', 'b');
        const hashB = await helpers.getHead(tmpDir);

        await helpers.createBranch(tmpDir, 'feature', hashA);

        let commits = await driver.fetchCommits(ctx, {type: 'none'}, defaultFetchOptions);
        expect(commits.find(c => c.hash === hashA)!.bookmarks).toContain('feature');

        await helpers.moveBranch(tmpDir, 'feature', hashB);

        commits = await driver.fetchCommits(ctx, {type: 'none'}, defaultFetchOptions);
        expect(commits.find(c => c.hash === hashB)!.bookmarks).toContain('feature');
        expect(commits.find(c => c.hash === hashA)!.bookmarks).not.toContain('feature');
      });

      it('delete bookmark/branch', async () => {
        await helpers.commit(tmpDir, 'A', 'a.txt', 'a');
        const hashA = await helpers.getHead(tmpDir);

        await helpers.createBranch(tmpDir, 'feature', hashA);
        let commits = await driver.fetchCommits(ctx, {type: 'none'}, defaultFetchOptions);
        expect(commits.find(c => c.hash === hashA)!.bookmarks).toContain('feature');

        await helpers.deleteBranch(tmpDir, 'feature');
        commits = await driver.fetchCommits(ctx, {type: 'none'}, defaultFetchOptions);
        expect(commits.find(c => c.hash === hashA)!.bookmarks).not.toContain('feature');
      });

      it('old branch commits survive date cutoff', async () => {
        await helpers.commit(tmpDir, 'base', 'base.txt', 'base');
        const baseHash = await helpers.getHead(tmpDir);

        // Create a branch with an old commit (30 days ago)
        await helpers.createAndCheckoutBranch(tmpDir, 'old-feature');
        const oldDate = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
        await execFile(
          'git',
          ['commit', '--allow-empty', '-m', 'old feature work', '--date', oldDate],
          {cwd: tmpDir, env: {...process.env, GIT_COMMITTER_DATE: oldDate}},
        );
        const oldHash = await helpers.getHead(tmpDir);

        // Switch back so old-feature commit is not HEAD
        await helpers.checkout(tmpDir, baseHash);

        // Fetch with a 14-day cutoff — old branch should still appear
        const commits = await driver.fetchCommits(ctx, {type: 'none'}, {
          ...defaultFetchOptions,
          maxDraftDays: 14,
        });
        const oldCommit = commits.find(c => c.hash === oldHash);
        expect(oldCommit).toBeDefined();
        expect(oldCommit!.bookmarks).toContain('old-feature');
      });
    });

    // ── Rebase ────────────────────────────────────────

    describe('Rebase', () => {
      it('rebase moves commit to new parent', async () => {
        await helpers.commit(tmpDir, 'base', 'base.txt', 'base');
        const hashBase = await helpers.getHead(tmpDir);

        await helpers.commit(tmpDir, 'branch-A', 'a.txt', 'a');
        const hashA = await helpers.getHead(tmpDir);

        await helpers.checkout(tmpDir, hashBase);
        await helpers.createAndCheckoutBranch(tmpDir, 'branch-B');
        await helpers.commit(tmpDir, 'branch-B', 'b.txt', 'b');

        await helpers.rebase(tmpDir, hashA);
        const hashBRebased = await helpers.getHead(tmpDir);

        const commits = await driver.fetchCommits(ctx, {type: 'none'}, defaultFetchOptions);
        const rebasedB = commits.find(c => c.hash === hashBRebased);
        expect(rebasedB).toBeDefined();
        expect(rebasedB!.title).toBe('branch-B');
        expect(rebasedB!.parents).toContain(hashA);
      });

      it('rebase stack preserves descendants', async () => {
        await helpers.commit(tmpDir, 'base', 'base.txt', 'base');
        const hashBase = await helpers.getHead(tmpDir);

        await helpers.createAndCheckoutBranch(tmpDir, 'stack');
        await helpers.commit(tmpDir, 'stack-A', 'sa.txt', 'sa');
        await helpers.commit(tmpDir, 'stack-B', 'sb.txt', 'sb');
        await helpers.commit(tmpDir, 'stack-C', 'sc.txt', 'sc');

        await helpers.checkout(tmpDir, hashBase);
        await helpers.createAndCheckoutBranch(tmpDir, 'new-base');
        await helpers.commit(tmpDir, 'new-base', 'nb.txt', 'nb');
        const hashNewBase = await helpers.getHead(tmpDir);

        await helpers.rebaseOnto(tmpDir, hashNewBase, hashBase, 'stack');

        const commits = await driver.fetchCommits(ctx, {type: 'none'}, defaultFetchOptions);
        const rebasedA = commits.find(c => c.title === 'stack-A');
        const rebasedB = commits.find(c => c.title === 'stack-B');
        const rebasedC = commits.find(c => c.title === 'stack-C');

        expect(rebasedA).toBeDefined();
        expect(rebasedB).toBeDefined();
        expect(rebasedC).toBeDefined();
        expect(rebasedA!.parents).toContain(hashNewBase);
        expect(rebasedB!.parents).toContain(rebasedA!.hash);
        expect(rebasedC!.parents).toContain(rebasedB!.hash);
      });

      it('fetchCommits after rebase shows updated parents', async () => {
        await helpers.commit(tmpDir, 'base', 'base.txt', 'base');
        const hashBase = await helpers.getHead(tmpDir);

        await helpers.commit(tmpDir, 'main-next', 'mn.txt', 'mn');
        const hashMainNext = await helpers.getHead(tmpDir);

        await helpers.checkout(tmpDir, hashBase);
        await helpers.createAndCheckoutBranch(tmpDir, 'feat');
        await helpers.commit(tmpDir, 'feat-commit', 'feat.txt', 'feat');

        let commits = await driver.fetchCommits(ctx, {type: 'none'}, defaultFetchOptions);
        let featCommit = commits.find(c => c.title === 'feat-commit');
        expect(featCommit!.parents).toContain(hashBase);

        await helpers.rebase(tmpDir, hashMainNext);

        commits = await driver.fetchCommits(ctx, {type: 'none'}, defaultFetchOptions);
        featCommit = commits.find(c => c.title === 'feat-commit');
        expect(featCommit).toBeDefined();
        expect(featCommit!.parents).toContain(hashMainNext);
      });
    });

    // ── Additional Repository Methods ─────────────────

    describe('Additional Methods', () => {
      it('findRoots returns repository roots', async () => {
        const roots = await driver.findRoots(ctx);
        expect(roots).toBeDefined();
        if (roots) {
          expect(roots).toContain(tmpDir);
        }
      });

      it('lookupCommits fetches specific commits by hash', async () => {
        await helpers.commit(tmpDir, 'first', 'a.txt', 'a');
        const hash1 = await helpers.getHead(tmpDir);
        await helpers.commit(tmpDir, 'second', 'b.txt', 'b');
        const hash2 = await helpers.getHead(tmpDir);

        const commits = await driver.lookupCommits(ctx, {type: 'none'}, [hash1, hash2]);
        expect(commits.length).toBe(2);
        const hashes = commits.map(c => c.hash);
        expect(hashes).toContain(hash1);
        expect(hashes).toContain(hash2);
      });

      it('getDiffStats returns line count for commit', async () => {
        await helpers.commit(tmpDir, 'initial', 'file.txt', 'line1\nline2\nline3\n');
        await helpers.commit(tmpDir, 'add lines', 'file.txt', 'line1\nline2\nline3\nline4\nline5\n');
        const hash = await helpers.getHead(tmpDir);

        const stats = await driver.getDiffStats(ctx, hash, []);
        expect(stats).toBeDefined();
        expect(stats).toBeGreaterThan(0);
      });

      it('getDiffStats excludes specified files', async () => {
        await helpers.commit(tmpDir, 'initial', 'file.txt', 'content\n');
        await fs.writeFile(path.join(tmpDir, 'file.txt'), 'changed content\n');
        await fs.writeFile(path.join(tmpDir, 'generated.txt'), 'generated\n');
        await execFile(driver.command, ['add', '.'], {cwd: tmpDir});
        await execFile(driver.command, ['commit', '-m', 'change both'], {cwd: tmpDir});
        const hash = await helpers.getHead(tmpDir);

        const statsAll = await driver.getDiffStats(ctx, hash, []);
        const statsExclude = await driver.getDiffStats(ctx, hash, ['generated.txt']);

        expect(statsAll).toBeDefined();
        expect(statsExclude).toBeDefined();
        if (statsAll && statsExclude) {
          expect(statsExclude).toBeLessThan(statsAll);
        }
      });

      it('getPendingDiffStats returns stats for uncommitted changes', async () => {
        await helpers.commit(tmpDir, 'initial', 'file.txt', 'original\n');
        await fs.writeFile(path.join(tmpDir, 'file.txt'), 'modified\nextra line\n');

        const stats = await driver.getPendingDiffStats(ctx, ['file.txt']);
        expect(stats).toBeDefined();
        expect(stats).toBeGreaterThan(0);
      });

      it('getPendingAmendDiffStats returns stats for amend changes', async () => {
        await helpers.commit(tmpDir, 'first', 'a.txt', 'a\n');
        await helpers.commit(tmpDir, 'second', 'b.txt', 'b\n');
        await fs.writeFile(path.join(tmpDir, 'b.txt'), 'b modified\n');

        const stats = await driver.getPendingAmendDiffStats(ctx, ['b.txt']);
        expect(stats).toBeDefined();
        expect(stats).toBeGreaterThan(0);
      });

      it('getPendingAmendDiffStats works on the first (root) commit', async () => {
        await helpers.commit(tmpDir, 'root commit', 'file.txt', 'content\n');
        await fs.writeFile(path.join(tmpDir, 'file.txt'), 'modified\n');
        const stats = await driver.getPendingAmendDiffStats(ctx, ['file.txt']);
        expect(stats === undefined || typeof stats === 'number').toBe(true);
      });

      it('getConfigs reads multiple config values', async () => {
        await driver.setConfig(ctx, 'local', 'isl.test-key-1', 'value1');
        await driver.setConfig(ctx, 'local', 'isl.test-key-2', 'value2');

        const configs = await driver.getConfigs(ctx, ['isl.test-key-1', 'isl.test-key-2', 'isl.nonexistent']);
        expect(configs.get('isl.test-key-1')).toBe('value1');
        expect(configs.get('isl.test-key-2')).toBe('value2');
        expect(configs.has('isl.nonexistent')).toBe(false);
      });

      it('getMergeTool returns merge tool config', async () => {
        const mergeTool = await driver.getMergeTool(ctx);
        // May be null for default or a string for configured tool
        expect(mergeTool === null || typeof mergeTool === 'string').toBe(true);
      });

      it('getMergeToolEnvVars returns env vars or undefined', async () => {
        const envVars = await driver.getMergeToolEnvVars(ctx);
        // May be undefined (use default) or an object with env vars
        expect(envVars === undefined || typeof envVars === 'object').toBe(true);
      });

      it('getWatchConfig returns watch configuration', async () => {
        const repoInfo: ValidatedRepoInfo = {
          type: 'success',
          command: driver.command,
          repoRoot: tmpDir,
          dotdir: await driver.findDotDir(ctx) || tmpDir,
          codeReviewSystem: {type: 'unknown'},
          pullRequestDomain: undefined,
          isEdenFs: false,
        };

        const watchConfig = driver.getWatchConfig(repoInfo);
        expect(watchConfig).toBeDefined();
        expect(watchConfig.dirstateFiles).toBeDefined();
        expect(Array.isArray(watchConfig.dirstateFiles)).toBe(true);
        expect(watchConfig.subscriptionPrefix).toBeTruthy();
      });

      it('runCommand executes raw VCS command', async () => {
        await helpers.commit(tmpDir, 'test', 'file.txt', 'content');
        const result = await driver.runCommand(ctx, ['log', '--oneline', '-1']);
        expect(result.stdout).toBeTruthy();
        expect(result.stdout).toContain('test');
      });
    });

    // ── Capability-gated: Submodules ──────────────────

    describe('Submodules', () => {
      it('fetchSubmodules returns submodule info if supported', async () => {
        if (!driver.capabilities.submodules || !driver.fetchSubmodules) {
          return;
        }

        await helpers.commit(tmpDir, 'initial', 'file.txt', 'content');
        const submodules = await driver.fetchSubmodules(ctx, [tmpDir]);
        expect(submodules).toBeDefined();
        expect(typeof submodules).toBe('object');
      });
    });

    // ── File Staging Operations (end-to-end) ──────────

    describe('File Staging Operations', () => {
      /**
       * Helper: run an operation through the full driver stack
       * (normalizeOperationArgs → getExecParams → execFile), exactly
       * the same way ISL does at runtime.
       */
      async function runOp(args: RunnableOperation['args']): Promise<void> {
        const resolved = driver.normalizeOperationArgs(tmpDir, tmpDir, {
          args,
          id: 'test-op',
          runner: 0 as any,
          trackEventName: 'test' as any,
        });
        const {command, args: execArgs, options} = driver.getExecParams(
          resolved.args,
          tmpDir,
          undefined,
          resolved.env,
        );
        await execFile(command, execArgs, {...options, env: {...process.env, ...options.env}});
      }

      it('addremove adds a specific untracked file', async () => {
        await helpers.commit(tmpDir, 'initial', 'existing.txt', 'content');
        await fs.writeFile(path.join(tmpDir, 'new.txt'), 'new content');

        let status = await driver.fetchStatus(ctx);
        expect(status.find(f => f.path === 'new.txt')?.status).toBe('?');

        await runOp(['addremove', {type: 'repo-relative-file', path: 'new.txt'}]);

        status = await driver.fetchStatus(ctx);
        expect(status.find(f => f.path === 'new.txt')?.status).toBe('A');
      });

      it('addremove stages deletion of a missing (!) tracked file', async () => {
        await helpers.commit(tmpDir, 'initial', 'file.txt', 'content');
        // Delete without staging — file becomes '!' (missing, not staged)
        await fs.unlink(path.join(tmpDir, 'file.txt'));

        let status = await driver.fetchStatus(ctx);
        expect(status.find(f => f.path === 'file.txt')?.status).toBe('!');

        await runOp(['addremove', {type: 'repo-relative-file', path: 'file.txt'}]);

        status = await driver.fetchStatus(ctx);
        // Deletion is now staged: '!' → 'R'
        expect(status.find(f => f.path === 'file.txt')?.status).toBe('R');
      });

      it('addremove with no files stages all untracked files', async () => {
        await helpers.commit(tmpDir, 'initial', 'existing.txt', 'content');
        await fs.writeFile(path.join(tmpDir, 'a.txt'), 'a');
        await fs.writeFile(path.join(tmpDir, 'b.txt'), 'b');

        let status = await driver.fetchStatus(ctx);
        expect(status.find(f => f.path === 'a.txt')?.status).toBe('?');
        expect(status.find(f => f.path === 'b.txt')?.status).toBe('?');

        await runOp(['addremove']);

        status = await driver.fetchStatus(ctx);
        expect(status.find(f => f.path === 'a.txt')?.status).toBe('A');
        expect(status.find(f => f.path === 'b.txt')?.status).toBe('A');
      });

      it('forget stops tracking a staged file', async () => {
        await helpers.commit(tmpDir, 'initial', 'existing.txt', 'content');
        // Stage a new file so it shows as 'A'
        await fs.writeFile(path.join(tmpDir, 'tracked.txt'), 'new');
        await execFile(driver.command, ['add', 'tracked.txt'], {cwd: tmpDir});

        let status = await driver.fetchStatus(ctx);
        expect(status.find(f => f.path === 'tracked.txt')?.status).toBe('A');

        await runOp(['forget', {type: 'repo-relative-file', path: 'tracked.txt'}]);

        status = await driver.fetchStatus(ctx);
        // File should be untracked now
        expect(status.find(f => f.path === 'tracked.txt')?.status).toBe('?');
      });

      it('revert restores a modified file to HEAD content', async () => {
        await helpers.commit(tmpDir, 'initial', 'file.txt', 'original\n');
        await fs.writeFile(path.join(tmpDir, 'file.txt'), 'modified\n');

        let status = await driver.fetchStatus(ctx);
        expect(status.find(f => f.path === 'file.txt')?.status).toBe('M');

        await runOp(['revert', {type: 'repo-relative-file-list', paths: ['file.txt']}]);

        status = await driver.fetchStatus(ctx);
        expect(status.find(f => f.path === 'file.txt')).toBeUndefined();

        const content = await fs.readFile(path.join(tmpDir, 'file.txt'), 'utf-8');
        expect(content).toBe('original\n');
      });

      it('discard cleans all working directory changes', async () => {
        await helpers.commit(tmpDir, 'initial', 'file.txt', 'original\n');
        await fs.writeFile(path.join(tmpDir, 'file.txt'), 'dirty\n');

        let status = await driver.fetchStatus(ctx);
        expect(status.find(f => f.path === 'file.txt')?.status).toBe('M');

        // DiscardOperation sends ['goto', '--clean', '.']
        await runOp(['goto', '--clean', '.']);

        status = await driver.fetchStatus(ctx);
        expect(status.find(f => f.path === 'file.txt')).toBeUndefined();
      });
    });

    // ── Capability-gated: Fold ────────────────────────

    describe('Fold', () => {
      it('fold combines two commits', async () => {
        if (!driver.capabilities.fold) {
          return;
        }
        await helpers.commit(tmpDir, 'A', 'a.txt', 'a');
        await helpers.commit(tmpDir, 'B', 'b.txt', 'b');
        const hashB = await helpers.getHead(tmpDir);
        await helpers.commit(tmpDir, 'C', 'c.txt', 'c');
        const hashC = await helpers.getHead(tmpDir);

        // Run fold through the driver's operation system, the same way ISL does
        const resolved = driver.normalizeOperationArgs(tmpDir, tmpDir, {
          args: [
            'fold',
            '--exact',
            {type: 'exact-revset', revset: `${hashB}::${hashC}`},
            '--message',
            'Combined B and C',
          ],
          id: 'test-fold',
          runner: 0 as any,
          trackEventName: 'test' as any,
        });
        const {command, args: execArgs, options} = driver.getExecParams(
          resolved.args,
          tmpDir,
          undefined,
          resolved.env,
        );
        await execFile(command, execArgs, {...options, env: {...process.env, ...options.env}});

        const commits = await driver.fetchCommits(ctx, {type: 'none'}, defaultFetchOptions);
        // Old hash C should be gone (replaced by folded commit)
        expect(commits.find(c => c.hash === hashC)).toBeUndefined();
        const head = commits.find(c => c.isDot);
        expect(head).toBeDefined();
        expect(head!.title).toBe('Combined B and C');
      });
    });

    // ── Capability-gated: Hide ────────────────────────

    describe('Hide', () => {
      it('hide removes commit from smartlog', async () => {
        if (!driver.capabilities.hide) {
          return;
        }
        await helpers.commit(tmpDir, 'A', 'a.txt', 'a');
        await helpers.createAndCheckoutBranch(tmpDir, 'to-hide');
        await helpers.commit(tmpDir, 'B', 'b.txt', 'b');
        const hashB = await helpers.getHead(tmpDir);

        // Move HEAD away from the commit we want to hide
        await helpers.checkout(tmpDir, hashB + '^');

        // Run hide through the driver's operation system
        const resolved = driver.normalizeOperationArgs(tmpDir, tmpDir, {
          args: [
            'hide',
            '--rev',
            {type: 'exact-revset', revset: hashB},
          ],
          id: 'test-hide',
          runner: 0 as any,
          trackEventName: 'test' as any,
        });
        const {command, args: execArgs, options} = driver.getExecParams(
          resolved.args,
          tmpDir,
          undefined,
          resolved.env,
        );
        await execFile(command, execArgs, {...options, env: {...process.env, ...options.env}});

        const commits = await driver.fetchCommits(ctx, {type: 'none'}, defaultFetchOptions);
        expect(commits.find(c => c.hash === hashB)).toBeUndefined();
      });
    });
  });
}

// ── Run the suites ────────────────────────────────────

let hasSapling = false;
try {
  const {stdout} = require('node:child_process').execFileSync('sl', ['version'], {encoding: 'utf-8'});
  hasSapling = stdout.includes('Sapling');
} catch {
  // sl not available
}

let hasGit = false;
try {
  require('node:child_process').execFileSync('git', ['version'], {encoding: 'utf-8'});
  hasGit = true;
} catch {
  // git not available
}

if (hasSapling) {
  runVCSDriverTests('Sapling', () => new SaplingDriver(), saplingHelpers);
} else {
  describe('Sapling Driver Integration Tests', () => {
    it.skip('Sapling (sl) not available in this environment', () => {});
  });
}

if (hasGit) {
  runVCSDriverTests('Git', () => new GitDriver(), gitHelpers);

  describe('Git Driver Integration Tests (Git-specific)', () => {
    let tmpDir: string;
    let driver: GitDriver;

    beforeEach(async () => {
      const rawTmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'champagne-git-test-'));
      tmpDir = await fs.realpath(rawTmpDir);
      await gitHelpers.init(tmpDir);
      driver = new GitDriver();
    });

    afterEach(async () => {
      await fs.rm(tmpDir, {recursive: true, force: true});
    });

    describe('hasPotentialOperation', () => {
      const getDotDir = () => path.join(tmpDir, '.git');

      it('returns false when no operation is in progress', async () => {
        await gitHelpers.commit(tmpDir, 'initial', 'file.txt', 'content');
        expect(await driver.hasPotentialOperation(getDotDir())).toBe(false);
      });

      it('returns true when rebase-merge directory exists', async () => {
        const dotDir = getDotDir();
        await fs.mkdir(path.join(dotDir, 'rebase-merge'), {recursive: true});
        expect(await driver.hasPotentialOperation(dotDir)).toBe(true);
      });

      it('returns true when rebase-apply directory exists', async () => {
        const dotDir = getDotDir();
        await fs.mkdir(path.join(dotDir, 'rebase-apply'), {recursive: true});
        expect(await driver.hasPotentialOperation(dotDir)).toBe(true);
      });

      it('returns true when MERGE_HEAD file exists', async () => {
        const dotDir = getDotDir();
        await fs.writeFile(path.join(dotDir, 'MERGE_HEAD'), 'abc123\n');
        expect(await driver.hasPotentialOperation(dotDir)).toBe(true);
      });

      it('returns true when CHERRY_PICK_HEAD file exists', async () => {
        const dotDir = getDotDir();
        await fs.writeFile(path.join(dotDir, 'CHERRY_PICK_HEAD'), 'abc123\n');
        expect(await driver.hasPotentialOperation(dotDir)).toBe(true);
      });

      it('returns true during a real rebase conflict', async () => {
        await gitHelpers.commit(tmpDir, 'base', 'file.txt', 'base content');
        const hashBase = await gitHelpers.getHead(tmpDir);
        await gitHelpers.commit(tmpDir, 'change-A', 'file.txt', 'content from A');
        const hashA = await gitHelpers.getHead(tmpDir);
        await gitHelpers.checkout(tmpDir, hashBase);
        await gitHelpers.createAndCheckoutBranch(tmpDir, 'hasPotential-branch');
        await gitHelpers.commit(tmpDir, 'change-B', 'file.txt', 'content from B');
        try { await gitHelpers.rebase(tmpDir, hashA); } catch { /* expected */ }

        expect(await driver.hasPotentialOperation(getDotDir())).toBe(true);

        await gitHelpers.rebaseAbort(tmpDir);
      });
    });

    describe('Shallow Clone Handling', () => {
      let shallowDir: string;

      beforeEach(async () => {
        // Create a "remote" repo with history
        await gitHelpers.commit(tmpDir, 'first', 'a.txt', 'a');
        await gitHelpers.commit(tmpDir, 'second', 'b.txt', 'b');
        await gitHelpers.commit(tmpDir, 'third', 'c.txt', 'c');

        // Clone it shallowly
        const rawShallowDir = await fs.mkdtemp(path.join(os.tmpdir(), 'champagne-shallow-'));
        shallowDir = await fs.realpath(rawShallowDir);
        await execFile('git', ['clone', '--depth=1', tmpDir, shallowDir]);
      });

      afterEach(async () => {
        await fs.rm(shallowDir, {recursive: true, force: true});
      });

      it('fetchCommits works on a shallow clone', async () => {
        const shallowCtx = {
          cmd: 'git' as const,
          cwd: shallowDir,
          logger: mockLogger,
          tracker: mockTracker,
        };
        const commits = await driver.fetchCommits(shallowCtx, {type: 'none'}, defaultFetchOptions);
        expect(commits.length).toBeGreaterThanOrEqual(1);
      });

      it('fetchStatus works on a shallow clone', async () => {
        const shallowCtx = {
          cmd: 'git' as const,
          cwd: shallowDir,
          logger: mockLogger,
          tracker: mockTracker,
        };
        const status = await driver.fetchStatus(shallowCtx);
        expect(Array.isArray(status)).toBe(true);
      });
    });

    describe('Edge Cases', () => {
      it('fetchStatus handles filenames with spaces', async () => {
        await gitHelpers.commit(tmpDir, 'initial', 'normal.txt', 'content');
        await fs.writeFile(path.join(tmpDir, 'file with spaces.txt'), 'spaced content');
        const ctx = {cmd: 'git' as const, cwd: tmpDir, logger: mockLogger, tracker: mockTracker};
        const status = await driver.fetchStatus(ctx);
        const spaced = status.find(f => f.path === 'file with spaces.txt');
        expect(spaced).toBeDefined();
        expect(spaced!.status).toBe('?');
      });

      it('fetchStatus handles unicode filenames', async () => {
        await gitHelpers.commit(tmpDir, 'initial', 'normal.txt', 'content');
        await fs.writeFile(path.join(tmpDir, 'données.txt'), 'unicode content');
        const ctx = {cmd: 'git' as const, cwd: tmpDir, logger: mockLogger, tracker: mockTracker};
        const status = await driver.fetchStatus(ctx);
        const unicode = status.find(f => f.path.includes('donn'));
        expect(unicode).toBeDefined();
      });

      it('fetchCommits returns empty array for empty repo (no commits)', async () => {
        const emptyDir = await fs.realpath(
          await fs.mkdtemp(path.join(os.tmpdir(), 'champagne-empty-')),
        );
        try {
          await execFile('git', ['init'], {cwd: emptyDir});
          const ctx = {
            cmd: 'git' as const,
            cwd: emptyDir,
            logger: mockLogger,
            tracker: mockTracker,
          };
          const commits = await driver.fetchCommits(ctx, {type: 'none'}, defaultFetchOptions);
          expect(commits).toEqual([]);
        } finally {
          await fs.rm(emptyDir, {recursive: true, force: true});
        }
      });

      it('fetchStatus works in empty repo (no commits)', async () => {
        const emptyDir = await fs.realpath(
          await fs.mkdtemp(path.join(os.tmpdir(), 'champagne-empty-')),
        );
        try {
          await execFile('git', ['init'], {cwd: emptyDir});
          await fs.writeFile(path.join(emptyDir, 'new.txt'), 'new');
          const ctx = {
            cmd: 'git' as const,
            cwd: emptyDir,
            logger: mockLogger,
            tracker: mockTracker,
          };
          const status = await driver.fetchStatus(ctx);
          expect(status.find(f => f.path === 'new.txt')).toBeDefined();
        } finally {
          await fs.rm(emptyDir, {recursive: true, force: true});
        }
      });

      it('getDiffStats returns result (not crash) for root commit', async () => {
        await gitHelpers.commit(tmpDir, 'root', 'file.txt', 'content');
        const hash = await gitHelpers.getHead(tmpDir);
        const ctx = {cmd: 'git' as const, cwd: tmpDir, logger: mockLogger, tracker: mockTracker};
        const stats = await driver.getDiffStats(ctx, hash, []);
        expect(stats === undefined || typeof stats === 'number').toBe(true);
      });

      it('lookupCommits returns all requested commits', async () => {
        const hashes: string[] = [];
        for (let i = 0; i < 5; i++) {
          await gitHelpers.commit(tmpDir, `commit-${i}`, `file-${i}.txt`, `content-${i}`);
          hashes.push(await gitHelpers.getHead(tmpDir));
        }
        const ctx = {cmd: 'git' as const, cwd: tmpDir, logger: mockLogger, tracker: mockTracker};
        const commits = await driver.lookupCommits(ctx, {type: 'none'}, hashes);
        expect(commits.length).toBe(5);
        for (const hash of hashes) {
          expect(commits.find(c => c.hash === hash)).toBeDefined();
        }
      });
    });

    describe('Shell Script Operations (end-to-end)', () => {
      /** Run an operation through the full driver pipeline, same as ISL does at runtime. */
      async function runOp(args: RunnableOperation['args']): Promise<void> {
        const resolved = driver.normalizeOperationArgs(tmpDir, tmpDir, {
          args,
          id: 'test-op',
          runner: 0 as any,
          trackEventName: 'test' as any,
        });
        const {command, args: execArgs, options} = driver.getExecParams(
          resolved.args,
          tmpDir,
          undefined,
          resolved.env,
        );
        await execFile(command, execArgs, {...options, env: {...process.env, ...options.env}});
      }

      function mkCtx() {
        return {
          cmd: 'git' as const,
          cwd: tmpDir,
          logger: mockLogger,
          tracker: mockTracker,
        };
      }

      describe('goto (GotoOperation)', () => {
        it('goto with clean working tree checks out target commit', async () => {
          await gitHelpers.commit(tmpDir, 'A', 'a.txt', 'a');
          const hashA = await gitHelpers.getHead(tmpDir);
          await gitHelpers.commit(tmpDir, 'B', 'b.txt', 'b');

          await runOp(['goto', '--rev', hashA]);

          const head = await gitHelpers.getHead(tmpDir);
          expect(head).toBe(hashA);
        });

        it('goto with dirty working tree carries changes via stash', async () => {
          await gitHelpers.commit(tmpDir, 'A', 'a.txt', 'a');
          const hashA = await gitHelpers.getHead(tmpDir);
          await gitHelpers.commit(tmpDir, 'B', 'b.txt', 'b');
          // Modify a file that exists at both commits so stash pop works cleanly
          await fs.writeFile(path.join(tmpDir, 'a.txt'), 'modified');

          await runOp(['goto', '--rev', hashA]);

          const head = await gitHelpers.getHead(tmpDir);
          expect(head).toBe(hashA);
          const content = await fs.readFile(path.join(tmpDir, 'a.txt'), 'utf-8');
          expect(content).toBe('modified');
        });
      });

      describe('metaedit (AmendMessageOperation)', () => {
        it('metaedit on HEAD changes commit message and preserves branch', async () => {
          await gitHelpers.commit(tmpDir, 'original', 'file.txt', 'content');
          await gitHelpers.createAndCheckoutBranch(tmpDir, 'test-branch');
          // Need a commit on the branch so HEAD is on test-branch
          await gitHelpers.commit(tmpDir, 'branch commit', 'b.txt', 'b');

          await runOp(['metaedit', '--rev', 'HEAD', '--message', 'updated message']);

          const {stdout} = await execFile('git', ['log', '-1', '--format=%s'], {cwd: tmpDir});
          expect(stdout.trim()).toBe('updated message');
          const {stdout: branch} = await execFile('git', ['symbolic-ref', '--short', 'HEAD'], {cwd: tmpDir});
          expect(branch.trim()).toBe('test-branch');
        });

        it('metaedit on non-HEAD commit rebases stack', async () => {
          await gitHelpers.commit(tmpDir, 'base', 'base.txt', 'base');
          await gitHelpers.createAndCheckoutBranch(tmpDir, 'feature');
          await gitHelpers.commit(tmpDir, 'target', 'target.txt', 'target');
          const targetHash = await gitHelpers.getHead(tmpDir);
          await gitHelpers.commit(tmpDir, 'above', 'above.txt', 'above');

          await runOp(['metaedit', '--rev', targetHash, '--message', 'edited target']);

          const {stdout: branch} = await execFile('git', ['symbolic-ref', '--short', 'HEAD'], {cwd: tmpDir});
          expect(branch.trim()).toBe('feature');
          const {stdout: log} = await execFile('git', ['log', '--format=%s', '-3'], {cwd: tmpDir});
          const messages = log.trim().split('\n');
          expect(messages).toContain('above');
          expect(messages).toContain('edited target');
        });
      });

      describe('amend --to (AmendToOperation)', () => {
        it('amend --to HEAD amends current commit with specific file', async () => {
          await gitHelpers.commit(tmpDir, 'base', 'base.txt', 'base');
          await gitHelpers.createAndCheckoutBranch(tmpDir, 'feature');
          await gitHelpers.commit(tmpDir, 'target', 'file.txt', 'original');
          await fs.writeFile(path.join(tmpDir, 'file.txt'), 'amended content');

          await runOp(['amend', '--to', 'HEAD', 'file.txt']);

          const content = await fs.readFile(path.join(tmpDir, 'file.txt'), 'utf-8');
          expect(content).toBe('amended content');
          const {stdout: branch} = await execFile('git', ['symbolic-ref', '--short', 'HEAD'], {cwd: tmpDir});
          expect(branch.trim()).toBe('feature');
        });

        it('amend --to non-HEAD commit rebases stack', async () => {
          await gitHelpers.commit(tmpDir, 'base', 'base.txt', 'base');
          await gitHelpers.createAndCheckoutBranch(tmpDir, 'feature');
          await gitHelpers.commit(tmpDir, 'target', 'target.txt', 'original');
          const targetHash = await gitHelpers.getHead(tmpDir);
          await gitHelpers.commit(tmpDir, 'above', 'above.txt', 'above');
          await fs.writeFile(path.join(tmpDir, 'target.txt'), 'amended content');

          await runOp(['amend', '--to', targetHash, 'target.txt']);

          const {stdout: branch} = await execFile('git', ['symbolic-ref', '--short', 'HEAD'], {cwd: tmpDir});
          expect(branch.trim()).toBe('feature');
          const {stdout: log} = await execFile('git', ['log', '--format=%s', '-3'], {cwd: tmpDir});
          const messages = log.trim().split('\n');
          expect(messages).toContain('above');
          expect(messages).toContain('target');
        });
      });

      describe('rebase -s SRC -d DEST (RebaseOperation)', () => {
        it('rebases a single commit to a new destination', async () => {
          await gitHelpers.commit(tmpDir, 'base', 'base.txt', 'base');
          const baseHash = await gitHelpers.getHead(tmpDir);
          await gitHelpers.commit(tmpDir, 'main-next', 'main.txt', 'main');
          const mainNext = await gitHelpers.getHead(tmpDir);
          await gitHelpers.checkout(tmpDir, baseHash);
          await gitHelpers.createAndCheckoutBranch(tmpDir, 'feature');
          await gitHelpers.commit(tmpDir, 'feature-commit', 'feat.txt', 'feat');
          const featHash = await gitHelpers.getHead(tmpDir);

          await runOp(['rebase', '-s', featHash, '-d', mainNext]);

          const commits = await driver.fetchCommits(mkCtx(), {type: 'none'}, defaultFetchOptions);
          const feat = commits.find(c => c.title === 'feature-commit');
          expect(feat).toBeDefined();
          expect(feat!.parents).toContain(mainNext);
        });

        it('rebases a stack of commits (preserves descendants)', async () => {
          await gitHelpers.commit(tmpDir, 'base', 'base.txt', 'base');
          const baseHash = await gitHelpers.getHead(tmpDir);
          await gitHelpers.commit(tmpDir, 'main-next', 'main.txt', 'main');
          const mainNext = await gitHelpers.getHead(tmpDir);
          await gitHelpers.checkout(tmpDir, baseHash);
          await gitHelpers.createAndCheckoutBranch(tmpDir, 'feature');
          await gitHelpers.commit(tmpDir, 'stack-A', 'sa.txt', 'sa');
          const stackA = await gitHelpers.getHead(tmpDir);
          await gitHelpers.commit(tmpDir, 'stack-B', 'sb.txt', 'sb');

          await runOp(['rebase', '-s', stackA, '-d', mainNext]);

          const commits = await driver.fetchCommits(mkCtx(), {type: 'none'}, defaultFetchOptions);
          const rebasedA = commits.find(c => c.title === 'stack-A');
          const rebasedB = commits.find(c => c.title === 'stack-B');
          expect(rebasedA).toBeDefined();
          expect(rebasedB).toBeDefined();
          expect(rebasedA!.parents).toContain(mainNext);
          expect(rebasedB!.parents).toContain(rebasedA!.hash);
        });
      });

      describe('continue (ContinueOperation)', () => {
        it('continue resolves a rebase conflict and finishes rebase', async () => {
          await gitHelpers.commit(tmpDir, 'base', 'file.txt', 'base content');
          const baseHash = await gitHelpers.getHead(tmpDir);
          await gitHelpers.commit(tmpDir, 'change-A', 'file.txt', 'content from A');
          const hashA = await gitHelpers.getHead(tmpDir);
          await gitHelpers.checkout(tmpDir, baseHash);
          await gitHelpers.createAndCheckoutBranch(tmpDir, 'conflict-branch');
          await gitHelpers.commit(tmpDir, 'change-B', 'file.txt', 'content from B');

          try { await gitHelpers.rebase(tmpDir, hashA); } catch { /* expected conflict */ }

          await fs.writeFile(path.join(tmpDir, 'file.txt'), 'resolved content');
          await execFile('git', ['add', 'file.txt'], {cwd: tmpDir});

          await runOp(['continue']);

          const conflicts = await driver.checkMergeConflicts(mkCtx(), undefined);
          expect(conflicts).toBeUndefined();
          const head = await gitHelpers.getHead(tmpDir);
          const {stdout} = await execFile('git', ['log', '--format=%P', '-1', head], {cwd: tmpDir});
          expect(stdout.trim()).toBe(hashA);
        });
      });

      describe('rebase --abort (AbortOperation)', () => {
        it('abort returns to pre-rebase state', async () => {
          await gitHelpers.commit(tmpDir, 'base', 'file.txt', 'base content');
          const baseHash = await gitHelpers.getHead(tmpDir);
          await gitHelpers.commit(tmpDir, 'change-A', 'file.txt', 'content from A');
          const hashA = await gitHelpers.getHead(tmpDir);
          await gitHelpers.checkout(tmpDir, baseHash);
          await gitHelpers.createAndCheckoutBranch(tmpDir, 'abort-branch');
          await gitHelpers.commit(tmpDir, 'change-B', 'file.txt', 'content from B');
          const hashB = await gitHelpers.getHead(tmpDir);

          try { await gitHelpers.rebase(tmpDir, hashA); } catch { /* expected */ }

          await runOp(['rebase', '--abort']);

          const head = await gitHelpers.getHead(tmpDir);
          expect(head).toBe(hashB);
          const conflicts = await driver.checkMergeConflicts(mkCtx(), undefined);
          expect(conflicts).toBeUndefined();
        });
      });

      describe('resolve --tool (conflict resolution)', () => {
        async function createRebaseConflict(): Promise<{hashA: string}> {
          await gitHelpers.commit(tmpDir, 'base', 'file.txt', 'line1\nline2\nline3\n');
          const baseHash = await gitHelpers.getHead(tmpDir);
          await gitHelpers.commit(tmpDir, 'change-A', 'file.txt', 'line1\nchanged-by-A\nline3\n');
          const hashA = await gitHelpers.getHead(tmpDir);
          await gitHelpers.checkout(tmpDir, baseHash);
          await gitHelpers.createAndCheckoutBranch(tmpDir, 'resolve-test');
          await gitHelpers.commit(tmpDir, 'change-B', 'file.txt', 'line1\nchanged-by-B\nline3\n');
          try { await gitHelpers.rebase(tmpDir, hashA); } catch { /* expected */ }
          return {hashA};
        }

        it('resolve --tool internal:merge-local keeps ours (destination in rebase)', async () => {
          await createRebaseConflict();
          await runOp(['resolve', '--tool', 'internal:merge-local', 'file.txt']);
          const content = await fs.readFile(path.join(tmpDir, 'file.txt'), 'utf-8');
          expect(content).toContain('changed-by-A');
          expect(content).not.toContain('<<<<');
        });

        it('resolve --tool internal:merge-other keeps theirs (source in rebase)', async () => {
          await createRebaseConflict();
          await runOp(['resolve', '--tool', 'internal:merge-other', 'file.txt']);
          const content = await fs.readFile(path.join(tmpDir, 'file.txt'), 'utf-8');
          expect(content).toContain('changed-by-B');
          expect(content).not.toContain('<<<<');
        });

        it('resolve --tool internal:union includes both changes', async () => {
          await createRebaseConflict();
          await runOp(['resolve', '--tool', 'internal:union', 'file.txt']);
          const content = await fs.readFile(path.join(tmpDir, 'file.txt'), 'utf-8');
          expect(content).toContain('changed-by-A');
          expect(content).toContain('changed-by-B');
          expect(content).not.toContain('<<<<');
        });

        it('resolve --mark stages a manually resolved file', async () => {
          await createRebaseConflict();
          await fs.writeFile(path.join(tmpDir, 'file.txt'), 'manually resolved\n');
          await runOp(['resolve', '--mark', 'file.txt']);
          const {stdout} = await execFile('git', ['status', '--porcelain'], {cwd: tmpDir});
          expect(stdout).not.toContain('UU');
        });
      });
    });
  });
} else {
  describe('Git Driver Integration Tests', () => {
    it.skip('Git not available in this environment', () => {});
  });
}
