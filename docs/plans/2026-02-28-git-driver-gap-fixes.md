# Git Driver Gap Fixes Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Fix all 16 gaps identified in `docs/git-driver-gaps.md` so the Git driver correctly implements the full behavioral contract in `docs/vcs-semantic-spec.md`.

**Architecture:** All fixes touch two layers — the server-side `normalizeOperationArgs` switch in `GitDriver.ts` (which translates Sapling-style args to Git commands), and the frontend `translateArgsForDisplay` in `CommandHistoryAndProgress.tsx` (which shows the translated command to the user). Complex multi-step operations are emitted as `__shell__` commands (args `['__shell__', 'shell script here']`), which the server runs via `sh -c`. Tests go in the existing `GitDriverTranslations.test.ts` file.

**Tech Stack:** TypeScript, Jest (`cd isl-server && yarn test`), shell scripts embedded as strings

---

## Background: How to Read This Plan

### Server translation layer

**File:** `isl-server/src/vcs/GitDriver.ts`

The function `normalizeOperationArgs(cwd, repoRoot, operation)` is a big switch on `args[0]`. It receives Sapling-style args (e.g. `['rebase', '-s', 'abc', '-d', 'def']`) and returns a `ResolvedCommand`:

```typescript
interface ResolvedCommand {
  args: string[];       // passed to `git` (or `sh -c` if args[0] === '__shell__')
  stdin?: string;
  env?: Record<string, string>;
}
```

When `args[0] === '__shell__'`, the server runs `sh -c args[1]` in the repo directory instead of `git args[1...]`.

### Frontend display layer

**File:** `isl/src/CommandHistoryAndProgress.tsx`

The function `translateArgsForDisplay(args, command)` is a parallel switch used only for rendering. It must be kept in sync with the server layer.

### Test helper

**File:** `isl-server/src/__tests__/GitDriverTranslations.test.ts`

```typescript
function translate(args: string[], stdin?: string) {
  return driver.normalizeOperationArgs(cwd, repoRoot, {args, stdin});
}
```

Run tests with:
```bash
cd /Users/jesselupica/Projects/champagne/isl-server
yarn test --testPathPattern=GitDriverTranslations
```

---

## Task 1: Fix `AbortMergeOperation` crash

`sl rebase --abort` and `sl rebase --quit` both hit the `rebase` case and throw because there is no `-s` or `-d`. Must handle `--abort` and `--quit` at the top of the rebase case before any `-s`/`-d` parsing.

**Files:**
- Modify: `isl-server/src/vcs/GitDriver.ts` (inside `normalizeOperationArgs`, the `rebase` case)
- Modify: `isl/src/CommandHistoryAndProgress.tsx` (inside `translateArgsForDisplay`, the `rebase` case)
- Test: `isl-server/src/__tests__/GitDriverTranslations.test.ts`

**Step 1: Write the failing tests**

Add inside the `describe('rebase', ...)` block (or create a new `describe('rebase --abort', ...)` block):

```typescript
describe('rebase --abort', () => {
  it('generates a shell script that detects the in-progress operation and aborts it', () => {
    const result = translate(['rebase', '--abort']);
    expect(result.args[0]).toBe('__shell__');
    expect(result.args[1]).toContain('REBASE_MERGE');
    expect(result.args[1]).toContain('rebase --abort');
    expect(result.args[1]).toContain('MERGE_HEAD');
    expect(result.args[1]).toContain('merge --abort');
    expect(result.args[1]).toContain('CHERRY_PICK_HEAD');
    expect(result.args[1]).toContain('cherry-pick --abort');
  });

  it('generates a shell script for --quit that saves already-rebased commits', () => {
    const result = translate(['rebase', '--quit']);
    expect(result.args[0]).toBe('__shell__');
    expect(result.args[1]).toContain('rebase --abort');
  });
});
```

**Step 2: Run to verify they fail**

```bash
cd /Users/jesselupica/Projects/champagne/isl-server
yarn test --testPathPattern=GitDriverTranslations 2>&1 | tail -20
```
Expected: FAIL — `rebase --abort` throws `"rebase requires -s and -d"`

**Step 3: Add the server-side translation**

In `GitDriver.ts`, inside the `rebase` case, add these two checks **at the very top, before any other parsing**:

```typescript
if (args[0] === 'rebase') {
  // --abort: detect which operation is in progress and abort it
  if (args.includes('--abort')) {
    const script =
      'if [ -d .git/REBASE_MERGE ] || [ -d .git/REBASE_APPLY ]; then git rebase --abort; ' +
      'elif [ -f .git/MERGE_HEAD ]; then git merge --abort; ' +
      'elif [ -f .git/CHERRY_PICK_HEAD ]; then git cherry-pick --abort; ' +
      'else echo "No operation in progress" && exit 1; fi';
    return {args: ['__shell__', script], stdin};
  }

  // --quit: save already-rebased commits, then abort (approximates sl rebase --quit)
  if (args.includes('--quit')) {
    const script =
      'REWRITTEN=$(cat .git/REBASE_MERGE/rewritten-list 2>/dev/null | awk \'{print $2}\' | tr \'\\n\' \' \') && ' +
      'git rebase --abort && ' +
      'if [ -n "$REWRITTEN" ]; then git cherry-pick $REWRITTEN; fi';
    return {args: ['__shell__', script], stdin};
  }

  // ... rest of existing rebase handling unchanged ...
}
```

**Step 4: Run to verify tests pass**

```bash
cd /Users/jesselupica/Projects/champagne/isl-server
yarn test --testPathPattern=GitDriverTranslations 2>&1 | tail -20
```
Expected: PASS

**Step 5: Update `translateArgsForDisplay` in `CommandHistoryAndProgress.tsx`**

In the `rebase` case, add at the top (before the existing `--keep` check):

```typescript
if (first === 'rebase') {
  if (args.includes('--abort')) return ['rebase', '--abort'];
  if (args.includes('--quit')) return ['rebase', '--abort', '(partial)'];
  // ... existing handling ...
}
```

**Step 6: Commit**

```bash
git add isl-server/src/vcs/GitDriver.ts isl/src/CommandHistoryAndProgress.tsx isl-server/src/__tests__/GitDriverTranslations.test.ts
git commit -m "fix: handle rebase --abort and --quit in git driver"
```

---

## Task 2: Fix `BulkRebaseOperation` crash

`sl rebase --rev <src1> --rev <src2> -d <dest>` throws because the rebase case only looks for `-s`, never `--rev`. Must detect the multi-`--rev` form and translate to `git checkout <dest> && git cherry-pick <rev1> <rev2> ...`.

**Files:**
- Modify: `isl-server/src/vcs/GitDriver.ts`
- Modify: `isl/src/CommandHistoryAndProgress.tsx`
- Test: `isl-server/src/__tests__/GitDriverTranslations.test.ts`

**Step 1: Write the failing tests**

