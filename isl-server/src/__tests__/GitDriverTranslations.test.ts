/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import type {RunnableOperation} from 'isl/src/types';
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
  });

  describe('metaedit', () => {
    it('translates to git commit --amend', () => {
      expect(translate(['metaedit', '--rev', 'abc123', '--message', 'new msg'])).toEqual({
        args: ['commit', '--amend', '--message', 'new msg'],
      });
    });

    it('renames --user to --author', () => {
      expect(translate(['metaedit', '--rev', 'abc123', '--user', 'Bob <b@c.com>', '--message', 'msg'])).toEqual({
        args: ['commit', '--amend', '--author', 'Bob <b@c.com>', '--message', 'msg'],
      });
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

    it('translates rebase --keep --rev SRC --dest DEST to cherry-pick', () => {
      expect(translate(['rebase', '--keep', '--rev', 'abc123', '--dest', 'def456'])).toEqual({
        args: ['cherry-pick', 'abc123'],
      });
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
});
