/**
 * Integration tests for GitDriver against a large real repository.
 * Uses ~/Projects/applied3 (141K+ commits, 14K+ remote branches).
 *
 * These tests verify:
 * 1. fetchCommits completes in reasonable time on a large repo
 * 2. The returned data is correct and sufficient for the client to render
 * 3. Performance characteristics of individual steps
 *
 * Skipped if ~/Projects/applied3 doesn't exist.
 */

import type {RepositoryContext} from '../serverTypes';
import type {ServerPlatform} from '../serverPlatform';

import fs from 'node:fs/promises';
import path from 'node:path';
import {mockLogger} from 'shared/testUtils';
import {makeServerSideTracker} from '../analytics/serverSideTracker';
import {GitDriver} from '../vcs/GitDriver';

const APPLIED3_PATH = path.join(process.env.HOME ?? '~', 'Projects', 'applied3');

const mockTracker = makeServerSideTracker(
  mockLogger,
  {platformName: 'test'} as ServerPlatform,
  '0.1',
  jest.fn(),
);

let repoExists = false;

beforeAll(async () => {
  try {
    await fs.access(path.join(APPLIED3_PATH, '.git'));
    repoExists = true;
  } catch {
    repoExists = false;
  }
});

function skipIfNoRepo() {
  if (!repoExists) {
    return true;
  }
  return false;
}