```typescript
describe('rebase --rev (BulkRebaseOperation)', () => {
  it('translates multiple --rev args to checkout + cherry-pick', () => {
    const result = translate(['rebase', '--rev', 'abc123', '--rev', 'def456', '-d', 'xyz789']);
    expect(result.args[0]).toBe('__shell__');
    expect(result.args[1]).toContain('checkout xyz789');
    expect(result.args[1]).toContain('cherry-pick abc123 def456');
  });

  it('works with a single --rev', () => {
    const result = translate(['rebase', '--rev', 'abc123', '-d', 'xyz789']);
    expect(result.args[0]).toBe('__shell__');
    expect(result.args[1]).toContain('checkout xyz789');
    expect(result.args[1]).toContain('cherry-pick abc123');
  });

  it('throws if -d is missing', () => {
    expect(() => translate(['rebase', '--rev', 'abc123'])).toThrow();
  });
});
```

**Step 2: Run to verify they fail**

```bash
cd /Users/jesselupica/Projects/champagne/isl-server
yarn test --testPathPattern=GitDriverTranslations 2>&1 | tail -20
```
Expected: FAIL — throws `"rebase requires -s and -d"`

**Step 3: Add the server-side translation**

In `GitDriver.ts`, in the `rebase` case, add this block **after the `--abort`/`--quit` checks and before the `--keep` check**:

```typescript
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
  const script = `git checkout ${dest} && git cherry-pick ${revs.join(' ')}`;
  return {args: ['__shell__', script], stdin};
}
```

**Step 4: Run to verify tests pass**

```bash
cd /Users/jesselupica/Projects/champagne/isl-server
yarn test --testPathPattern=GitDriverTranslations 2>&1 | tail -20
```
Expected: PASS

**Step 5: Update `translateArgsForDisplay`**

In `CommandHistoryAndProgress.tsx`, inside the `rebase` case, add after the `--abort`/`--quit` checks:

```typescript
if (args.includes('--rev') && !args.includes('-s') && !args.includes('--source')) {
  const revs: typeof args = [];
  let dest: typeof args[0] = '??';
  for (let i = 1; i < args.length; i++) {
    if (args[i] === '--rev' && i + 1 < args.length) { revs.push(args[i + 1]); i++; continue; }
    if ((args[i] === '-d' || args[i] === '--dest') && i + 1 < args.length) { dest = args[i + 1]; i++; continue; }
  }
  return ['cherry-pick', ...revs, '(onto', dest + ')'];
}
```

**Step 6: Commit**

```bash
git add isl-server/src/vcs/GitDriver.ts isl/src/CommandHistoryAndProgress.tsx isl-server/src/__tests__/GitDriverTranslations.test.ts
git commit -m "fix: translate BulkRebaseOperation (rebase --rev) to checkout + cherry-pick"
```

---

## Task 3: Fix `RebaseAllDraftCommitsOperation` — `draft()` revset

`sl rebase -s 'draft()' -d <dest>` produces `git rebase --onto <dest> draft()^ draft()` which is invalid. Must detect when the source is the `draft()` revset and translate to a shell command using `git merge-base`.

**Files:**
- Modify: `isl-server/src/vcs/GitDriver.ts`
- Modify: `isl/src/CommandHistoryAndProgress.tsx`
- Test: `isl-server/src/__tests__/GitDriverTranslations.test.ts`

**Step 1: Write the failing tests**

```typescript
describe('rebase -s draft() (RebaseAllDraftCommitsOperation)', () => {
  it('translates draft() source to merge-base shell script', () => {
    const result = translate(['rebase', '-s', 'draft()', '-d', 'abc123']);
    expect(result.args[0]).toBe('__shell__');
    expect(result.args[1]).toContain('merge-base');
    expect(result.args[1]).toContain('rebase --onto abc123');
  });

  it('also handles draft()&date(-7) source', () => {
    const result = translate(['rebase', '-s', 'draft()&date(-7)', '-d', 'abc123']);
    expect(result.args[0]).toBe('__shell__');
    expect(result.args[1]).toContain('merge-base');
    expect(result.args[1]).toContain('rebase --onto abc123');
  });
});
```

**Step 2: Run to verify they fail**

```bash
cd /Users/jesselupica/Projects/champagne/isl-server
yarn test --testPathPattern=GitDriverTranslations 2>&1 | tail -20
```
Expected: FAIL — result would be `{args: ['rebase', '--onto', 'abc123', 'draft()^', 'draft()']}`

**Step 3: Add the server-side translation**

In `GitDriver.ts`, in the standard rebase path (after `--keep` handling, before the final `rebase --onto` construction), add a check before constructing the git command:

```typescript
// After extracting src and dest from -s/-d:
if (!src || !dest) throw new Error('rebase requires -s and -d');

// RebaseAllDraftCommitsOperation: src is a Sapling revset like draft() or draft()&date(-N)
if (src.startsWith('draft()')) {
  // "draft commits" = commits not yet on any remote tracking branch
  // Find the merge-base with origin, then rebase everything above it
  const script =
    `BASE=$(git merge-base HEAD origin/HEAD 2>/dev/null || ` +
    `git merge-base HEAD origin/main 2>/dev/null || ` +
    `git rev-list --max-parents=0 HEAD | tail -1) && ` +
    `git rebase --onto ${dest} $BASE HEAD`;
  return {args: ['__shell__', script], stdin};
}

// ... existing: return {args: ['rebase', '--onto', dest, src + '^', src], stdin};
```

**Step 4: Run to verify tests pass**

```bash
cd /Users/jesselupica/Projects/champagne/isl-server
yarn test --testPathPattern=GitDriverTranslations 2>&1 | tail -20
```
Expected: PASS

**Step 5: Update `translateArgsForDisplay`**

```typescript
// In the rebase case, before the existing src/dest extraction:
if (typeof src === 'string' && src.startsWith('draft()')) {
  return ['rebase', '--onto', dest, '$(merge-base)', 'HEAD'];
}
```

**Step 6: Commit**

```bash
git add isl-server/src/vcs/GitDriver.ts isl/src/CommandHistoryAndProgress.tsx isl-server/src/__tests__/GitDriverTranslations.test.ts
git commit -m "fix: translate RebaseAllDraftCommitsOperation draft() revset to git merge-base"
```

---

## Task 4: Fix `RebaseKeepOperation` — destination is ignored

`sl rebase --keep --rev <src> --dest <dest>` currently produces `git cherry-pick <src>` and ignores `--dest`. Must checkout dest first.

**Files:**
- Modify: `isl-server/src/vcs/GitDriver.ts`
- Modify: `isl/src/CommandHistoryAndProgress.tsx`
- Test: `isl-server/src/__tests__/GitDriverTranslations.test.ts`

**Step 1: Write the failing tests**

