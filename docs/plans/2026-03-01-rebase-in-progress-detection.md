# Rebase-in-Progress Detection Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Fix ISL's Git driver so it correctly detects an in-progress rebase, prevents other operations from running, and auto-continues the rebase when there are no conflicting files.

**Architecture:** Add `hasPotentialOperation(dotdir)` to the VCSDriver interface so each driver owns its own fast-path logic. Fix `Repository.checkForMergeConflicts()` to use this method. Add auto-continue logic in the same function for rebase states with zero conflict files.

**Tech Stack:** TypeScript, Node.js, Jest (v29), `shared/fs` `exists` helper, `git` CLI

---

### Task 1: Add `hasPotentialOperation` to VCSDriver interface

**Files:**
- Modify: `isl-server/src/vcs/VCSDriver.ts:119`

**Step 1: Add the method signature after `checkMergeConflicts`**

In `VCSDriver.ts`, insert after line 119 (after the closing `): Promise<MergeConflicts | undefined>;`):

```typescript
  /**
   * Fast check: are there signs a merge/rebase/cherry-pick might be in progress?
   * Used as a cheap gate before calling the more expensive checkMergeConflicts.
   */
  hasPotentialOperation(dotdir: string): Promise<boolean>;
```

**Step 2: Verify TypeScript compilation fails for unimplemented drivers**

```bash
cd isl-server && yarn tsc --noEmit 2>&1 | grep "hasPotentialOperation"
```
Expected: errors in `SaplingDriver.ts` and `GitDriver.ts` saying the method is missing.

---

### Task 2: Implement `hasPotentialOperation` in SaplingDriver

**Files:**
- Modify: `isl-server/src/vcs/SaplingDriver.ts` (after line 287, end of `checkMergeConflicts`)

**Step 1: Add the implementation**

Insert after the closing `}` of `checkMergeConflicts` (around line 287):

```typescript
  async hasPotentialOperation(dotdir: string): Promise<boolean> {
    return exists(path.join(dotdir, 'merge'));
  }
```

This is identical to the current hard-coded check in Repository.ts, so behavior is unchanged for Sapling.

**Step 2: Verify SaplingDriver compiles**

```bash
cd isl-server && yarn tsc --noEmit 2>&1 | grep "SaplingDriver"
```
Expected: no errors for SaplingDriver.

---

### Task 3: Implement `hasPotentialOperation` in GitDriver — TDD

**Files:**
- Modify: `isl-server/src/vcs/GitDriver.ts` (after line 520, end of `checkMergeConflicts`)
- Test: `isl-server/src/__tests__/VCSDriverIntegration.test.ts`

**Step 1: Write the failing tests**

In `VCSDriverIntegration.test.ts`, inside the `describe('Git', ...)` block, add a new `describe('hasPotentialOperation', ...)` block after the existing `'Merge Conflicts'` describe (around line 603):

```typescript
describe('hasPotentialOperation', () => {
  const dotDir = path.join(tmpDir, '.git');

  it('returns false when no operation is in progress', async () => {
    await helpers.commit(tmpDir, 'initial', 'file.txt', 'content');
    expect(await driver.hasPotentialOperation(dotDir)).toBe(false);
  });

  it('returns true when rebase-merge directory exists', async () => {
    await fs.mkdir(path.join(dotDir, 'rebase-merge'), {recursive: true});
    expect(await driver.hasPotentialOperation(dotDir)).toBe(true);
    await fs.rm(path.join(dotDir, 'rebase-merge'), {recursive: true});
  });

  it('returns true when rebase-apply directory exists', async () => {
    await fs.mkdir(path.join(dotDir, 'rebase-apply'), {recursive: true});
    expect(await driver.hasPotentialOperation(dotDir)).toBe(true);
    await fs.rm(path.join(dotDir, 'rebase-apply'), {recursive: true});
  });

  it('returns true when MERGE_HEAD file exists', async () => {
    await fs.writeFile(path.join(dotDir, 'MERGE_HEAD'), 'abc123\n');
    expect(await driver.hasPotentialOperation(dotDir)).toBe(true);
    await fs.rm(path.join(dotDir, 'MERGE_HEAD'));
  });

  it('returns true when CHERRY_PICK_HEAD file exists', async () => {
    await fs.writeFile(path.join(dotDir, 'CHERRY_PICK_HEAD'), 'abc123\n');
    expect(await driver.hasPotentialOperation(dotDir)).toBe(true);
    await fs.rm(path.join(dotDir, 'CHERRY_PICK_HEAD'));
  });

  it('returns true during a real rebase conflict', async () => {
    await helpers.commit(tmpDir, 'base', 'file.txt', 'base content');
    const hashBase = await helpers.getHead(tmpDir);
    await helpers.commit(tmpDir, 'change-A', 'file.txt', 'content from A');
    const hashA = await helpers.getHead(tmpDir);
    await helpers.checkout(tmpDir, hashBase);
    await helpers.createAndCheckoutBranch(tmpDir, 'hasPotential-branch');
    await helpers.commit(tmpDir, 'change-B', 'file.txt', 'content from B');
    try { await helpers.rebase(tmpDir, hashA); } catch { /* expected */ }

    expect(await driver.hasPotentialOperation(dotDir)).toBe(true);

    await helpers.rebaseAbort(tmpDir);
  });
});
```

