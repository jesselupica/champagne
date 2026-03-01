/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import type {CommandArg, RunnableOperation} from 'isl/src/types';
import type {ResolvedCommand} from '../vcs/types';
import {CommandRunner} from 'isl/src/types';
import {GitDriver} from '../vcs/GitDriver';

const driver = new GitDriver();
const cwd = '/repo';
const repoRoot = '/repo';

function makeOp(args: RunnableOperation['args'], stdin?: string): RunnableOperation {
  return {
    args,
    stdin,
    id: 'test-op',
    runner: CommandRunner.Sapling,
    trackEventName: 'RunOperation', // not used by normalizeOperationArgs
  };
}

function translate(args: string[], stdin?: string): ResolvedCommand {
  return driver.normalizeOperationArgs(cwd, repoRoot, makeOp(args, stdin));
}

function translateFull(args: CommandArg[], stdin?: string): ResolvedCommand {
  return driver.normalizeOperationArgs(cwd, repoRoot, makeOp(args, stdin));
}

describe('GitDriver.normalizeOperationArgs', () => {
  it('passes unknown commands through unchanged', () => {
    expect(translate(['status'])).toEqual({args: ['status']});
  });

  describe('commit', () => {
    it('strips --addremove', () => {
      expect(translate(['commit', '--addremove', '--message', 'hello'])).toEqual({
        args: ['commit', '--message', 'hello'],
      });
    });

    it('passes through commit without --addremove unchanged', () => {
      expect(translate(['commit', '--message', 'hello'])).toEqual({
        args: ['commit', '--message', 'hello'],
      });
    });
  });

  describe('amend', () => {
    it('translates to git commit --amend', () => {
      expect(translate(['amend', '--addremove', '--message', 'updated'])).toEqual({
        args: ['commit', '--amend', '--message', 'updated'],
      });
    });

    it('renames --user to --author', () => {
      expect(translate(['amend', '--user', 'Alice <a@b.com>', '--message', 'msg'])).toEqual({
        args: ['commit', '--amend', '--author', 'Alice <a@b.com>', '--message', 'msg'],
      });
    });

    it('adds --no-edit when no --message is given', () => {
      expect(translate(['amend', '--addremove'])).toEqual({
        args: ['commit', '--amend', '--no-edit'],
      });
    });

    it('handles config arg before command (AmendOperation shape)', () => {
      expect(translateFull([
        {type: 'config', key: 'amend.autorestack', value: 'always_restack'},
        'amend',
        '--addremove',
        '--message',
        'msg',
      ])).toEqual({
        args: ['-c', 'amend.autorestack=always_restack', 'commit', '--amend', '--message', 'msg'],
      });
    });

    it('adds --no-edit with config arg prefix when no --message', () => {
      expect(translateFull([
        {type: 'config', key: 'amend.autorestack', value: 'always_restack'},
        'amend',
        '--addremove',
      ])).toEqual({
        args: ['-c', 'amend.autorestack=always_restack', 'commit', '--amend', '--no-edit'],
      });
    });
  });

  describe('metaedit (AmendMessageOperation)', () => {
    it('amends a non-HEAD commit by checking it out, amending, then rebasing the stack', () => {
      const result = translate(['metaedit', '--rev', 'abc123', '--message', 'new msg']);
      expect(result.args[0]).toBe('__shell__');
      const script = result.args[1] as string;
      expect(script).toContain('checkout "abc123"');
      expect(script).toContain('commit --amend');
      expect(script).toContain('new msg');
      expect(script).toContain('rebase --onto');
      // checkout must come before amend
      expect(script.indexOf('checkout "abc123"')).toBeLessThan(script.indexOf('commit --amend'));
    });

    it('includes --author when --user is provided', () => {
      const result = translate(['metaedit', '--rev', 'abc123', '--user', 'Bob <b@c.com>', '--message', 'msg']);
      expect(result.args[0]).toBe('__shell__');
      expect(result.args[1]).toContain('--author');
      expect(result.args[1]).toContain('Bob');
    });

    it('metaedit amending HEAD commit updates branch pointer (branch -f)', () => {
      const result = translate(['metaedit', '--rev', 'HEAD', '--message', 'updated msg']);
      expect(result.args[0]).toBe('__shell__');
      const script = result.args[1] as string;
      // When TARGET_SHA == ORIG_TIP (HEAD case), must force-update branch pointer
      expect(script).toContain('git branch -f "$ORIG_BRANCH" $NEW_HASH');
      expect(script).toContain('git checkout "$ORIG_BRANCH"');
      expect(script).toContain('git checkout --detach $NEW_HASH');
    });
  });

  describe('goto', () => {
    it('translates goto --rev HASH to checkout HASH', () => {
      expect(translate(['goto', '--rev', 'abc123'])).toEqual({
        args: ['checkout', 'abc123'],
      });
    });

    it('translates goto --clean . to checkout -- .', () => {
      expect(translate(['goto', '--clean', '.'])).toEqual({
        args: ['checkout', '--', '.'],
      });
    });
  });

  describe('revert', () => {
    it('translates revert --rev HASH file to checkout HASH -- file', () => {
      expect(translate(['revert', '--rev', 'abc123', 'file.txt'])).toEqual({
        args: ['checkout', 'abc123', '--', 'file.txt'],
      });
    });

    it('handles multiple files', () => {
      expect(translate(['revert', '--rev', 'abc123', 'a.txt', 'b.txt'])).toEqual({
        args: ['checkout', 'abc123', '--', 'a.txt', 'b.txt'],
      });
    });
  });

  describe('rebase', () => {
    it('translates rebase -s SRC -d DEST to rebase --onto DEST SRC^ SRC', () => {
      expect(translate(['rebase', '-s', 'abc123', '-d', 'def456'])).toEqual({
        args: ['rebase', '--onto', 'def456', 'abc123^', 'abc123'],
      });
    });

  });

  describe('rebase --keep with --dest (RebaseKeepOperation)', () => {
    it('checks out destination before cherry-pick when --dest is provided', () => {
      const result = translate(['rebase', '--keep', '--rev', 'abc123', '--dest', 'def456']);
      expect(result.args[0]).toBe('__shell__');
      const script = result.args[1] as string;
      expect(script).toContain('checkout "def456"');
      expect(script).toContain('cherry-pick "abc123"');
      // Verify ordering: checkout must precede cherry-pick
      expect(script.indexOf('checkout')).toBeLessThan(script.indexOf('cherry-pick'));
    });

    it('falls back to direct cherry-pick when --dest is absent', () => {
      expect(translate(['rebase', '--keep', '--rev', 'abc123'])).toEqual({
        args: ['cherry-pick', 'abc123'],
        stdin: undefined,
      });
    });

    it('also works with -d short form', () => {
      const result = translate(['rebase', '--keep', '--rev', 'abc123', '-d', 'def456']);
      expect(result.args[0]).toBe('__shell__');
      expect(result.args[1]).toContain('checkout "def456"');
      expect(result.args[1]).toContain('cherry-pick "abc123"');
    });
  });

  describe('rebase --rev (BulkRebaseOperation)', () => {
    it('translates multiple --rev args to checkout + cherry-pick', () => {
      const result = translate(['rebase', '--rev', 'abc123', '--rev', 'def456', '-d', 'xyz789']);
      expect(result.args[0]).toBe('__shell__');
      expect(result.args[1]).toContain('checkout "xyz789"');
      expect(result.args[1]).toContain('cherry-pick "abc123" "def456"');
    });

    it('works with a single --rev', () => {
      const result = translate(['rebase', '--rev', 'abc123', '-d', 'xyz789']);
      expect(result.args[0]).toBe('__shell__');
      expect(result.args[1]).toContain('checkout "xyz789"');
      expect(result.args[1]).toContain('cherry-pick "abc123"');
    });

    it('throws if -d is missing', () => {
      expect(() => translate(['rebase', '--rev', 'abc123'])).toThrow();
    });

    it('does not activate for args without --rev (falls through to standard rebase)', () => {
      // Without --rev, should fall through to standard rebase path (which requires -s and -d)
      expect(() => translate(['rebase', '-s', 'abc123', '-d', 'xyz789'])).not.toThrow('rebase --rev');
    });
  });

  describe('rebase -s draft() (RebaseAllDraftCommitsOperation)', () => {
    it('translates draft() source to merge-base shell script', () => {
      const result = translate(['rebase', '-s', 'draft()', '-d', 'abc123']);
      expect(result.args[0]).toBe('__shell__');
      expect(result.args[1]).toContain('merge-base');
      expect(result.args[1]).toContain('rebase --onto "abc123"');
      expect(result.args[1]).toContain('$BASE HEAD');
    });

    it('also handles draft()&date(-7) source', () => {
      const result = translate(['rebase', '-s', 'draft()&date(-7)', '-d', 'abc123']);
      expect(result.args[0]).toBe('__shell__');
      expect(result.args[1]).toContain('merge-base');
      expect(result.args[1]).toContain('rebase --onto "abc123"');
      expect(result.args[1]).toContain('$BASE HEAD');
    });

    it('tries remote tracking branches in order before falling back to rev-list', () => {
      const result = translate(['rebase', '-s', 'draft()', '-d', 'abc123']);
      const script = result.args[1] as string;
      const headIdx = script.indexOf('origin/HEAD');
      const mainIdx = script.indexOf('origin/main');
      const masterIdx = script.indexOf('origin/master');
      const revListIdx = script.indexOf('rev-list');
      expect(headIdx).toBeGreaterThan(-1);
      expect(mainIdx).toBeGreaterThan(-1);
      expect(masterIdx).toBeGreaterThan(-1);
      expect(revListIdx).toBeGreaterThan(-1);
      expect(headIdx).toBeLessThan(mainIdx);
      expect(mainIdx).toBeLessThan(masterIdx);
      expect(masterIdx).toBeLessThan(revListIdx);
    });
  });

  describe('rebase --abort', () => {
    it('generates a shell script that detects the in-progress operation and aborts it', () => {
      const result = translate(['rebase', '--abort']);
      expect(result.args[0]).toBe('__shell__');
      // Uses git rev-parse --git-path for worktree-safe path resolution
      expect(result.args[1]).toContain('git rev-parse --git-path');
      expect(result.args[1]).toContain('REBASE_MERGE');
      expect(result.args[1]).toContain('REBASE_APPLY');
      expect(result.args[1]).toContain('rebase --abort');
      expect(result.args[1]).toContain('MERGE_HEAD');
      expect(result.args[1]).toContain('merge --abort');
      expect(result.args[1]).toContain('CHERRY_PICK_HEAD');
      expect(result.args[1]).toContain('cherry-pick --abort');
    });

    it('generates a shell script for --quit that saves already-rebased commits', () => {
      const result = translate(['rebase', '--quit']);
      expect(result.args[0]).toBe('__shell__');
      // Uses git rev-parse --git-path for worktree-safe path resolution
      expect(result.args[1]).toContain('git rev-parse --git-path');
      expect(result.args[1]).toContain('rewritten-list');
      expect(result.args[1]).toContain('rebase --abort');
      expect(result.args[1]).toContain('cherry-pick');
    });
  });

  describe('bookmark', () => {
    it('translates bookmark NAME --rev HASH to branch NAME HASH', () => {
      expect(translate(['bookmark', 'my-branch', '--rev', 'abc123'])).toEqual({
        args: ['branch', 'my-branch', 'abc123'],
      });
    });

    it('translates bookmark --delete NAME to branch -d NAME', () => {
      expect(translate(['bookmark', '--delete', 'my-branch'])).toEqual({
        args: ['branch', '-d', 'my-branch'],
      });
    });
  });

  describe('shelve', () => {
    it('translates shelve to git stash push', () => {
      expect(translate(['shelve', '--unknown', '--name', 'wip', 'file.txt'])).toEqual({
        args: ['stash', 'push', '-u', '-m', 'wip', '--', 'file.txt'],
      });
    });

    it('translates shelve with no files', () => {
      expect(translate(['shelve', '--unknown', '--name', 'wip'])).toEqual({
        args: ['stash', 'push', '-u', '-m', 'wip'],
      });
    });

    it('translates shelve --delete to stash drop', () => {
      expect(translate(['shelve', '--delete', 'wip'])).toEqual({
        args: ['stash', 'drop'],
      });
    });
  });

  describe('unshelve', () => {
    it('translates unshelve --keep to stash apply', () => {
      expect(translate(['unshelve', '--keep', '--name', 'wip'])).toEqual({
        args: ['stash', 'apply'],
      });
    });

    it('translates unshelve (no --keep) to stash pop', () => {
      expect(translate(['unshelve', '--name', 'wip'])).toEqual({
        args: ['stash', 'pop'],
      });
    });
  });

  describe('graft', () => {
    it('translates graft HASH to cherry-pick HASH', () => {
      expect(translate(['graft', 'abc123'])).toEqual({
        args: ['cherry-pick', 'abc123'],
      });
    });
  });

  describe('uncommit', () => {
    it('translates uncommit to reset --soft HEAD~1', () => {
      expect(translate(['uncommit'])).toEqual({
        args: ['reset', '--soft', 'HEAD~1'],
      });
    });
  });

  describe('resolve', () => {
    it('translates resolve --mark file to add file', () => {
      expect(translate(['resolve', '--mark', 'conflict.txt'])).toEqual({
        args: ['add', 'conflict.txt'],
      });
    });

    it('translates resolve --unmark file to rm --cached file', () => {
      expect(translate(['resolve', '--unmark', 'conflict.txt'])).toEqual({
        args: ['rm', '--cached', 'conflict.txt'],
      });
    });
  });

  describe('continue (ContinueOperation)', () => {
    it('generates a shell script that routes to the correct --continue based on git state', () => {
      const result = translate(['continue']);
      expect(result.args[0]).toBe('__shell__');
      expect(result.args[1]).toContain('git rev-parse --git-path');
      expect(result.args[1]).toContain('REBASE_MERGE');
      expect(result.args[1]).toContain('REBASE_APPLY');
      expect(result.args[1]).toContain('rebase --continue');
      expect(result.args[1]).toContain('MERGE_HEAD');
      expect(result.args[1]).toContain('commit --no-edit');
      expect(result.args[1]).toContain('CHERRY_PICK_HEAD');
      expect(result.args[1]).toContain('cherry-pick --continue');
      expect(result.args[1]).toContain('exit 1');
    });
  });

  describe('purge', () => {
    it('translates purge --files file to shell rm -f file', () => {
      const result = translate(['purge', '--files', '--abort-on-err', 'dead.txt']);
      expect(result.args[0]).toBe('__shell__');
      expect(result.args[1]).toContain('dead.txt');
    });

    it('handles multiple files', () => {
      const result = translate(['purge', '--files', 'a.txt', 'b.txt']);
      expect(result.args[0]).toBe('__shell__');
      expect(result.args[1]).toContain('a.txt');
      expect(result.args[1]).toContain('b.txt');
    });

    it('handles purge with no files gracefully', () => {
      const result = translate(['purge', '--files', '--abort-on-err']);
      expect(result.args[0]).toBe('__shell__');
      expect(result.args[1]).toBe('true');
    });
  });

  describe('addremove', () => {
    it('translates addremove with specific files to git add --', () => {
      expect(translate(['addremove', 'new.txt', 'deleted.txt'])).toEqual({
        args: ['add', '--', 'new.txt', 'deleted.txt'],
      });
    });

    it('translates addremove with no files to git add -A', () => {
      expect(translate(['addremove'])).toEqual({
        args: ['add', '-A'],
      });
    });

    it('translates addremove with a single file', () => {
      expect(translate(['addremove', 'untracked.txt'])).toEqual({
        args: ['add', '--', 'untracked.txt'],
      });
    });
  });

  describe('push', () => {
    it('translates push --rev REV --to BRANCH REMOTE to push REMOTE REV:BRANCH', () => {
      expect(translate(['push', '--rev', 'abc123', '--to', 'main', 'origin'])).toEqual({
        args: ['push', 'origin', 'abc123:main'],
      });
    });

    it('uses origin as default remote if none specified', () => {
      expect(translate(['push', '--rev', 'abc123', '--to', 'main'])).toEqual({
        args: ['push', 'origin', 'abc123:main'],
      });
    });
  });

  describe('hide --rev (HideOperation)', () => {
    it('uses --contains to find descendant branches, not just --points-at', () => {
      const result = translate(['hide', '--rev', 'abc123']);
      expect(result.args[0]).toBe('__shell__');
      expect(result.args[1]).toContain('--contains "abc123"');
      expect(result.args[1]).not.toContain('--points-at');
    });

    it('still deletes branches and moves HEAD away if needed', () => {
      const result = translate(['hide', '--rev', 'abc123']);
      expect(result.args[1]).toContain('branch -D');
      // Verify HEAD-movement logic is present
      expect(result.args[1]).toContain('checkout --detach');
      expect(result.args[1]).toContain('symbolic-ref');
    });
  });

  describe('fold --exact (FoldOperation)', () => {
    it('generates a shell script that limits squash to the exact range', () => {
      const result = translate(['fold', '--exact', 'aaa111::bbb222', '--message', 'merged']);
      expect(result.args[0]).toBe('__shell__');
      const script = result.args[1] as string;
      // Both hashes and message must appear
      expect(script).toContain('bbb222');
      expect(script).toContain('aaa111');
      expect(script).toContain('merged');
      // checkout topHash before reset to bottomHash^
      expect(script.indexOf('checkout "bbb222"')).toBeLessThan(script.indexOf('reset --soft'));
      // commit comes after reset
      expect(script.indexOf('reset --soft')).toBeLessThan(script.indexOf('git commit'));
    });

    it('script contains a rebase --onto step to replay commits above the fold range', () => {
      const result = translate(['fold', '--exact', 'aaa111::bbb222', '--message', 'merged']);
      const script = result.args[1] as string;
      expect(script).toContain('rebase --onto');
      // topHash used as the upstream exclusion boundary in rebase --onto
      expect(script).toContain('"bbb222"');
      // Conditional: only rebase if ORIG_TIP differs from topHash
      expect(script).toContain('ORIG_TIP');
      expect(script).toContain('TOP_SHA');
    });

    it('escapes single quotes in the commit message', () => {
      const result = translate(['fold', '--exact', 'aaa111::bbb222', '--message', "it's done"]);
      expect(result.args[1]).toContain("it'\\''s done");
    });
  });

  describe('pull (plain, PullOperation)', () => {
    it('translates plain pull to fetch --all (not git pull which would merge)', () => {
      expect(translate(['pull'])).toEqual({
        args: ['fetch', '--all'],
        stdin: undefined,
      });
    });

    it('does not affect pull --rev (PullRevOperation still works)', () => {
      expect(translate(['pull', '--rev', 'abc123'])).toEqual({
        args: ['fetch', 'origin', 'abc123'],
      });
    });
  });
});