```typescript
describe('rebase --keep with --dest (RebaseKeepOperation)', () => {
  it('checks out destination before cherry-pick when --dest is provided', () => {
    const result = translate(['rebase', '--keep', '--rev', 'abc123', '--dest', 'def456']);
    expect(result.args[0]).toBe('__shell__');
    expect(result.args[1]).toContain('checkout def456');
    expect(result.args[1]).toContain('cherry-pick abc123');
  });

  it('falls back to direct cherry-pick when --dest is absent', () => {
    expect(translate(['rebase', '--keep', '--rev', 'abc123'])).toEqual({
      args: ['cherry-pick', 'abc123'],
      stdin: undefined,
    });
  });
});
```

**Step 2: Run to verify they fail**

```bash
cd /Users/jesselupica/Projects/champagne/isl-server
yarn test --testPathPattern=GitDriverTranslations 2>&1 | tail -20
```
Expected: FAIL — first test gets `{args: ['cherry-pick', 'abc123']}` (no checkout)

**Step 3: Modify the `--keep` block in `GitDriver.ts`**

Find the existing `--keep` handling (currently: `return {args: ['cherry-pick', src], stdin}`) and replace it:

```typescript
if (args.includes('--keep')) {
  const revIdx = args.indexOf('--rev');
  const destIdx = Math.max(args.indexOf('--dest'), args.indexOf('-d'));
  const src = revIdx !== -1 ? args[revIdx + 1] : undefined;
  const dest = destIdx !== -1 ? args[destIdx + 1] : undefined;
  if (!src) throw new Error('rebase --keep requires --rev');
  if (dest) {
    return {args: ['__shell__', `git checkout ${dest} && git cherry-pick ${src}`], stdin};
  }
  return {args: ['cherry-pick', src as string], stdin};
}
```

**Step 4: Run to verify tests pass**

```bash
cd /Users/jesselupica/Projects/champagne/isl-server
yarn test --testPathPattern=GitDriverTranslations 2>&1 | tail -20
```
Expected: PASS

**Step 5: Update `translateArgsForDisplay`**

In the `rebase` case, find the existing `--keep` display handler and update:

```typescript
if (args.includes('--keep')) {
  const revIdx = args.indexOf('--rev');
  const destIdx = Math.max(args.indexOf('--dest'), args.indexOf('-d'));
  const src = revIdx !== -1 ? args[revIdx + 1] : '??';
  const dest = destIdx !== -1 ? args[destIdx + 1] : null;
  if (dest) return ['checkout', dest, '&&', 'cherry-pick', src];
  return ['cherry-pick', src];
}
```

**Step 6: Commit**

```bash
git add isl-server/src/vcs/GitDriver.ts isl/src/CommandHistoryAndProgress.tsx isl-server/src/__tests__/GitDriverTranslations.test.ts
git commit -m "fix: RebaseKeepOperation now checks out destination before cherry-pick"
```

---

## Task 5: Fix `ContinueOperation` — detect merge type from `.git` state

`sl continue` always becomes `git rebase --continue`. If a `git merge` or `git cherry-pick` conflict is in progress, this is the wrong command.

**Files:**
- Modify: `isl-server/src/vcs/GitDriver.ts`
- Modify: `isl/src/CommandHistoryAndProgress.tsx`
- Test: `isl-server/src/__tests__/GitDriverTranslations.test.ts`

**Step 1: Write the failing tests**

```typescript
describe('continue (ContinueOperation)', () => {
  it('generates a shell script that routes to the correct --continue based on .git state', () => {
    const result = translate(['continue']);
    expect(result.args[0]).toBe('__shell__');
    expect(result.args[1]).toContain('REBASE_MERGE');
    expect(result.args[1]).toContain('rebase --continue');
    expect(result.args[1]).toContain('MERGE_HEAD');
    expect(result.args[1]).toContain('commit --no-edit');
    expect(result.args[1]).toContain('CHERRY_PICK_HEAD');
    expect(result.args[1]).toContain('cherry-pick --continue');
  });
});
```

**Step 2: Run to verify it fails**

```bash
cd /Users/jesselupica/Projects/champagne/isl-server
yarn test --testPathPattern=GitDriverTranslations 2>&1 | tail -20
```
Expected: FAIL — result is `{args: ['rebase', '--continue']}`, not a `__shell__` command

**Step 3: Replace the `continue` case in `GitDriver.ts`**

Find:
```typescript
if (args[0] === 'continue') {
  return {args: ['rebase', '--continue'], stdin};
}
```

Replace with:
```typescript
if (args[0] === 'continue') {
  const script =
    'if [ -d .git/REBASE_MERGE ] || [ -d .git/REBASE_APPLY ]; then git rebase --continue; ' +
    'elif [ -f .git/MERGE_HEAD ]; then git commit --no-edit; ' +
    'elif [ -f .git/CHERRY_PICK_HEAD ]; then git cherry-pick --continue; ' +
    'else echo "No operation in progress" && exit 1; fi';
  return {args: ['__shell__', script], stdin};
}
```

**Step 4: Run to verify tests pass**

```bash
cd /Users/jesselupica/Projects/champagne/isl-server
yarn test --testPathPattern=GitDriverTranslations 2>&1 | tail -20
```
Expected: PASS

**Step 5: Update `translateArgsForDisplay`**

Find the existing `continue` display case and replace:
```typescript
if (first === 'continue') return ['rebase/merge/cherry-pick', '--continue'];
```

**Step 6: Commit**

```bash
git add isl-server/src/vcs/GitDriver.ts isl/src/CommandHistoryAndProgress.tsx isl-server/src/__tests__/GitDriverTranslations.test.ts
git commit -m "fix: ContinueOperation now detects merge/cherry-pick vs rebase"
```

---

## Task 6: Fix `PullOperation` — plain pull must be fetch-only

`sl pull` (no `--rev`) passes through as `git pull`, which does fetch + merge. Must translate to `git fetch --all`.

**Files:**
- Modify: `isl-server/src/vcs/GitDriver.ts`
- Modify: `isl/src/CommandHistoryAndProgress.tsx`
- Test: `isl-server/src/__tests__/GitDriverTranslations.test.ts`

**Step 1: Write the failing test**

```typescript
describe('pull (plain, PullOperation)', () => {
  it('translates plain pull to fetch --all (not git pull which would merge)', () => {
    expect(translate(['pull'])).toEqual({
      args: ['fetch', '--all'],
      stdin: undefined,
    });
  });

  it('does not affect pull --rev (PullRevOperation still works)', () => {
    const result = translate(['pull', '--rev', 'abc123']);
    expect(result.args).not.toContain('--all');
  });
});
```

**Step 2: Run to verify it fails**

```bash
cd /Users/jesselupica/Projects/champagne/isl-server
yarn test --testPathPattern=GitDriverTranslations 2>&1 | tail -20
```
Expected: FAIL — `translate(['pull'])` returns `{args: ['pull']}` (pass-through)

