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
    it('converts --addremove to --all', () => {
      expect(translate(['commit', '--addremove', '--message', 'hello'])).toEqual({
        args: ['commit', '--all', '--message', 'hello'],
        stdin: undefined,
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
      expect(script).toContain('rebase --update-refs --onto');
      // checkout must come before amend
      expect(script.indexOf('checkout "abc123"')).toBeLessThan(script.indexOf('commit --amend'));
    });

    it('includes --author when --user is provided', () => {
      const result = translate(['metaedit', '--rev', 'abc123', '--user', 'Bob <b@c.com>', '--message', 'msg']);
      expect(result.args[0]).toBe('__shell__');
      expect(result.args[1]).toContain("--author 'Bob <b@c.com>'");
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

  describe('goto (GotoOperation)', () => {
    it('generates a stash/checkout/pop script to carry uncommitted changes', () => {
      const result = translate(['goto', '--rev', 'abc123']);
      expect(result.args[0]).toBe('__shell__');
      const script = result.args[1] as string;
      // Must have set -e for fail-fast behavior
      expect(script).toContain('set -e');
      // Must have conditional logic: stash if dirty, skip if clean
      expect(script).toContain('HAS_CHANGES');
      expect(script).toContain('git stash push');
      expect(script).toContain('git stash pop');
      // checkout and stash operations must reference the target hash
      expect(script).toContain('"abc123"');
      // stash push must come before checkout which must come before stash pop
      expect(script.indexOf('git stash push')).toBeLessThan(script.indexOf('checkout'));
      expect(script.indexOf('checkout')).toBeLessThan(script.indexOf('git stash pop'));
    });

    // --clean case is unchanged
    it('translates goto --clean . to checkout -- . (unchanged)', () => {
      expect(translate(['goto', '--clean', '.'])).toEqual({
        args: ['checkout', '--', '.'],
        stdin: undefined,
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
    it('translates rebase -s SRC -d DEST to shell script that finds stack tip', () => {
      const result = translate(['rebase', '-s', 'abc123', '-d', 'def456']);
      expect(result.args[0]).toBe('__shell__');
      // Script should find descendants of SRC and rebase the whole stack onto DEST
      expect(result.args[1]).toContain('SRC="abc123"');
      expect(result.args[1]).toContain('DEST="def456"');
      expect(result.args[1]).toContain('git for-each-ref --contains "$SRC"');
      expect(result.args[1]).toContain('git rebase --update-refs --onto "$DEST" "$SRC"^ "$TIP"');
    });

    it('rejects non-SHA values in standard rebase -s/-d', () => {
      expect(() => translate(['rebase', '-s', '$(rm -rf /)', '-d', 'def456'])).toThrow();
      expect(() => translate(['rebase', '-s', 'abc123', '-d', '$(rm -rf /)'])).toThrow();
    });

    it('accepts valid ref-like values in standard rebase', () => {
      expect(() => translate(['rebase', '-s', 'abc123', '-d', 'HEAD~3'])).not.toThrow();
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
      expect(result.args[1]).toContain('rebase --update-refs --onto "abc123"');
      expect(result.args[1]).toContain('$BASE HEAD');
    });

    it('also handles draft()&date(-7) source', () => {
      const result = translate(['rebase', '-s', 'draft()&date(-7)', '-d', 'abc123']);
      expect(result.args[0]).toBe('__shell__');
      expect(result.args[1]).toContain('merge-base');
      expect(result.args[1]).toContain('rebase --update-refs --onto "abc123"');
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

    it('translates shelve --delete to stash drop with the stash ref', () => {
      expect(translate(['shelve', '--delete', 'stash@{2}'])).toEqual({
        args: ['stash', 'drop', 'stash@{2}'],
      });
    });

    it('translates shelve --delete without name to plain stash drop', () => {
      expect(translate(['shelve', '--delete'])).toEqual({
        args: ['stash', 'drop'],
      });
    });
  });

  describe('unshelve', () => {
    it('translates unshelve --keep to stash apply with stash ref', () => {
      expect(translate(['unshelve', '--keep', '--name', 'stash@{1}'])).toEqual({
        args: ['stash', 'apply', 'stash@{1}'],
      });
    });

    it('translates unshelve (no --keep) to stash pop with stash ref', () => {
      expect(translate(['unshelve', '--name', 'stash@{0}'])).toEqual({
        args: ['stash', 'pop', 'stash@{0}'],
      });
    });

    it('translates unshelve without --name to plain stash pop', () => {
      expect(translate(['unshelve'])).toEqual({
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
    it('translates resolve --mark file to shell that handles add or rm', () => {
      const result = translate(['resolve', '--mark', 'conflict.txt']);
      expect(result.args[0]).toBe('__shell__');
      expect(result.args[1]).toContain('git add -- "$f"');
      expect(result.args[1]).toContain('git rm -f -- "$f"');
      expect(result.args[1]).toContain('conflict.txt');
    });

    it('translates resolve --unmark file to rm --cached file', () => {
      expect(translate(['resolve', '--unmark', 'conflict.txt'])).toEqual({
        args: ['rm', '--cached', 'conflict.txt'],
      });
    });
  });

  describe('resolve --tool (ResolveOperation tool variants)', () => {
    it('resolve --tool internal:merge-local keeps our version', () => {
      const result = translate(['resolve', '--tool', 'internal:merge-local', 'src/foo.ts']);
      expect(result.args[0]).toBe('__shell__');
      expect(result.args[1]).toContain('checkout --ours');
      expect(result.args[1]).toContain('src/foo.ts');
      expect(result.args[1]).toContain('git add');
    });

    it('resolve --tool internal:merge-other keeps their version', () => {
      const result = translate(['resolve', '--tool', 'internal:merge-other', 'src/foo.ts']);
      expect(result.args[0]).toBe('__shell__');
      expect(result.args[1]).toContain('checkout --theirs');
      expect(result.args[1]).toContain('src/foo.ts');
      expect(result.args[1]).toContain('git add');
    });

    it('resolve --tool internal:union merges with union strategy', () => {
      const result = translate(['resolve', '--tool', 'internal:union', 'src/foo.ts']);
      expect(result.args[0]).toBe('__shell__');
      const script = result.args[1] as string;
      expect(script).toContain('merge-file --union');
      expect(script).toContain('src/foo.ts');
      expect(script).toContain('git add');
      // verify correct git object stages are used
      expect(script).toContain(':1:');  // base
      expect(script).toContain(':2:');  // ours
      expect(script).toContain(':3:');  // theirs
      expect(script).toContain('cp ');  // copy result back to working tree
    });

    it('resolve --tool internal:union checks all three stages for LFS pointers', () => {
      const result = translate(['resolve', '--tool', 'internal:union', 'src/large.bin']);
      const script = result.args[1] as string;
      // Must check base (:1:) and theirs (:3:) stages for LFS, not just ours (:2:)
      expect(script).toContain(':1:"$FILE"');
      expect(script).toContain(':3:"$FILE"');
      // All three checks must happen before merge-file
      const lfsCheckBase = script.indexOf(':1:"$FILE"');
      const lfsCheckTheirs = script.indexOf(':3:"$FILE"');
      const mergeFile = script.indexOf('merge-file');
      expect(lfsCheckBase).toBeLessThan(mergeFile);
      expect(lfsCheckTheirs).toBeLessThan(mergeFile);
    });

    it('resolve --tool internal:union checks for binary content before merge', () => {
      const result = translate(['resolve', '--tool', 'internal:union', 'image.png']);
      const script = result.args[1] as string;
      // Must detect binary content and skip merge-file
      expect(script).toContain('\\x00');
      const binaryCheck = script.indexOf('\\x00');
      const mergeFile = script.indexOf('merge-file');
      expect(binaryCheck).toBeLessThan(mergeFile);
    });

    it('resolve --tool internal:merge-local without file throws', () => {
      expect(() => translate(['resolve', '--tool', 'internal:merge-local'])).toThrow();
    });

    it('resolve --tool <external> opens mergetool', () => {
      const result = translate(['resolve', '--tool', 'vimdiff', 'src/foo.ts']);
      expect(result.args[0]).toBe('__shell__');
      expect(result.args[1]).toContain('mergetool');
      expect(result.args[1]).toContain("--tool='vimdiff'");
      expect(result.args[1]).toContain('src/foo.ts');
    });

    it('resolve --tool <external> with --all runs mergetool on all files', () => {
      const result = translate(['resolve', '--tool', 'vimdiff', '--all']);
      expect(result.args[0]).toBe('__shell__');
      expect(result.args[1]).toContain('mergetool');
      expect(result.args[1]).toContain("--tool='vimdiff'");
      // no specific file
    });

    it('resolve --all runs mergetool on all unresolved files', () => {
      const result = translate(['resolve', '--all']);
      expect(result.args[0]).toBe('__shell__');
      expect(result.args[1]).toContain('mergetool');
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

    it('rejects non-SHA values that could be shell-injected in hide', () => {
      expect(() => translate(['hide', '--rev', '$(rm -rf /)'])).toThrow();
      expect(() => translate(['hide', '--rev', 'abc; rm -rf /'])).toThrow();
      expect(() => translate(['hide', '--rev', '`whoami`'])).toThrow();
    });

    it('accepts valid 40-char hex SHA in hide', () => {
      const validSha = 'a'.repeat(40);
      expect(() => translate(['hide', '--rev', validSha])).not.toThrow();
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
      expect(script).toContain('rebase --update-refs --onto');
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

  describe('amend --to (AmendToOperation)', () => {
    it('generates a stash/checkout/amend/rebase chain', () => {
      const result = translate(['amend', '--to', 'abc123', 'file.txt']);
      expect(result.args[0]).toBe('__shell__');
      const script = result.args[1] as string;
      expect(script).toContain('set -e');
      expect(script).toContain('git stash push');
      expect(script).toContain('"abc123"');
      expect(script).toContain('git stash pop');
      expect(script).toContain('commit --amend');
      expect(script).toContain('rebase --update-refs --onto');
      // ordering: stash before checkout, checkout before stash pop, stash pop before amend
      expect(script.indexOf('git stash push')).toBeLessThan(script.indexOf('checkout'));
      expect(script.indexOf('checkout')).toBeLessThan(script.indexOf('git stash pop'));
      expect(script.indexOf('git stash pop')).toBeLessThan(script.indexOf('commit --amend'));
    });

    it('works with no specific files (amend all stashed changes)', () => {
      const result = translate(['amend', '--to', 'abc123']);
      expect(result.args[0]).toBe('__shell__');
      const script = result.args[1] as string;
      expect(script).toContain('"abc123"');
      expect(script).toContain('commit --amend');
    });

    it('amend --to HEAD commit uses git branch -f to update branch pointer', () => {
      const result = translate(['amend', '--to', 'abc123']);
      expect(result.args[0]).toBe('__shell__');
      const script = result.args[1] as string;
      // HEAD case: else branch must force-update the branch pointer
      expect(script).toContain('git branch -f "$ORIG_BRANCH" $NEW_TARGET');
      expect(script).toContain('git checkout --detach $NEW_TARGET');
    });
  });

  describe('pull (plain, PullOperation)', () => {
    it('translates plain pull to fetch origin (not git pull which would merge)', () => {
      expect(translate(['pull'])).toEqual({
        args: ['fetch', 'origin'],
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
    expect(args).toEqual(['--no-optional-locks', 'checkout', 'abc123']);
  });

  it('strips --debug prepended by Repository.runOperation', () => {
    const {args} = driver.getExecParams(['--debug', 'commit', '--message', 'hi'], '/repo');
    expect(args).toEqual(['--no-optional-locks', 'commit', '--message', 'hi']);
  });

  it('strips both --verbose and --debug when both are prepended', () => {
    const {args} = driver.getExecParams(['--verbose', '--debug', 'rebase', '--onto', 'main', 'abc^', 'abc'], '/repo');
    expect(args).toEqual(['--no-optional-locks', 'rebase', '--onto', 'main', 'abc^', 'abc']);
  });

  it('preserves normal git args unchanged', () => {
    const {args} = driver.getExecParams(['commit', '--verbose', '--message', 'hi'], '/repo');
    expect(args).toEqual(['--no-optional-locks', 'commit', '--verbose', '--message', 'hi']);
  });

  it('handles __shell__ after stripping --verbose', () => {
    const {command, args} = driver.getExecParams(['--verbose', '__shell__', 'rm -f "file.txt"'], '/repo');
    expect(command).toBe('sh');
    expect(args).toEqual(['-c', 'rm -f "file.txt"']);
  });

  it('does not set GIT_LFS_SKIP_SMUDGE by default (operations need LFS smudge)', () => {
    const {options} = driver.getExecParams(['checkout', 'abc123'], '/repo');
    expect(options.env?.GIT_LFS_SKIP_SMUDGE).toBeUndefined();
  });

  it('sets GIT_LFS_SKIP_SMUDGE when passed via env parameter (read-only commands)', () => {
    const {options} = driver.getExecParams(['status'], '/repo', undefined, {GIT_LFS_SKIP_SMUDGE: '1'});
    expect(options.env?.GIT_LFS_SKIP_SMUDGE).toBe('1');
  });
});