describe('GitDriver on large repo (applied3)', () => {
  let driver: GitDriver;
  let ctx: RepositoryContext;

  beforeEach(() => {
    driver = new GitDriver();
    ctx = {
      cmd: 'git',
      cwd: APPLIED3_PATH,
      logger: mockLogger,
      tracker: mockTracker,
    };
  });

  describe('fetchCommits', () => {
    it('completes within 10 seconds with 14-day range', async () => {
      if (skipIfNoRepo()) {
        return;
      }

      const start = Date.now();
      const commits = await driver.fetchCommits(ctx, {type: 'none'}, {
        maxDraftDays: 14,
        stableLocations: [],
        recommendedBookmarks: [],
      });
      const elapsed = Date.now() - start;

      console.log(`fetchCommits: ${commits.length} commits in ${elapsed}ms`);
      console.log(`  public: ${commits.filter(c => c.phase === 'public').length}`);
      console.log(`  draft: ${commits.filter(c => c.phase === 'draft').length}`);
      console.log(`  isDot: ${commits.filter(c => c.isDot).length}`);

      // Must complete within 10 seconds
      expect(elapsed).toBeLessThan(10_000);
      // Must return at least some commits
      expect(commits.length).toBeGreaterThan(0);
    }, 30_000);

    it('completes within 15 seconds with 60-day range', async () => {
      if (skipIfNoRepo()) {
        return;
      }

      const start = Date.now();
      const commits = await driver.fetchCommits(ctx, {type: 'none'}, {
        maxDraftDays: 60,
        stableLocations: [],
        recommendedBookmarks: [],
      });
      const elapsed = Date.now() - start;

      console.log(`fetchCommits (60d): ${commits.length} commits in ${elapsed}ms`);

      expect(elapsed).toBeLessThan(15_000);
      expect(commits.length).toBeGreaterThan(0);
    }, 30_000);

    it('completes within 30 seconds with unlimited range', async () => {
      if (skipIfNoRepo()) {
        return;
      }

      const start = Date.now();
      const commits = await driver.fetchCommits(ctx, {type: 'none'}, {
        maxDraftDays: undefined,
        stableLocations: [],
        recommendedBookmarks: [],
      });
      const elapsed = Date.now() - start;

      console.log(`fetchCommits (unlimited): ${commits.length} commits in ${elapsed}ms`);

      expect(elapsed).toBeLessThan(30_000);
      expect(commits.length).toBeGreaterThan(0);
    }, 60_000);
  });

  describe('fetchCommits output correctness', () => {
    it('returns commits with correct structure', async () => {
      if (skipIfNoRepo()) {
        return;
      }

      const commits = await driver.fetchCommits(ctx, {type: 'none'}, {
        maxDraftDays: 14,
        stableLocations: [],
        recommendedBookmarks: [],
      });

      // Basic structure checks
      for (const commit of commits) {
        expect(commit.hash).toMatch(/^[0-9a-f]{40}$/);
        expect(commit.title).toBeTruthy();
        expect(commit.author).toBeTruthy();
        expect(commit.date).toBeInstanceOf(Date);
        expect(['public', 'draft']).toContain(commit.phase);
        expect(Array.isArray(commit.parents)).toBe(true);
        expect(Array.isArray(commit.bookmarks)).toBe(true);
        expect(Array.isArray(commit.remoteBookmarks)).toBe(true);
      }
    }, 30_000);

    it('marks exactly one commit as isDot (HEAD)', async () => {
      if (skipIfNoRepo()) {
        return;
      }

      const commits = await driver.fetchCommits(ctx, {type: 'none'}, {
        maxDraftDays: 14,
        stableLocations: [],
        recommendedBookmarks: [],
      });

      const dotCommits = commits.filter(c => c.isDot);
      expect(dotCommits).toHaveLength(1);
      console.log(`HEAD commit: ${dotCommits[0].hash.slice(0, 12)} "${dotCommits[0].title}"`);
    }, 30_000);

    it('classifies HEAD as public when on master', async () => {
      if (skipIfNoRepo()) {
        return;
      }

      const commits = await driver.fetchCommits(ctx, {type: 'none'}, {
        maxDraftDays: 14,
        stableLocations: [],
        recommendedBookmarks: [],
      });

      const head = commits.find(c => c.isDot);
      expect(head).toBeDefined();
      // On master, HEAD should be public
      expect(head!.phase).toBe('public');
    }, 30_000);

    it('has at least some commits with bookmarks', async () => {
      if (skipIfNoRepo()) {
        return;
      }

      const commits = await driver.fetchCommits(ctx, {type: 'none'}, {
        maxDraftDays: 14,
        stableLocations: [],
        recommendedBookmarks: [],
      });

      const withBookmarks = commits.filter(c => c.bookmarks.length > 0);
      console.log(`Commits with bookmarks: ${withBookmarks.length}`);
      // master branch at minimum should show up
      expect(withBookmarks.length).toBeGreaterThanOrEqual(1);
    }, 30_000);

    it('has commits with valid parent references', async () => {
      if (skipIfNoRepo()) {
        return;
      }

      const commits = await driver.fetchCommits(ctx, {type: 'none'}, {
        maxDraftDays: 14,
        stableLocations: [],
        recommendedBookmarks: [],
      });

      // All parent hashes should be valid hex
      for (const commit of commits) {
        for (const parent of commit.parents) {
          expect(parent).toMatch(/^[0-9a-f]{40}$/);
        }
      }

      // At least some commits should have parents (non-root)
      const withParents = commits.filter(c => c.parents.length > 0);
      expect(withParents.length).toBeGreaterThan(0);
    }, 30_000);

    it('returns enough data for client haveCommitsLoadedYet check', async () => {
      if (skipIfNoRepo()) {
        return;
      }

      const commits = await driver.fetchCommits(ctx, {type: 'none'}, {
        maxDraftDays: 14,
        stableLocations: [],
        recommendedBookmarks: [],
      });

      // The client checks: data.commits.length > 0 || data.error != null
      // If commits is empty, the UI stays in "loading" state forever
      expect(commits.length).toBeGreaterThan(0);
      console.log(`Client would receive ${commits.length} commits — loading state will clear`);
    }, 30_000);
  });

  describe('fetchStatus', () => {
    it('completes within 5 seconds', async () => {
      if (skipIfNoRepo()) {
        return;
      }

      const start = Date.now();
      const files = await driver.fetchStatus(ctx);
      const elapsed = Date.now() - start;

      console.log(`fetchStatus: ${files.length} changed files in ${elapsed}ms`);
      expect(elapsed).toBeLessThan(5_000);
    }, 10_000);
  });

  describe('component timing breakdown', () => {
    it('measures individual step timing', async () => {
      if (skipIfNoRepo()) {
        return;
      }

      // Step 1: public hashes
      const t1 = Date.now();
      const publicResult = await driver.runCommand(ctx, [
        'rev-list', '--max-count=50000', 'origin/master',
      ]);
      const publicCount = publicResult.stdout.trim().split('\n').length;
      const t1Elapsed = Date.now() - t1;

      // Step 2: HEAD
      const t2 = Date.now();
      await driver.runCommand(ctx, ['rev-parse', 'HEAD']);
      const t2Elapsed = Date.now() - t2;

      // Step 3: for-each-ref
      const t3 = Date.now();
      const refsResult = await driver.runCommand(ctx, [
        'for-each-ref', '--count=2000', '--sort=-committerdate',
        '--format=%(objectname) %(refname)', 'refs/heads/', 'refs/remotes/',
      ]);
      const refCount = refsResult.stdout.trim().split('\n').length;
      const t3Elapsed = Date.now() - t3;

      // Step 4: git log (the critical one)
      const since = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString();
      const t4 = Date.now();
      const logResult = await driver.runCommand(ctx, [
        'log', 'HEAD', '--glob=refs/heads/',
        '--format=%H%x00%P%x00%an%x00%ae%x00%cI%x00%s%x00%b<<COMMIT_END>>',
        '--topo-order', '--max-count=10000', '--since=' + since,
      ]);
      const commitCount = (logResult.stdout.match(/<<COMMIT_END>>/g) || []).length;
      const t4Elapsed = Date.now() - t4;

      console.log('=== Component Timing ===');
      console.log(`  rev-list (${publicCount} public hashes): ${t1Elapsed}ms`);
      console.log(`  rev-parse HEAD: ${t2Elapsed}ms`);
      console.log(`  for-each-ref (${refCount} refs): ${t3Elapsed}ms`);
      console.log(`  git log (${commitCount} commits): ${t4Elapsed}ms`);
      console.log(`  TOTAL: ${t1Elapsed + t2Elapsed + t3Elapsed + t4Elapsed}ms`);

      // Sanity: no single step should take more than 10 seconds
      expect(t1Elapsed).toBeLessThan(10_000);
      expect(t3Elapsed).toBeLessThan(10_000);
      expect(t4Elapsed).toBeLessThan(10_000);
    }, 60_000);
  });
});