**Step 3: Add the `pull` case in `GitDriver.ts`**

The `pull --rev` case is already handled (look for the `translatePullRevToGit` call). The plain `pull` case is missing. Add:

```typescript
if (args[0] === 'pull') {
  if (args.includes('--rev')) {
    return this.translatePullRevToGit(args, stdin);
  }
  // Plain pull = fetch only (do not merge into working directory)
  return {args: ['fetch', '--all'], stdin};
}
```

Note: remove any existing separate handling of `pull --rev` if it was at the top level — it should now be routed through this unified `pull` case.

**Step 4: Run to verify tests pass**

```bash
cd /Users/jesselupica/Projects/champagne/isl-server
yarn test --testPathPattern=GitDriverTranslations 2>&1 | tail -20
```
Expected: PASS

**Step 5: Update `translateArgsForDisplay`**

```typescript
if (first === 'pull' && !args.includes('--rev')) {
  return ['fetch', '--all'];
}
```

**Step 6: Commit**

```bash
git add isl-server/src/vcs/GitDriver.ts isl/src/CommandHistoryAndProgress.tsx isl-server/src/__tests__/GitDriverTranslations.test.ts
git commit -m "fix: plain pull translates to git fetch --all, not git pull"
```

---

## Task 7: Fix `HideOperation` — must hide descendants too

`git for-each-ref --points-at <hash>` only finds refs pointing **exactly** at the given hash. Branches on child commits are missed. Must switch to `git branch --contains <hash>` to find all branches where the hidden commit appears anywhere in history.

**Files:**
- Modify: `isl-server/src/vcs/GitDriver.ts` (`translateHideToGit` method)
- Test: `isl-server/src/__tests__/GitDriverTranslations.test.ts`

**Step 1: Write the failing tests**

```typescript
describe('hide --rev (HideOperation)', () => {
  it('uses --contains to find descendant branches, not just --points-at', () => {
    const result = translate(['hide', '--rev', 'abc123']);
    expect(result.args[0]).toBe('__shell__');
    expect(result.args[1]).toContain('--contains abc123');
    expect(result.args[1]).not.toContain('--points-at');
  });

  it('still deletes branches and moves HEAD away if needed', () => {
    const result = translate(['hide', '--rev', 'abc123']);
    expect(result.args[1]).toContain('branch -D');
  });
});
```

**Step 2: Run to verify they fail**

```bash
cd /Users/jesselupica/Projects/champagne/isl-server
yarn test --testPathPattern=GitDriverTranslations 2>&1 | tail -20
```
Expected: FAIL — script contains `--points-at`, not `--contains`

**Step 3: Replace `translateHideToGit` in `GitDriver.ts`**

Find the `translateHideToGit` method and replace its shell script generation:

```typescript
private translateHideToGit(args: string[], stdin: string | undefined): ResolvedCommand {
  const revIdx = args.indexOf('--rev');
  if (revIdx === -1) throw new Error('hide requires --rev <hash>');
  const hash = args[revIdx + 1];

  // If HEAD is currently at the hidden commit (or a descendant), move to the
  // hidden commit's parent first so we don't delete the checked-out branch.
  // Then delete all branches that contain the hidden commit in their history
  // (this covers the commit itself and all its draft descendants).
  const script = [
    // Move HEAD away if it points to the hidden commit or a descendant
    `if git merge-base --is-ancestor ${hash} HEAD 2>/dev/null; then git checkout --detach ${hash}^; fi`,
    // Delete every local branch that has the hidden commit as an ancestor
    `for b in $(git branch --contains ${hash} --format='%(refname:short)' 2>/dev/null); do git branch -D "$b"; done`,
  ].join(' && ');

  return {args: ['__shell__', script], stdin};
}
```

**Step 4: Run to verify tests pass**

```bash
cd /Users/jesselupica/Projects/champagne/isl-server
yarn test --testPathPattern=GitDriverTranslations 2>&1 | tail -20
```
Expected: PASS

**Step 5: Commit** (no frontend display change needed — hide display was already correct)

```bash
git add isl-server/src/vcs/GitDriver.ts isl-server/src/__tests__/GitDriverTranslations.test.ts
git commit -m "fix: HideOperation now deletes all descendant branches via --contains"
```

---

## Task 8: Fix `FoldOperation` — non-HEAD folds squash too many commits

The current implementation runs `git rebase -i <bottomHash>^`, which squashes from bottom all the way to HEAD. If the fold range is `B::C` but HEAD is at `D`, commit `D` gets wrongly squashed too. Must squash only `bottom::top`, then rebase any commits above `top` onto the new folded commit.

**Files:**
- Modify: `isl-server/src/vcs/GitDriver.ts` (`translateFoldToGit` method)
- Test: `isl-server/src/__tests__/GitDriverTranslations.test.ts`

**Step 1: Write the failing tests**

```typescript
describe('fold --exact (FoldOperation)', () => {
  it('generates a shell script that limits squash to the exact range', () => {
    const result = translate(['fold', '--exact', 'aaa111::bbb222', '--message', 'merged']);
    expect(result.args[0]).toBe('__shell__');
    // Must use the top hash (bbb222) to rebase descendants, not squash them
    expect(result.args[1]).toContain('bbb222');
    expect(result.args[1]).toContain('aaa111');
    expect(result.args[1]).toContain('merged');
  });

  it('script contains a rebase --onto step to replay commits above the fold range', () => {
    const result = translate(['fold', '--exact', 'aaa111::bbb222', '--message', 'merged']);
    expect(result.args[1]).toContain('rebase --onto');
  });
});
```

**Step 2: Run to verify they fail**

```bash
cd /Users/jesselupica/Projects/champagne/isl-server
yarn test --testPathPattern=GitDriverTranslations 2>&1 | tail -20
```
Expected: FAIL — current result is a `rebase -i` with env vars, not a shell script with `rebase --onto`

**Step 3: Replace `translateFoldToGit` in `GitDriver.ts`**

Find the existing `translateFoldToGit` and replace entirely:

```typescript
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
    `git checkout ${topHash}`,
    `git reset --soft ${bottomHash}^`,
    `git commit --message '${escapedMsg}'`,
    `FOLD=$(git rev-parse HEAD)`,
    // Only rebase if there were commits above topHash
    `if [ "$ORIG_TIP" != "${topHash}" ]; then`,
    `  git rebase --onto $FOLD ${topHash} $ORIG_TIP`,
    `  NEW_TIP=$(git rev-parse HEAD)`,
    `  if [ -n "$ORIG_BRANCH" ]; then git branch -f "$ORIG_BRANCH" $NEW_TIP && git checkout "$ORIG_BRANCH"; fi`,
    `else`,
    `  if [ -n "$ORIG_BRANCH" ]; then git branch -f "$ORIG_BRANCH" $FOLD && git checkout "$ORIG_BRANCH"; fi`,
    `fi`,
  ].join('\n');

  return {args: ['__shell__', script], stdin};
}
```