**Step 2: Run to verify the tests fail**

```bash
cd isl-server && yarn test --testPathPattern="VCSDriverIntegration" --no-coverage 2>&1 | grep -E "hasPotentialOperation|PASS|FAIL"
```
Expected: `FAIL` with "driver.hasPotentialOperation is not a function"

**Step 3: Implement in GitDriver**

In `GitDriver.ts`, insert after the closing `}` of `checkMergeConflicts` (after line 520):

```typescript
  async hasPotentialOperation(dotdir: string): Promise<boolean> {
    return (
      (await exists(path.join(dotdir, 'rebase-merge'))) ||
      (await exists(path.join(dotdir, 'rebase-apply'))) ||
      (await exists(path.join(dotdir, 'MERGE_HEAD'))) ||
      (await exists(path.join(dotdir, 'CHERRY_PICK_HEAD')))
    );
  }
```

**Step 4: Run tests to verify they pass**

```bash
cd isl-server && yarn test --testPathPattern="VCSDriverIntegration" --no-coverage 2>&1 | grep -E "hasPotentialOperation|PASS|FAIL"
```
Expected: `PASS`, all `hasPotentialOperation` tests green.

**Step 5: Verify TypeScript compiles cleanly**

```bash
cd isl-server && yarn tsc --noEmit 2>&1 | head -20
```
Expected: no errors.

**Step 6: Commit**

```bash
cd isl-server && git add src/vcs/VCSDriver.ts src/vcs/SaplingDriver.ts src/vcs/GitDriver.ts src/__tests__/VCSDriverIntegration.test.ts
git commit -m "feat: add hasPotentialOperation to VCSDriver interface, implement in Sapling and Git drivers"
```

---

### Task 4: Fix the fast path in Repository.ts

**Files:**
- Modify: `isl-server/src/Repository.ts:410`

**Step 1: Run existing Repository conflict tests to establish baseline**

```bash
cd isl-server && yarn test --testPathPattern="Repository" --no-coverage 2>&1 | grep -E "conflict|PASS|FAIL"
```
Expected: all conflict tests pass.

**Step 2: Replace the hard-coded fast path**

In `Repository.ts`, replace lines 410–416:

```typescript
// Before:
      const mergeDirExists = await exists(path.join(this.info.dotdir, 'merge'));
      if (!mergeDirExists) {
        this.initialConnectionContext.logger.info(
          `conflict state still the same (${
            wasAlreadyInConflicts ? 'IN merge conflict' : 'NOT in conflict'
          })`,
        );
        return;
      }
```

With:

```typescript
// After:
      const mergeDirExists = await this.driver.hasPotentialOperation(this.info.dotdir);
      if (!mergeDirExists) {
        this.initialConnectionContext.logger.info(
          `conflict state still the same (${
            wasAlreadyInConflicts ? 'IN merge conflict' : 'NOT in conflict'
          })`,
        );
        return;
      }
```

Only the first line changes. The rest of the block is identical.

**Step 3: Run Repository tests to verify no regression**

```bash
cd isl-server && yarn test --testPathPattern="Repository" --no-coverage 2>&1 | grep -E "conflict|PASS|FAIL"
```
Expected: all passing. The existing tests work because `SaplingDriver.hasPotentialOperation` calls the same `exists` function that's already mocked by `jest.spyOn(fsUtils, 'exists')`.

**Step 4: Also run the integration tests**

```bash
cd isl-server && yarn test --testPathPattern="VCSDriverIntegration" --no-coverage 2>&1 | tail -10
```
Expected: all passing.

**Step 5: Commit**

```bash
git add isl-server/src/Repository.ts
git commit -m "fix: use driver.hasPotentialOperation() in fast path instead of Sapling-specific exists check"
```

---

### Task 5: Add auto-continue logic — TDD

**Files:**
- Modify: `isl-server/src/Repository.ts:437` (after the try/catch for checkMergeConflicts)
- Test: `isl-server/src/__tests__/Repository.test.ts`