describe('GitDriver.getExecParams', () => {
  it('strips --verbose prepended by Repository.runOperation', () => {
    const {args} = driver.getExecParams(['--verbose', 'checkout', 'abc123'], '/repo');
    expect(args).toEqual(['checkout', 'abc123']);
  });

  it('strips --debug prepended by Repository.runOperation', () => {
    const {args} = driver.getExecParams(['--debug', 'commit', '--message', 'hi'], '/repo');
    expect(args).toEqual(['commit', '--message', 'hi']);
  });

  it('strips both --verbose and --debug when both are prepended', () => {
    const {args} = driver.getExecParams(['--verbose', '--debug', 'rebase', '--onto', 'main', 'abc^', 'abc'], '/repo');
    expect(args).toEqual(['rebase', '--onto', 'main', 'abc^', 'abc']);
  });

  it('preserves normal git args unchanged', () => {
    const {args} = driver.getExecParams(['commit', '--verbose', '--message', 'hi'], '/repo');
    expect(args).toEqual(['commit', '--verbose', '--message', 'hi']);
  });

  it('handles __shell__ after stripping --verbose', () => {
    const {command, args} = driver.getExecParams(['--verbose', '__shell__', 'rm -f "file.txt"'], '/repo');
    expect(command).toBe('sh');
    expect(args).toEqual(['-c', 'rm -f "file.txt"']);
  });
});