**Step 4: Run to verify tests pass**

```bash
cd /Users/jesselupica/Projects/champagne/isl-server
yarn test --testPathPattern=GitDriverTranslations 2>&1 | tail -20
```
Expected: PASS

**Step 5: Update `translateArgsForDisplay` for fold**

The fold display case references `rebase -i BOTTOM^` — update to reflect the new approach:

```typescript
if (first === 'fold') {
  const exactIdx = args.indexOf('--exact');
  const revset = exactIdx !== -1 ? String(args[exactIdx + 1]) : '??';
  const [bottom] = revset.split('::');
  return ['reset', '--soft', bottom + '^', '&&', 'commit', '(fold)'];
}
```

**Step 6: Commit**

```bash
git add isl-server/src/vcs/GitDriver.ts isl/src/CommandHistoryAndProgress.tsx isl-server/src/__tests__/GitDriverTranslations.test.ts
git commit -m "fix: FoldOperation now limits squash to exact range and rebases descendants"
```

---

## Task 9: Fix `AmendMessageOperation` — non-HEAD commits

`sl metaedit --rev <hash> --message <msg>` currently drops `--rev` and always amends HEAD. For non-HEAD commits, must chain: checkout target → amend message → rebase remaining stack → restore branch.

**Files:**
- Modify: `isl-server/src/vcs/GitDriver.ts`
- Modify: `isl/src/CommandHistoryAndProgress.tsx`
- Test: `isl-server/src/__tests__/GitDriverTranslations.test.ts`

**Step 1: Write the failing tests**

```typescript
describe('metaedit (AmendMessageOperation)', () => {
  it('amends a non-HEAD commit by checking it out, amending, then rebasing the stack', () => {
    const result = translate(['metaedit', '--rev', 'abc123', '--message', 'new msg']);
    expect(result.args[0]).toBe('__shell__');
    expect(result.args[1]).toContain('checkout abc123');
    expect(result.args[1]).toContain('commit --amend');
    expect(result.args[1]).toContain('new msg');
    expect(result.args[1]).toContain('rebase --onto');
  });

  it('includes --author when --user is provided', () => {
    const result = translate(['metaedit', '--rev', 'abc123', '--user', 'Bob <b@c.com>', '--message', 'msg']);
    expect(result.args[0]).toBe('__shell__');
    expect(result.args[1]).toContain('--author');
    expect(result.args[1]).toContain('Bob');
  });
});
```

**Step 2: Run to verify they fail**

```bash
cd /Users/jesselupica/Projects/champagne/isl-server
yarn test --testPathPattern=GitDriverTranslations 2>&1 | tail -20
```
Expected: FAIL — result is `{args: ['commit', '--amend', '--message', 'new msg']}`, not a shell script

**Step 3: Replace the `metaedit` case in `GitDriver.ts`**

Find the existing `metaedit` case and replace:

```typescript
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

  const escapedMsg = (msg as string).replace(/'/g, "'\\''");
  const authorFlag = author ? ` --author '${(author as string).replace(/'/g, "'\\''")}'` : '';

  // Use env var for message to avoid shell escaping issues with newlines
  const script = [
    `ORIG_BRANCH=$(git symbolic-ref --short HEAD 2>/dev/null || true)`,
    `ORIG_TIP=$(git rev-parse HEAD)`,
    `TARGET=${hash ?? 'HEAD'}`,
    `git checkout $TARGET`,
    `git commit --amend --only --message '${escapedMsg}'${authorFlag}`,
    `NEW_HASH=$(git rev-parse HEAD)`,
    `if [ "$ORIG_TIP" != "$TARGET" ]; then`,
    `  git rebase --onto $NEW_HASH $TARGET $ORIG_TIP`,
    `  NEW_TIP=$(git rev-parse HEAD)`,
    `  if [ -n "$ORIG_BRANCH" ]; then git branch -f "$ORIG_BRANCH" $NEW_TIP && git checkout "$ORIG_BRANCH"; fi`,
    `else`,
    `  if [ -n "$ORIG_BRANCH" ]; then git checkout "$ORIG_BRANCH"; fi`,
    `fi`,
  ].join('\n');

  return {args: ['__shell__', script], stdin};
}
```

**Step 4: Run to verify tests pass**

```bash
cd /Users/jesselupica/Projects/champagne/isl-server
yarn test --testPathPattern=GitDriverTranslations 2>&1 | tail -20
```
Expected: PASS

**Step 5: Update `translateArgsForDisplay`**

```typescript
if (first === 'metaedit') {
  const msgIdx = args.indexOf('--message');
  return ['commit', '--amend', '--only', '--message', msgIdx !== -1 ? args[msgIdx + 1] : '...'];
}
```

**Step 6: Commit**

```bash
git add isl-server/src/vcs/GitDriver.ts isl/src/CommandHistoryAndProgress.tsx isl-server/src/__tests__/GitDriverTranslations.test.ts
git commit -m "fix: metaedit now handles non-HEAD commits via checkout + amend + rebase"
```

---

## Task 10: Add missing `resolve --tool` translations

`sl resolve --tool internal:merge-local <file>`, `--tool internal:merge-other`, `--tool internal:union`, and external tool variants all pass through to git unchanged (which fails). Must translate each.

**Files:**
- Modify: `isl-server/src/vcs/GitDriver.ts` (the `resolve` case)
- Modify: `isl/src/CommandHistoryAndProgress.tsx`
- Test: `isl-server/src/__tests__/GitDriverTranslations.test.ts`

**Step 1: Write the failing tests**

```typescript
describe('resolve --tool variants', () => {
  it('translates internal:merge-local to checkout --ours + add', () => {
    const result = translate(['resolve', '--tool', 'internal:merge-local', 'conflict.txt']);
    expect(result.args[0]).toBe('__shell__');
    expect(result.args[1]).toContain('--ours');
    expect(result.args[1]).toContain('conflict.txt');
    expect(result.args[1]).toContain('git add');
  });

  it('translates internal:merge-other to checkout --theirs + add', () => {
    const result = translate(['resolve', '--tool', 'internal:merge-other', 'conflict.txt']);
    expect(result.args[0]).toBe('__shell__');
    expect(result.args[1]).toContain('--theirs');
    expect(result.args[1]).toContain('conflict.txt');
  });

  it('translates internal:union to merge-file --union using index stages', () => {
    const result = translate(['resolve', '--tool', 'internal:union', 'conflict.txt']);
    expect(result.args[0]).toBe('__shell__');
    expect(result.args[1]).toContain('merge-file');
    expect(result.args[1]).toContain('--union');
    expect(result.args[1]).toContain(':1:');
  });

  it('translates external tool to git mergetool --tool', () => {
    const result = translate(['resolve', '--tool', 'vimdiff', '--skip', 'conflict.txt']);
    expect(result.args).toEqual(['mergetool', '--tool', 'vimdiff', 'conflict.txt']);
  });

  it('translates resolve --all (RunMergeDriversOperation) to git mergetool', () => {
    expect(translate(['resolve', '--all'])).toEqual({
      args: ['mergetool'],
      stdin: undefined,
    });
  });
});
```

**Step 2: Run to verify they fail**

```bash
cd /Users/jesselupica/Projects/champagne/isl-server
yarn test --testPathPattern=GitDriverTranslations 2>&1 | tail -20
```
Expected: FAIL — `--tool` variants pass through unchanged

**Step 3: Extend the `resolve` case in `GitDriver.ts`**

Find the existing `resolve` case (currently handles only `--mark` and `--unmark`) and add after those two checks:

```typescript
if (args[0] === 'resolve') {
  if (args.includes('--mark')) {
    const files = args.filter(a => a !== 'resolve' && a !== '--mark');
    return {args: ['add', ...files], stdin};
  }
  if (args.includes('--unmark')) {
    const files = args.filter(a => a !== 'resolve' && a !== '--unmark');
    return {args: ['rm', '--cached', ...files], stdin};
  }

  // --tool variants (new)
  const toolIdx = args.indexOf('--tool');
  if (toolIdx !== -1) {
    const tool = args[toolIdx + 1] as string;
    // Collect file args: everything that isn't a flag or its value
    const files = args.filter((a, i, arr) =>
      a !== 'resolve' &&
      a !== '--tool' &&
      arr[i - 1] !== '--tool' &&
      a !== '--skip' &&
      a !== '--all',
    );

    if (tool === 'internal:merge-local') {
      // Keep our side of the conflict
      const cmds = files.map(f => `git checkout --ours -- "${f}" && git add "${f}"`);
      return {args: ['__shell__', cmds.join(' && ')], stdin};
    }
    if (tool === 'internal:merge-other') {
      // Keep their side of the conflict
      const cmds = files.map(f => `git checkout --theirs -- "${f}" && git add "${f}"`);
      return {args: ['__shell__', cmds.join(' && ')], stdin};
    }
    if (tool === 'internal:union') {
      // Keep all lines from both sides using git merge-file --union
      // :1: = base, :2: = ours, :3: = theirs in git's index stages
      const cmds = files.map(f =>
        `git show :1:"${f}" > /tmp/base.merge && ` +
        `git show :2:"${f}" > /tmp/ours.merge && ` +
        `git show :3:"${f}" > /tmp/theirs.merge && ` +
        `git merge-file -p --union /tmp/ours.merge /tmp/base.merge /tmp/theirs.merge > "${f}" && ` +
        `git add "${f}"`,
      );
      return {args: ['__shell__', cmds.join(' && ')], stdin};
    }

    // External merge tool (e.g. vimdiff, meld, opendiff)
    if (files.length > 0) {
      return {args: ['mergetool', '--tool', tool, ...files], stdin};
    }
    return {args: ['mergetool', '--tool', tool], stdin};
  }

  // resolve --all: run merge drivers on all conflicted files
  if (args.includes('--all')) {
    return {args: ['mergetool'], stdin};
  }

  // Pass through (e.g. internal:dumpjson used by checkMergeConflicts data fetch)
  return {args, stdin};
}
```

**Step 4: Run to verify tests pass**

```bash
cd /Users/jesselupica/Projects/champagne/isl-server
yarn test --testPathPattern=GitDriverTranslations 2>&1 | tail -20
```
Expected: PASS

**Step 5: Update `translateArgsForDisplay`**

In the `resolve` display case, add after `--mark`/`--unmark`:

```typescript
const toolIdx = args.indexOf('--tool');
if (toolIdx !== -1) {
  const tool = String(args[toolIdx + 1]);
  if (tool === 'internal:merge-local') return ['checkout', '--ours', '--', '...'];
  if (tool === 'internal:merge-other') return ['checkout', '--theirs', '--', '...'];
  if (tool === 'internal:union') return ['merge-file', '--union', '...'];
  return ['mergetool', '--tool', tool];
}
if (args.includes('--all')) return ['mergetool'];
```

**Step 6: Commit**

```bash
git add isl-server/src/vcs/GitDriver.ts isl/src/CommandHistoryAndProgress.tsx isl-server/src/__tests__/GitDriverTranslations.test.ts
git commit -m "fix: add resolve --tool translations for merge-local, merge-other, union, external"
```

---

## Task 11: Fix `GotoOperation` — carry uncommitted changes when switching commits

`sl goto --rev <hash>` (without `--clean`) currently runs `git checkout <hash>`, which fails if there are uncommitted changes that conflict with the target. Sapling carries changes forward. Must stash and pop.

**Files:**
- Modify: `isl-server/src/vcs/GitDriver.ts`
- Modify: `isl/src/CommandHistoryAndProgress.tsx`
- Test: `isl-server/src/__tests__/GitDriverTranslations.test.ts`

**Step 1: Write the failing test**

The current `goto --rev HASH` test expects `{args: ['checkout', 'HASH']}`. After this change, it will produce a shell script. Update the existing test and add a new one:

```typescript
describe('goto (GotoOperation)', () => {
  // Update the existing test — result is now a shell script
  it('generates a stash/checkout/pop script to carry uncommitted changes', () => {
    const result = translate(['goto', '--rev', 'abc123']);
    expect(result.args[0]).toBe('__shell__');
    expect(result.args[1]).toContain('checkout abc123');
    // Must stash if changes exist, then pop after
    expect(result.args[1]).toContain('stash');
  });

  // --clean case is unchanged
  it('translates goto --clean . to checkout -- . (unchanged)', () => {
    expect(translate(['goto', '--clean', '.'])).toEqual({
      args: ['checkout', '--', '.'],
      stdin: undefined,
    });
  });
});
```

**Step 2: Run to verify the first test fails**

```bash
cd /Users/jesselupica/Projects/champagne/isl-server
yarn test --testPathPattern=GitDriverTranslations 2>&1 | tail -20
```
Expected: FAIL — result is `{args: ['checkout', 'abc123']}`

**Step 3: Replace the `goto` case in `GitDriver.ts`**

Find the existing `goto` case and replace the non-`--clean` branch:

```typescript
if (args[0] === 'goto') {
  if (args.includes('--clean')) {
    const files = args.filter(a => a !== 'goto' && a !== '--clean');
    return {args: ['checkout', '--', ...files], stdin};
  }
  const revIdx = args.indexOf('--rev');
  const hash = revIdx !== -1 ? args[revIdx + 1] : args[1];

  // Stash uncommitted changes, checkout destination, then restore.
  // This mirrors Sapling's behavior of carrying changes to the new commit.
  const script =
    `HAS_CHANGES=$(git status --porcelain | grep -v "^??" | wc -l | tr -d " ") && ` +
    `if [ "$HAS_CHANGES" -gt 0 ]; then ` +
    `  git stash push && git checkout ${hash} && git stash pop; ` +
    `else ` +
    `  git checkout ${hash}; ` +
    `fi`;
  return {args: ['__shell__', script], stdin};
}
```

**Step 4: Run to verify tests pass**

```bash
cd /Users/jesselupica/Projects/champagne/isl-server
yarn test --testPathPattern=GitDriverTranslations 2>&1 | tail -20
```
Expected: PASS

**Step 5: Update `translateArgsForDisplay`**

```typescript
if (first === 'goto') {
  if (args.includes('--clean')) {
    const files = args.filter(a => a !== 'goto' && a !== '--clean');
    return ['checkout', '--', ...files];
  }
  const revIdx = args.indexOf('--rev');
  const hash = revIdx !== -1 ? args[revIdx + 1] : args[1];
  return ['checkout', hash];  // Display simplified; stash/pop is an impl detail
}
```

**Step 6: Commit**

```bash
git add isl-server/src/vcs/GitDriver.ts isl/src/CommandHistoryAndProgress.tsx isl-server/src/__tests__/GitDriverTranslations.test.ts
git commit -m "fix: GotoOperation stashes and restores WD changes when switching commits"
```

---

## Task 12: Add `AmendToOperation` translation

`sl amend --to <commit> [files...]` has no case in the switch and passes through to git, which fails. Must implement the multi-step shell chain.

**Files:**
- Modify: `isl-server/src/vcs/GitDriver.ts`
- Modify: `isl/src/CommandHistoryAndProgress.tsx`
- Test: `isl-server/src/__tests__/GitDriverTranslations.test.ts`

**Step 1: Write the failing tests**

```typescript
describe('amend --to (AmendToOperation)', () => {
  it('generates a stash/checkout/amend/rebase chain', () => {
    const result = translate(['amend', '--to', 'abc123', 'file.txt']);
    expect(result.args[0]).toBe('__shell__');
    expect(result.args[1]).toContain('stash push');
    expect(result.args[1]).toContain('checkout abc123');
    expect(result.args[1]).toContain('stash pop');
    expect(result.args[1]).toContain('commit --amend');
    expect(result.args[1]).toContain('rebase --onto');
  });

  it('works with no specific files (amend all stashed changes)', () => {
    const result = translate(['amend', '--to', 'abc123']);
    expect(result.args[0]).toBe('__shell__');
    expect(result.args[1]).toContain('checkout abc123');
    expect(result.args[1]).toContain('commit --amend');
  });
});
```

**Step 2: Run to verify they fail**

```bash
cd /Users/jesselupica/Projects/champagne/isl-server
yarn test --testPathPattern=GitDriverTranslations 2>&1 | tail -20
```
Expected: FAIL — `amend --to` hits the existing `amend` case (translates to `git commit --amend --to abc123 file.txt`), which git rejects

**Step 3: Add `--to` detection at the top of the `amend` case in `GitDriver.ts`**

Inside the `amend` case, add a check **before** the existing translation:

```typescript
if (args[0] === 'amend') {
  // AmendToOperation: sl amend --to <target> [files...]
  // Absorb WD changes into a specific non-HEAD commit
  const toIdx = args.indexOf('--to');
  if (toIdx !== -1) {
    const target = args[toIdx + 1] as string;
    const files = args.filter((a, i, arr) =>
      a !== 'amend' && a !== '--to' && arr[i - 1] !== '--to',
    );
    const stashFiles = files.length > 0 ? `-- ${files.map(f => `"${f}"`).join(' ')}` : '';

    const script = [
      `ORIG_BRANCH=$(git symbolic-ref --short HEAD 2>/dev/null || true)`,
      `ORIG_TIP=$(git rev-parse HEAD)`,
      `git stash push ${stashFiles}`,
      `git checkout ${target}`,
      `git stash pop`,
      files.length > 0 ? `git add ${files.map(f => `"${f}"`).join(' ')}` : `git add -A`,
      `git commit --amend --no-edit`,
      `NEW_TARGET=$(git rev-parse HEAD)`,
      `if [ "$ORIG_TIP" != "${target}" ]; then`,
      `  git rebase --onto $NEW_TARGET ${target} $ORIG_TIP`,
      `  NEW_TIP=$(git rev-parse HEAD)`,
      `  if [ -n "$ORIG_BRANCH" ]; then git branch -f "$ORIG_BRANCH" $NEW_TIP && git checkout "$ORIG_BRANCH"; fi`,
      `else`,
      `  if [ -n "$ORIG_BRANCH" ]; then git checkout "$ORIG_BRANCH"; fi`,
      `fi`,
    ].join('\n');

    return {args: ['__shell__', script], stdin};
  }

  // ... existing amend translation continues below ...
}
```

**Step 4: Run to verify tests pass**

```bash
cd /Users/jesselupica/Projects/champagne/isl-server
yarn test --testPathPattern=GitDriverTranslations 2>&1 | tail -20
```
Expected: PASS

**Step 5: Update `translateArgsForDisplay`**

In the `amend` display case, add before existing logic:

```typescript
if (first === 'amend') {
  const toIdx = args.indexOf('--to');
  if (toIdx !== -1) {
    return ['commit', '--amend', '(into', args[toIdx + 1] + ')'];
  }
  // ... existing display logic ...
}
```

**Step 6: Commit**

```bash
git add isl-server/src/vcs/GitDriver.ts isl/src/CommandHistoryAndProgress.tsx isl-server/src/__tests__/GitDriverTranslations.test.ts
git commit -m "feat: implement AmendToOperation via stash/checkout/amend/rebase chain"
```

---

## Task 13: Implement `getBlame()`

`getBlame()` currently returns an empty object. Must parse `git blame --porcelain` output into `{lineContent, commit}[]`.

**Files:**
- Modify: `isl-server/src/vcs/GitDriver.ts` (`getBlame` method)
- Test: `isl-server/src/__tests__/GitDriverTranslations.test.ts` (or new `GitDriverBlame.test.ts`)

**Step 1: Understand the `git blame --porcelain` output format**

Each group in the output looks like:
```
<40-char-hash> <orig-line> <final-line> <num-lines>
author <name>
author-mail <email>
author-time <unix-timestamp>
author-tz <tz>
committer <name>
committer-mail <email>
committer-time <unix-timestamp>
committer-tz <tz>
summary <first-line-of-message>
filename <filename>
	<line content starting with tab>