**Step 1: Write the failing tests**

In `Repository.test.ts`, add a new `describe('auto-continue rebase', ...)` block after the existing conflict tests (around line 838). You'll need to import `GitDriver` at the top of the file (add to existing imports):

```typescript
import {GitDriver} from '../vcs/GitDriver';
```

Then add the test block:

```typescript
describe('auto-continue rebase with no conflicts', () => {
  function makeRepoWithDriver(driver: VCSDriver) {
    return new Repository(repoInfo, ctx, driver);
  }

  function makeMockDriver() {
    const driver = new GitDriver();
    jest.spyOn(driver, 'hasPotentialOperation').mockResolvedValue(true);
    jest.spyOn(driver, 'runCommand').mockResolvedValue({stdout: '', stderr: '', exitCode: 0} as any);
    return driver;
  }

  it('auto-continues and clears state when rebase has no conflict files', async () => {
    const driver = makeMockDriver();
    jest.spyOn(driver, 'checkMergeConflicts').mockResolvedValue({
      state: 'loaded',
      command: 'rebase',
      toContinue: 'git rebase --continue',
      toAbort: 'git rebase --abort',
      files: [],
      fetchStartTimestamp: Date.now(),
      fetchCompletedTimestamp: Date.now(),
    });

    const repo = makeRepoWithDriver(driver);
    const onChange = jest.fn();
    repo.onChangeConflictState(onChange);

    await repo.checkForMergeConflicts();

    // runCommand should have been called with rebase --continue
    expect(driver.runCommand).toHaveBeenCalledWith(
      expect.anything(),
      ['rebase', '--continue'],
    );
    // State should be cleared — no conflict emitted to UI
    expect(onChange).not.toHaveBeenCalledWith(expect.objectContaining({state: 'loaded'}));
    expect(repo.getMergeConflicts()).toBeUndefined();
  });

  it('does NOT auto-continue when rebase has conflict files', async () => {
    const driver = makeMockDriver();
    jest.spyOn(driver, 'checkMergeConflicts').mockResolvedValue({
      state: 'loaded',
      command: 'rebase',
      toContinue: 'git rebase --continue',
      toAbort: 'git rebase --abort',
      files: [{path: 'conflict.txt', status: 'U' as const, conflictType: 'both_changed' as const}],
      fetchStartTimestamp: Date.now(),
      fetchCompletedTimestamp: Date.now(),
    });

    const repo = makeRepoWithDriver(driver);
    const onChange = jest.fn();
    repo.onChangeConflictState(onChange);

    await repo.checkForMergeConflicts();

    expect(driver.runCommand).not.toHaveBeenCalledWith(
      expect.anything(),
      ['rebase', '--continue'],
    );
    expect(repo.getMergeConflicts()).toBeDefined();
  });

  it('does NOT auto-continue for merge (only rebase)', async () => {
    const driver = makeMockDriver();
    jest.spyOn(driver, 'checkMergeConflicts').mockResolvedValue({
      state: 'loaded',
      command: 'merge',
      toContinue: 'git merge --continue',
      toAbort: 'git merge --abort',
      files: [],
      fetchStartTimestamp: Date.now(),
      fetchCompletedTimestamp: Date.now(),
    });

    const repo = makeRepoWithDriver(driver);
    await repo.checkForMergeConflicts();

    expect(driver.runCommand).not.toHaveBeenCalledWith(
      expect.anything(),
      ['rebase', '--continue'],
    );
    expect(repo.getMergeConflicts()).toBeDefined();
  });

  it('surfaces conflict state when auto-continue fails', async () => {
    const driver = makeMockDriver();
    jest.spyOn(driver, 'checkMergeConflicts').mockResolvedValue({
      state: 'loaded',
      command: 'rebase',
      toContinue: 'git rebase --continue',
      toAbort: 'git rebase --abort',
      files: [],
      fetchStartTimestamp: Date.now(),
      fetchCompletedTimestamp: Date.now(),
    });
    jest.spyOn(driver, 'runCommand').mockRejectedValue(new Error('nothing to commit'));

    const repo = makeRepoWithDriver(driver);
    const onChange = jest.fn();
    repo.onChangeConflictState(onChange);

    await repo.checkForMergeConflicts();

    // State should be emitted so user sees the Abort UI
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({state: 'loaded'}));
    expect(repo.getMergeConflicts()).toBeDefined();
  });

  it('does NOT auto-continue again on second detection (wasAlreadyInConflicts)', async () => {
    const driver = makeMockDriver();
    const noFileState = {
      state: 'loaded' as const,
      command: 'rebase',
      toContinue: 'git rebase --continue',
      toAbort: 'git rebase --abort',
      files: [],
      fetchStartTimestamp: Date.now(),
      fetchCompletedTimestamp: Date.now(),
    };
    // --continue fails both times so conflict state persists
    jest.spyOn(driver, 'checkMergeConflicts').mockResolvedValue(noFileState);
    jest.spyOn(driver, 'runCommand').mockRejectedValue(new Error('nothing to commit'));

    const repo = makeRepoWithDriver(driver);
    await repo.checkForMergeConflicts(); // first detection: tries --continue, fails
    const runCommandCallCount = (driver.runCommand as jest.Mock).mock.calls.length;

    await repo.checkForMergeConflicts(); // second call: wasAlreadyInConflicts=true, no retry
    expect((driver.runCommand as jest.Mock).mock.calls.length).toBe(runCommandCallCount);
  });
});
```

**Step 2: Run to verify the tests fail**

```bash
cd isl-server && yarn test --testPathPattern="Repository" --no-coverage 2>&1 | grep -E "auto-continue|PASS|FAIL"
```
Expected: `FAIL` — auto-continue tests fail because the logic doesn't exist yet.

**Step 3: Implement the auto-continue logic**

In `Repository.ts`, insert between lines 437 and 438 (after the try/catch closes, before the logging block):

```typescript
    // Auto-continue a rebase with no unresolved conflicts.
    // Only on first detection (!wasAlreadyInConflicts) to avoid retrying every poll.
    // Only for 'rebase' — merges and cherry-picks are intentional user actions.
    if (
      !wasAlreadyInConflicts &&
      this.mergeConflicts?.state === 'loaded' &&
      this.mergeConflicts.command === 'rebase' &&
      this.mergeConflicts.files.length === 0
    ) {
      try {
        await this.driver.runCommand(this.initialConnectionContext, ['rebase', '--continue']);
        this.initialConnectionContext.logger.info('auto-continued rebase with no conflicts');
        this.mergeConflicts = undefined;
      } catch (err) {
        this.initialConnectionContext.logger.error(`auto-continue rebase failed: ${err}`);
        // fall through: emit the conflict state so the user sees the Abort UI
      }
    }
```

**Step 4: Run tests to verify they pass**

```bash
cd isl-server && yarn test --testPathPattern="Repository" --no-coverage 2>&1 | grep -E "auto-continue|PASS|FAIL"
```
Expected: `PASS`, all auto-continue tests green.

**Step 5: Run the full test suite to check for regressions**

```bash
cd isl-server && yarn test --no-coverage 2>&1 | tail -20
```
Expected: all tests pass.

**Step 6: Commit**

```bash
git add isl-server/src/Repository.ts isl-server/src/__tests__/Repository.test.ts
git commit -m "feat: auto-continue git rebase when no conflicts detected on first check"
```

---

### Task 6: Manual testing

**Setup:** Start the ISL server against the champagne-test-repo:

```bash
cd isl-server && yarn build && yarn serve --dev --force --foreground --stdout --cwd /Users/jesselupica/Projects/champagne-test-repo
```

Open the URL from the server output in the browser.

**Test 1 — Normal operation, no regression:**
1. Confirm the repo has uncommitted changes or commits visible
2. Confirm no merge conflict UI appears
3. Make a small edit to `README.md`, commit it with a title — verify the commit appears in the graph

**Test 2 — Rebase conflict surfaces correctly:**
1. Set up two commits that conflict on the same file (use the `amend --to` operation on a commit that conflicts with a child)
2. Verify the merge conflict UI appears with the conflicting file listed and Continue/Abort buttons visible
3. Click Abort — verify the repo returns to normal

**Test 3 — Stale rebase-merge with no conflicts auto-continues:**
1. Start a rebase conflict (same setup as Test 2)
2. Manually resolve the conflict: `git checkout --theirs <file> && git add <file>`
3. Do NOT run `git rebase --continue`
4. Reload ISL — verify the UI does NOT show a conflict state (auto-continue ran silently)
5. Run `git log --oneline -5` — verify the rebase completed and the expected commits are present

**Test 4 — Stale rebase-merge where `--continue` fails shows Abort UI:**
1. Manually create the stale state: `mkdir -p /path/to/champagne-test-repo/.git/rebase-merge`
2. Write a fake HEAD file: `echo "fake" > .git/rebase-merge/head`
3. Reload ISL — verify the Abort button appears (auto-continue failed)
4. Clean up: `rm -rf .git/rebase-merge`

**Declare victory only after all four tests pass.**