```
The hash line only includes all metadata on the **first occurrence** of that hash. Subsequent lines in the same commit only have `<hash> <orig> <final> <count>` followed by `filename` and content.

**Step 2: Write the failing test**

Create a new file:

```typescript
// isl-server/src/__tests__/GitDriverBlame.test.ts
import {GitDriver} from '../vcs/GitDriver';

// Sample git blame --porcelain output (two lines from two different commits)
const SAMPLE_BLAME_OUTPUT = `abc1234567890123456789012345678901234567890 1 1 1
author Alice
author-mail <alice@example.com>
author-time 1700000000
author-tz +0000
committer Alice
committer-mail <alice@example.com>
committer-time 1700000000
committer-tz +0000
summary first commit
filename src/app.ts
\thello world
def9876543210987654321098765432109876543210 2 2 1
author Bob
author-mail <bob@example.com>
author-time 1700000001
author-tz +0000
committer Bob
committer-mail <bob@example.com>
committer-time 1700000001
committer-tz +0000
summary second commit
filename src/app.ts
\tsecond line
`;

describe('GitDriver.parseBlameOutput', () => {
  it('parses porcelain blame into line entries', () => {
    const driver = new GitDriver();
    const result = (driver as any).parseBlameOutput(SAMPLE_BLAME_OUTPUT);
    expect(result).toHaveLength(2);
    expect(result[0].lineContent).toBe('hello world');
    expect(result[0].commit?.hash).toBe('abc1234567890123456789012345678901234567890');
    expect(result[0].commit?.author).toBe('Alice <alice@example.com>');
    expect(result[1].lineContent).toBe('second line');
    expect(result[1].commit?.hash).toBe('def9876543210987654321098765432109876543210');
  });
});
```

**Step 3: Run to verify it fails**

```bash
cd /Users/jesselupica/Projects/champagne/isl-server
yarn test --testPathPattern=GitDriverBlame 2>&1 | tail -20
```
Expected: FAIL — `parseBlameOutput` does not exist

**Step 4: Add `parseBlameOutput` and fill in `getBlame` in `GitDriver.ts`**

```typescript
// Add private helper method to GitDriver class:
private parseBlameOutput(output: string): Array<{lineContent: string; commit: CommitInfo | undefined}> {
  const lines = output.split('\n');
  const result: Array<{lineContent: string; commit: CommitInfo | undefined}> = [];
  const commitCache = new Map<string, CommitInfo>();

  let i = 0;
  while (i < lines.length) {
    const headerMatch = lines[i].match(/^([0-9a-f]{40}) \d+ \d+ \d+/);
    if (!headerMatch) { i++; continue; }

    const hash = headerMatch[1];
    i++;

    // Parse metadata lines until we hit the content line (starts with tab)
    const meta: Record<string, string> = {};
    while (i < lines.length && !lines[i].startsWith('\t')) {
      const metaMatch = lines[i].match(/^(\S+) (.+)/);
      if (metaMatch) meta[metaMatch[1]] = metaMatch[2];
      i++;
    }

    const lineContent = lines[i] ? lines[i].slice(1) : ''; // strip leading tab
    i++;

    if (!commitCache.has(hash) && meta['author']) {
      // Build a minimal CommitInfo from the blame metadata
      const commit: CommitInfo = {
        hash,
        title: meta['summary'] ?? '',
        description: meta['summary'] ?? '',
        author: `${meta['author']} ${meta['author-mail'] ?? ''}`.trim(),
        date: new Date(parseInt(meta['author-time'] ?? '0', 10) * 1000),
        parents: [],
        bookmarks: [],
        remoteBookmarks: [],
        isDot: false,
        isHead: false,
        phase: 'public',
        closestPredecessors: [],
        filesSample: [],
        totalFileCount: 0,
      };
      commitCache.set(hash, commit);
    }

    result.push({lineContent, commit: commitCache.get(hash)});
  }
  return result;
}

// Replace the existing stub getBlame:
async getBlame(
  ctx: RepositoryContext,
  path: RepoRelativePath,
  hash: Hash,
): Promise<BlameInfo[]> {
  const output = await runGitCommand(ctx, ['blame', '--porcelain', hash, '--', path]);
  return this.parseBlameOutput(output);
}
```

**Step 5: Run to verify tests pass**

```bash
cd /Users/jesselupica/Projects/champagne/isl-server
yarn test --testPathPattern=GitDriverBlame 2>&1 | tail -20
```
Expected: PASS

**Step 6: Run all server tests to check for regressions**

```bash
cd /Users/jesselupica/Projects/champagne/isl-server
yarn test 2>&1 | tail -20
```
Expected: all pass

**Step 7: Commit**

```bash
git add isl-server/src/vcs/GitDriver.ts isl-server/src/__tests__/GitDriverBlame.test.ts
git commit -m "feat: implement getBlame() using git blame --porcelain"
```

---

## Task 14: Final verification — run full test suite

**Step 1: Run all server tests**

```bash
cd /Users/jesselupica/Projects/champagne/isl-server
yarn test 2>&1 | tail -30
```
Expected: all tests pass

**Step 2: Run all client tests**

```bash
cd /Users/jesselupica/Projects/champagne/isl
yarn test 2>&1 | tail -30
```
Expected: all tests pass

**Step 3: TypeScript compile check**

```bash
cd /Users/jesselupica/Projects/champagne/isl-server && yarn build 2>&1 | tail -10
cd /Users/jesselupica/Projects/champagne/isl && npx tsc --noEmit 2>&1 | head -20
```
Expected: no errors

**Step 4: Commit if any fixes needed**

```bash
git add -p
git commit -m "fix: resolve any type errors from gap fix tasks"
```

---

## Summary of All Fixes

| Task | Gap Fixed | Strategy |
|---|---|---|
| 1 | `AbortMergeOperation` crash | Detect `--abort`/`--quit` before `-s`/`-d` parsing; shell script to detect op type |
| 2 | `BulkRebaseOperation` crash | Detect `--rev` (not `-s`) form; `checkout dest && cherry-pick revs` |
| 3 | `RebaseAllDraftCommitsOperation` invalid command | Detect `draft()` source; `merge-base` shell script |
| 4 | `RebaseKeepOperation` ignores dest | Parse `--dest`; `checkout dest && cherry-pick src` |
| 5 | `ContinueOperation` wrong command | Shell script to check `.git/REBASE_MERGE`, `MERGE_HEAD`, `CHERRY_PICK_HEAD` |
| 6 | `PullOperation` does fetch+merge | Add plain `pull` case → `fetch --all` |
| 7 | `HideOperation` misses descendants | `--contains` instead of `--points-at` |
| 8 | `FoldOperation` squashes too far | Shell: detach at top, reset to bottom^, commit, rebase descendants |
| 9 | `AmendMessageOperation` HEAD-only | Shell: checkout target, amend, rebase stack |
| 10 | Missing `resolve --tool` translations | `checkout --ours/--theirs`, `merge-file --union`, `mergetool` |
| 11 | `GotoOperation` fails with dirty WD | Shell: stash if dirty, checkout, stash pop |
| 12 | `AmendToOperation` unimplemented | Shell: stash files, checkout target, pop, amend, rebase |
| 13 | `getBlame()` stub | Parse `git blame --porcelain` output |
| 14 | Final verification | Full test suite + TypeScript compile |
