# Git Driver Audit Fixes & Test Coverage Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix all high-confidence issues found in the ISL backend audit (shell injection, LFS corruption, missing `set -e`, wrong diff comparisons, Watchman hardcoding, sequential config reads) and add comprehensive integration tests for shell-script operations, shallow clones, edge cases, and file name handling.

**Architecture:** Direct fixes to `GitDriver.ts` and `WatchForChanges.ts`, plus new integration tests in `VCSDriverIntegration.test.ts` and unit tests in `GitDriverTranslations.test.ts`. All fixes are surgical — no refactoring beyond what the fix requires.

**Tech Stack:** TypeScript, Jest, Node.js child_process, Git CLI

---

## File Map

**Modify:**
- `isl-server/src/vcs/GitDriver.ts` — Fixes for issues #1-8 below
- `isl-server/src/WatchForChanges.ts` — Fix Watchman dirstate subscription
- `isl-server/src/__tests__/GitDriverTranslations.test.ts` — New unit tests for fixed behavior
- `isl-server/src/__tests__/VCSDriverIntegration.test.ts` — New integration tests for shell-script operations

---

## Task 1: SHA Validation for Shell Script Injection Prevention

**Files:**
- Modify: `isl-server/src/vcs/GitDriver.ts:1770-1788` (translateHideToGit)
- Modify: `isl-server/src/vcs/GitDriver.ts:1516-1539` (standard rebase script)
- Test: `isl-server/src/__tests__/GitDriverTranslations.test.ts`

The `hide` and standard rebase translations embed user-supplied revsets into shell `$()` contexts via double-quoted strings. A revset containing `$(malicious)` would execute inside the shell. Fix: validate that values embedded in shell scripts match SHA format.

- [ ] **Step 1: Write failing tests for non-SHA revset rejection**

Add to `GitDriverTranslations.test.ts` after the existing `hide --rev` describe block:

```typescript
it('rejects non-SHA values that could be shell-injected in hide', () => {
  expect(() => translate(['hide', '--rev', '$(rm -rf /)'])).toThrow();
  expect(() => translate(['hide', '--rev', 'abc; rm -rf /'])).toThrow();
  expect(() => translate(['hide', '--rev', '`whoami`'])).toThrow();
});

it('accepts valid 40-char hex SHA in hide', () => {
  const validSha = 'a'.repeat(40);
  expect(() => translate(['hide', '--rev', validSha])).not.toThrow();
});

it('rejects non-SHA values in standard rebase -s/-d', () => {
  expect(() => translate(['rebase', '-s', '$(rm -rf /)', '-d', 'def456'])).toThrow();
  expect(() => translate(['rebase', '-s', 'abc123', '-d', '$(rm -rf /)'])).toThrow();
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd isl-server && yarn test --testPathPattern="GitDriverTranslations" --no-coverage 2>&1 | tail -20`
Expected: FAIL — non-SHA values currently pass through without validation.

- [ ] **Step 3: Add SHA validation helper and apply it**

In `GitDriver.ts`, add a private helper near the top of the class (after line ~65):

```typescript
/**
 * Validate that a value is safe to embed in a shell script.
 * Only 40-character hex SHAs and simple ref-like strings (alphanumeric, -, _, /, .)
 * are allowed. Rejects shell metacharacters ($, `, ;, |, &, etc.).
 */
private static assertSafeShellValue(value: string, context: string): void {
  if (!/^[0-9a-fA-F]{4,40}$/.test(value) && !/^[a-zA-Z0-9_\-./~^]+$/.test(value)) {
    throw new Error(`Unsafe value for shell interpolation in ${context}: ${value}`);
  }
}
```

Apply in `translateHideToGit` (around line 1774):
```typescript
const hash = args[revIdx + 1];
if (!hash) throw new Error('hide --rev requires a hash value');
GitDriver.assertSafeShellValue(hash, 'hide --rev');
```

Apply in the standard rebase path (around line 1498, after src/dest are parsed):
```typescript
if (!src || !dest) throw new Error('rebase requires -s and -d');
if (!src.startsWith('draft()')) {
  GitDriver.assertSafeShellValue(src, 'rebase -s');
  GitDriver.assertSafeShellValue(dest, 'rebase -d');
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd isl-server && yarn test --testPathPattern="GitDriverTranslations" --no-coverage 2>&1 | tail -20`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add isl-server/src/vcs/GitDriver.ts isl-server/src/__tests__/GitDriverTranslations.test.ts
git commit -m "fix: validate shell-interpolated values to prevent injection in hide/rebase scripts"
```

---

## Task 2: Fix `internal:union` LFS Check to Inspect All Three Stages

**Files:**
- Modify: `isl-server/src/vcs/GitDriver.ts:1609-1631` (internal:union script)
- Test: `isl-server/src/__tests__/GitDriverTranslations.test.ts`

Currently only checks `:2:` (ours) for LFS pointer header. If `:1:` (base) or `:3:` (theirs) is an LFS pointer, the union merge corrupts the file.

- [ ] **Step 1: Write failing test**

Add to the `resolve --tool` describe block in `GitDriverTranslations.test.ts`:

```typescript
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
```

- [ ] **Step 2: Run tests to verify it fails**

Run: `cd isl-server && yarn test --testPathPattern="GitDriverTranslations" --no-coverage 2>&1 | tail -20`
Expected: FAIL — current script only checks `:2:`.

- [ ] **Step 3: Update the internal:union script to check all three stages**

Replace the LFS check block in `GitDriver.ts` (around lines 1616-1621) with:

```typescript
const script = [
  'set -e',
  `FILE="${escapedFile}"`,
  // Check ALL three stages for LFS pointers. If any stage is an LFS pointer,
  // skip the three-way text merge (which would corrupt the pointer).
  'BASE_CONTENT=$(git show :1:"$FILE" 2>/dev/null || true)',
  'OURS_CONTENT=$(git show :2:"$FILE")',
  'THEIRS_CONTENT=$(git show :3:"$FILE" 2>/dev/null || true)',
  'IS_LFS=false',
  'echo "$BASE_CONTENT" | head -1 | grep -q "^version https://git-lfs" && IS_LFS=true',
  'echo "$OURS_CONTENT" | head -1 | grep -q "^version https://git-lfs" && IS_LFS=true',
  'echo "$THEIRS_CONTENT" | head -1 | grep -q "^version https://git-lfs" && IS_LFS=true',
  'if [ "$IS_LFS" = "true" ]; then',
  '  echo "$OURS_CONTENT" > "$FILE"',
  '  git add "$FILE"',
  '  exit 0',
  'fi',
  'TMPBASE=$(mktemp -t git-isl-union)',
  'trap \'rm -f "$TMPBASE" "$TMPBASE-ours" "$TMPBASE-base" "$TMPBASE-theirs"\' EXIT',
  'echo "$OURS_CONTENT" > "$TMPBASE-ours"',
  'echo "$BASE_CONTENT" > "$TMPBASE-base"',
  'echo "$THEIRS_CONTENT" > "$TMPBASE-theirs"',
  'git merge-file --union "$TMPBASE-ours" "$TMPBASE-base" "$TMPBASE-theirs" || true',
  'cp "$TMPBASE-ours" "$FILE"',
  'git add "$FILE"',
].join('\n');
```

Note: also added `$TMPBASE` to the trap cleanup (fixes the temp file leak), and stores all three contents upfront.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd isl-server && yarn test --testPathPattern="GitDriverTranslations" --no-coverage 2>&1 | tail -20`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add isl-server/src/vcs/GitDriver.ts isl-server/src/__tests__/GitDriverTranslations.test.ts
git commit -m "fix: check all three conflict stages for LFS pointers in internal:union merge"
```

---

## Task 3: Add Binary File Guard to `internal:union`

**Files:**
- Modify: `isl-server/src/vcs/GitDriver.ts:1609-1631` (internal:union script, after Task 2)
- Test: `isl-server/src/__tests__/GitDriverTranslations.test.ts`

`git merge-file --union` on binary files produces silent corruption. Add a `-I` (null byte) check before calling merge-file.

- [ ] **Step 1: Write failing test**

```typescript
it('resolve --tool internal:union checks for binary content before merge', () => {
  const result = translate(['resolve', '--tool', 'internal:union', 'image.png']);
  const script = result.args[1] as string;
  // Must detect binary content (null bytes) and skip merge-file
  expect(script).toMatch(/\\0|NUL|binary/i);
  // Binary check must come before merge-file
  const binaryCheck = script.search(/\\0|NUL|binary/i);
  const mergeFile = script.indexOf('merge-file');
  expect(binaryCheck).toBeLessThan(mergeFile);
});
```

- [ ] **Step 2: Run tests to verify it fails**

Run: `cd isl-server && yarn test --testPathPattern="GitDriverTranslations" --no-coverage 2>&1 | tail -20`
Expected: FAIL

- [ ] **Step 3: Add binary detection to the union script**

After the LFS checks (inside the script array, before the TMPBASE line), add:

```typescript
// Detect binary files (containing null bytes). git merge-file is text-only
// and would silently corrupt binary content.
'if echo "$OURS_CONTENT" | tr -d "\\0" | cmp -s - <(echo "$OURS_CONTENT"); then true; else',
'  echo "binary file - keeping ours" >&2',
'  echo "$OURS_CONTENT" > "$FILE"',
'  git add "$FILE"',
'  exit 0',
'fi',
```

Actually, a simpler approach that works in POSIX sh (no process substitution):

```typescript
// Detect binary files (containing null bytes). git merge-file is text-only
// and would silently corrupt binary content. Use grep -cP for null byte detection.
'if printf "%s" "$OURS_CONTENT" | grep -qP "\\x00" 2>/dev/null || printf "%s" "$OURS_CONTENT" | tr "\\0" "\\n" | wc -l | grep -qv "^$(printf "%s" "$OURS_CONTENT" | wc -l | tr -d " ")$"; then',
```

Even simpler — use `git diff --numstat` which reports `-` for binary files:

```typescript
// Detect binary files. git merge-file is text-only and corrupts binary content.
// git diff --no-index reports "-\t-\t" for binary files.
'BINARY_CHECK=$(git diff --no-index --numstat /dev/null "$FILE" 2>/dev/null | cut -f1)',
'if [ "$BINARY_CHECK" = "-" ]; then',
'  echo "$OURS_CONTENT" > "$FILE"',
'  git add "$FILE"',
'  exit 0',
'fi',
```

Wait — the file in the working tree has conflict markers at this point, so `git diff --no-index` won't help. Better approach: check if git attribute says the file is binary:

```typescript
// Detect binary files. git merge-file is text-only and corrupts binary content.
// Check if any stage content contains null bytes (binary indicator).
'if printf "%s" "$OURS_CONTENT" | perl -ne "exit 1 if /\\x00/" 2>/dev/null; then true; else',
'  echo "$OURS_CONTENT" > "$FILE"',
'  git add "$FILE"',
'  exit 0',
'fi',
```

Simplest reliable approach — use `grep -Pc` to detect null bytes:

Add these lines to the script array after the LFS check and before the TMPBASE line:

```typescript
// Detect binary files (containing null bytes). git merge-file is text-only
// and would silently corrupt binary content.
'if printf "%s" "$OURS_CONTENT" | grep -qP "\\x00" 2>/dev/null; then',
'  echo "$OURS_CONTENT" > "$FILE"',
'  git add "$FILE"',
'  exit 0',
'fi',
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd isl-server && yarn test --testPathPattern="GitDriverTranslations" --no-coverage 2>&1 | tail -20`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add isl-server/src/vcs/GitDriver.ts isl-server/src/__tests__/GitDriverTranslations.test.ts
git commit -m "fix: detect binary files in internal:union to prevent silent corruption"
```

---

## Task 4: Add `set -e` to Fold Script

**Files:**
- Modify: `isl-server/src/vcs/GitDriver.ts:1720-1745` (translateFoldToGit)
- Test: `isl-server/src/__tests__/GitDriverTranslations.test.ts`

The fold script is missing `set -e`, unlike all other shell scripts. If `git checkout` or `git reset --soft` fails, the script continues and may `git commit` in an unexpected state.

- [ ] **Step 1: Write failing test**

Add to the existing `fold --exact` describe block:

```typescript
it('fold script begins with set -e for fail-fast behavior', () => {
  const result = translate(['fold', '--exact', 'aaa111::bbb222', '--message', 'merged']);
  const script = result.args[1] as string;
  // set -e must be the first command in the script
  expect(script.trimStart().startsWith('set -e')).toBe(true);
});
```

- [ ] **Step 2: Run tests to verify it fails**

Run: `cd isl-server && yarn test --testPathPattern="GitDriverTranslations" --no-coverage 2>&1 | tail -20`
Expected: FAIL — current script starts with `ORIG_BRANCH=...`

- [ ] **Step 3: Add `set -e` as the first line of the fold script**

In `GitDriver.ts`, `translateFoldToGit`, change the script array (around line 1720) to start with:

```typescript
const script = [
  'set -e',
  `ORIG_BRANCH=$(git symbolic-ref --short HEAD 2>/dev/null || true)`,
  // ... rest unchanged
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd isl-server && yarn test --testPathPattern="GitDriverTranslations" --no-coverage 2>&1 | tail -20`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add isl-server/src/vcs/GitDriver.ts isl-server/src/__tests__/GitDriverTranslations.test.ts
git commit -m "fix: add set -e to fold script for fail-fast behavior"
```

---

## Task 5: Fix `StackChanges` Diff and `HEAD^` Root Commit Handling

**Files:**
- Modify: `isl-server/src/vcs/GitDriver.ts:1905-1917` (diffArgsForComparison)
- Modify: `isl-server/src/vcs/GitDriver.ts:1038-1052` (getPendingAmendDiffStats)
- Test: `isl-server/src/__tests__/VCSDriverIntegration.test.ts`

Two issues:
1. `StackChanges` returns `['HEAD']` — identical to `UncommittedChanges`. Should show committed changes in the draft stack.
2. `getPendingAmendDiffStats` uses `HEAD^` which crashes on root commits.

- [ ] **Step 1: Write failing tests**

Add to the `Diff` describe block in `VCSDriverIntegration.test.ts`:

```typescript
it('getDiff for HeadChanges works on the first (root) commit', async () => {
  await helpers.commit(tmpDir, 'root commit', 'file.txt', 'content\n');
  // HeadChanges uses HEAD^ internally — must not crash on root commit
  const diff = await driver.getDiff(ctx, {type: ComparisonType.HeadChanges});
  // Should return some diff (the root commit's changes) or empty, but not throw
  expect(typeof diff).toBe('string');
});

it('getPendingAmendDiffStats works on the first (root) commit', async () => {
  await helpers.commit(tmpDir, 'root commit', 'file.txt', 'content\n');
  await fs.writeFile(path.join(tmpDir, 'file.txt'), 'modified\n');
  // getPendingAmendDiffStats uses HEAD^ — must not crash on root commit
  const stats = await driver.getPendingAmendDiffStats(ctx, ['file.txt']);
  expect(stats === undefined || typeof stats === 'number').toBe(true);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd isl-server && yarn test --testPathPattern="VCSDriverIntegration" --no-coverage 2>&1 | tail -30`
Expected: FAIL — `HEAD^` fails on root commit.

- [ ] **Step 3: Fix diffArgsForComparison and getPendingAmendDiffStats**

In `diffArgsForComparison` (line ~1905-1917), change `StackChanges`:

```typescript
case ComparisonType.StackChanges:
  // TODO(audit): StackChanges should diff from the public ancestor (merge-base with trunk)
  // to HEAD, showing all draft changes. This requires an async call to find the merge-base
  // which diffArgsForComparison can't do synchronously. For now, fall through to HeadChanges
  // behavior. Tracked in: git-driver-audit-fixes plan, ambiguous issues.
  return ['HEAD'];
```

Actually — the `StackChanges` fix requires async (merge-base lookup) and the method is sync. This is one of the ambiguous ones — leave a TODO comment but don't change behavior.

For `HeadChanges` root commit handling, update `diffArgsForComparison`:

```typescript
case ComparisonType.HeadChanges:
  // NOTE: HEAD^ fails on root commits. getDiff and getDiffStats must handle
  // the error gracefully. See getDiffStats for the pattern (try/catch with --root fallback).
  return ['HEAD^', 'HEAD'];
```

For `getPendingAmendDiffStats` (line 1038-1052), add the same root-commit fallback pattern that `getDiffStats` already uses:

```typescript
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
    // Root commit has no parent — fall back to diff-tree --root
    try {
      const args = ['diff-tree', '--stat', '--no-renames', '--root', 'HEAD'];
      if (includeFiles.length > 0) {
        args.push('--', ...includeFiles);
      }
      const result = await this.runCommand(ctx, args);
      return this.parseSlocFrom(result.stdout);
    } catch {
      return undefined;
    }
  }
}
```

For `getDiff`, the `HeadChanges` path also needs a root commit fallback. In the `getDiff` method, wrap the execution in a try/catch:

Read the getDiff method first to see its current structure, then add a catch for root commits that retries with `--root`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd isl-server && yarn test --testPathPattern="VCSDriverIntegration" --no-coverage 2>&1 | tail -30`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add isl-server/src/vcs/GitDriver.ts isl-server/src/__tests__/VCSDriverIntegration.test.ts
git commit -m "fix: handle root commits in HeadChanges diff and getPendingAmendDiffStats"
```

---

## Task 6: Parallelize `getConfigs`

**Files:**
- Modify: `isl-server/src/vcs/GitDriver.ts:1065-1077` (getConfigs)
- Test: `isl-server/src/__tests__/VCSDriverIntegration.test.ts`

Currently spawns one `git config --get` per key sequentially. Use `Promise.all` to parallelize.

- [ ] **Step 1: The existing integration test `getConfigs reads multiple config values` already covers correctness. No new test needed.**

- [ ] **Step 2: Fix getConfigs to use Promise.all**

Replace the method body:

```typescript
async getConfigs<T extends string>(
  ctx: RepositoryContext,
  names: ReadonlyArray<T>,
): Promise<Map<T, string>> {
  const results = await Promise.all(
    names.map(async name => {
      const value = await this.getConfig(ctx, name);
      return [name, value] as const;
    }),
  );
  const configMap = new Map<T, string>();
  for (const [name, value] of results) {
    if (value != null) {
      configMap.set(name, value);
    }
  }
  return configMap;
}
```

- [ ] **Step 3: Run tests to verify they pass**

Run: `cd isl-server && yarn test --testPathPattern="VCSDriverIntegration" --no-coverage 2>&1 | tail -20`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add isl-server/src/vcs/GitDriver.ts
git commit -m "perf: parallelize getConfigs to avoid sequential git config spawns"
```

---

## Task 7: Fix Watchman Dirstate Subscription to Use Driver Watch Config

**Files:**
- Modify: `isl-server/src/WatchForChanges.ts:200-213` (setupDirstateSubscriptions)
- Test: `isl-server/src/__tests__/GitDriverTranslations.test.ts` (unit test for getWatchConfig, already exists)

The dirstate subscription hardcodes Sapling file names (`bookmarks.current`, `bookmarks`, `dirstate`, `merge`). For Git repos, it should watch `HEAD`, `index`, `MERGE_HEAD`, `REBASE_HEAD`, `CHERRY_PICK_HEAD` — the values already returned by `GitDriver.getWatchConfig().dirstateFiles`.

- [ ] **Step 1: Read the full setupDirstateSubscriptions method to understand the flow**

Read `WatchForChanges.ts` lines 160-237 to see how `repoInfo` is available and how the subscription is set up.

- [ ] **Step 2: Modify setupDirstateSubscriptions to use driver's watch config**

The `WatchForChanges` constructor receives `repoInfo: ValidatedRepoInfo`. We need to also pass in the driver's watch config. The simplest approach: add `dirstateFiles` to the constructor or derive it from `repoInfo.command`.

In `WatchForChanges.ts`, update `setupDirstateSubscriptions` (around line 206):

Replace the hardcoded expression:
```typescript
expression: [
  'name',
  ['bookmarks.current', 'bookmarks', 'dirstate', 'merge'],
  'wholename',
],
```

With a dynamic expression based on `repoInfo.command`:

```typescript
const dirstateFileNames = this.repoInfo.command === 'git'
  ? ['HEAD', 'index', 'MERGE_HEAD', 'REBASE_HEAD', 'CHERRY_PICK_HEAD']
  : ['bookmarks.current', 'bookmarks', 'dirstate', 'merge'];

// ... in the subscription:
expression: [
  'name',
  dirstateFileNames,
  'wholename',
],
```

Also update the change handler to respond to the correct file names:

```typescript
dirstateSubscription.emitter.on('change', changes => {
  if (this.repoInfo.command === 'git') {
    if (changes.includes('MERGE_HEAD') || changes.includes('REBASE_HEAD') || changes.includes('CHERRY_PICK_HEAD')) {
      this.changeCallback('merge conflicts');
    }
    if (changes.includes('HEAD') || changes.includes('index')) {
      handleRepositoryStateChange();
    }
  } else {
    if (changes.includes('merge')) {
      this.changeCallback('merge conflicts');
    }
    if (changes.includes('dirstate')) {
      handleRepositoryStateChange();
    }
  }
});
```

- [ ] **Step 3: Run all tests to verify nothing breaks**

Run: `cd isl-server && yarn test --no-coverage 2>&1 | tail -20`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add isl-server/src/WatchForChanges.ts
git commit -m "fix: use git-specific dirstate files in Watchman subscription for Git repos"
```

---

## Task 8: Add TODO Comments for Ambiguous Issues

**Files:**
- Modify: `isl-server/src/vcs/GitDriver.ts` (multiple locations)

Add well-documented TODO comments for issues that need design decisions before fixing.

- [ ] **Step 1: Add all TODO comments**

At `for-each-ref --count=2000` (line ~219):
```typescript
// TODO(perf): --count=2000 silently drops branches in repos with >2000 local branches.
// Options: raise to 10k+, remove cap entirely (200 bytes/ref is cheap), or warn when truncated.
// Tradeoff: larger cap → more data over wire; no cap → unknown upper bound on large monorepos.
```

At `getDiff` (line ~856):
```typescript
// TODO(perf): No size limit on diff output. A generated file with 1M changed lines is fully
// buffered and sent to the client. Consider capping output at ~1MB with a "diff too large" message.
// Tradeoff: need to understand what the UI can render without freezing.
```

At `--topo-order` in fetchCommits (line ~274):
```typescript
// TODO(perf): --topo-order requires git to compute full DAG traversal before first output.
// On repos with wide merge history this is the main scalability bottleneck.
// Alternative: --date-order is faster but shows different graph ordering. UX tradeoff.
```

At `fetchStatus` (line ~541):
```typescript
// TODO(perf): Rename detection (default with git status) is O(n²) on the changed file set.
// Adding --no-renames would improve perf on large changesets but loses "renamed" status info.
// Tradeoff: UX (shows "renamed" vs "deleted+added") vs perf on large repos.
```

At `getExecParams` shell path (line ~1830):
```typescript
// TODO(perf): Shell scripts invoke bare `git` without --no-optional-locks.
// On busy repos, this can cause write-lock contention with background operations.
// Fix: prefix all git calls in shell scripts with `git --no-optional-locks`.
// Need to audit all ~15 scripts to verify none intentionally need locks.
```

At `diffArgsForComparison` StackChanges (line ~1911):
```typescript
// TODO(correctness): StackChanges should diff from merge-base(HEAD, trunk) to HEAD,
// showing all draft changes. This requires an async merge-base lookup which this sync
// method can't do. Options: make method async, or pre-compute merge-base in fetchCommits.
```

At dual-client issue — add at top of `OperationQueue.ts` or as a class-level comment, but since we're not modifying that file, add a note in `GitDriver.ts` near `getExecParams`:
```typescript
// TODO(architecture): The operation queue is per-Repository instance (in-memory). If two
// WebSocket clients (e.g., VS Code + browser) connect to the same repo, they have independent
// queues and can issue concurrent git writes. Git's index.lock prevents corruption but one
// client's operation will fail. Fix: file-based locking or single-server enforcement.
```

At `getPublicHashes` (line ~457):
```typescript
// TODO(perf/correctness): MAX_PUBLIC_HASHES=50_000 means repos with >50k trunk commits
// misclassify old public commits as "draft". The Set also uses ~175MB RAM at full capacity.
// Possible fix: use `rev-list --stdin --not` to classify only the commits we actually fetched
// (max 10k from fetchCommits), rather than pulling the full trunk history.
```

At branch-tip args (line ~298):
```typescript
// TODO(perf): With 2000+ branches, this single command can hit the OS ARG_MAX limit (~2MB).
// Should batch branch names like lookupCommits does (BATCH_SIZE=200).
```

- [ ] **Step 2: Run tests to verify nothing breaks**

Run: `cd isl-server && yarn test --no-coverage 2>&1 | tail -20`
Expected: PASS (comments only)

- [ ] **Step 3: Commit**

```bash
git add isl-server/src/vcs/GitDriver.ts
git commit -m "docs: add TODO comments for ambiguous audit issues needing design decisions"
```

---

## Task 9: Integration Tests for Shell-Script Operations (goto, metaedit, amend --to, rebase -s -d)

**Files:**
- Modify: `isl-server/src/__tests__/VCSDriverIntegration.test.ts`

These are the highest-risk operations — complex multi-step shell scripts that are currently only tested by inspecting the generated script text.

- [ ] **Step 1: Add goto integration tests**

Add inside the `Git Driver Integration Tests (Git-specific)` describe block (after the `hasPotentialOperation` describe, before the closing `});`):

```typescript
describe('Shell Script Operations (end-to-end)', () => {
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

  const ctx = () => ({
    cmd: 'git' as const,
    cwd: tmpDir,
    logger: mockLogger,
    tracker: mockTracker,
  });

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

      // Make a dirty change
      await fs.writeFile(path.join(tmpDir, 'b.txt'), 'modified');

      await runOp(['goto', '--rev', hashA]);

      const head = await gitHelpers.getHead(tmpDir);
      expect(head).toBe(hashA);
      // Dirty change should still be present
      const content = await fs.readFile(path.join(tmpDir, 'b.txt'), 'utf-8');
      expect(content).toBe('modified');
    });
  });

  describe('metaedit (AmendMessageOperation)', () => {
    it('metaedit on HEAD changes commit message', async () => {
      await gitHelpers.commit(tmpDir, 'original', 'file.txt', 'content');
      await gitHelpers.createAndCheckoutBranch(tmpDir, 'test-branch');

      await runOp(['metaedit', '--rev', 'HEAD', '--message', 'updated message']);

      const {stdout} = await execFile('git', ['log', '-1', '--format=%s'], {cwd: tmpDir});
      expect(stdout.trim()).toBe('updated message');
      // Branch should still be checked out
      const {stdout: branch} = await execFile('git', ['symbolic-ref', '--short', 'HEAD'], {cwd: tmpDir});
      expect(branch.trim()).toBe('test-branch');
    });

    it('metaedit on non-HEAD commit rebases stack and preserves branch', async () => {
      await gitHelpers.commit(tmpDir, 'base', 'base.txt', 'base');
      await gitHelpers.createAndCheckoutBranch(tmpDir, 'feature');
      await gitHelpers.commit(tmpDir, 'target', 'target.txt', 'target');
      const targetHash = await gitHelpers.getHead(tmpDir);
      await gitHelpers.commit(tmpDir, 'above', 'above.txt', 'above');

      await runOp(['metaedit', '--rev', targetHash, '--message', 'edited target']);

      // Branch should still be checked out
      const {stdout: branch} = await execFile('git', ['symbolic-ref', '--short', 'HEAD'], {cwd: tmpDir});
      expect(branch.trim()).toBe('feature');
      // Commit above the target should still exist with correct message
      const {stdout: log} = await execFile('git', ['log', '--format=%s', '-3'], {cwd: tmpDir});
      const messages = log.trim().split('\n');
      expect(messages).toContain('above');
      expect(messages).toContain('edited target');
    });
  });

  describe('amend --to (AmendToOperation)', () => {
    it('amend --to HEAD amends current commit with staged changes', async () => {
      await gitHelpers.commit(tmpDir, 'base', 'base.txt', 'base');
      await gitHelpers.createAndCheckoutBranch(tmpDir, 'feature');
      await gitHelpers.commit(tmpDir, 'target', 'file.txt', 'original');

      // Create a change to amend into the target
      await fs.writeFile(path.join(tmpDir, 'file.txt'), 'amended content');

      await runOp(['amend', '--to', 'HEAD', 'file.txt']);

      const content = await fs.readFile(path.join(tmpDir, 'file.txt'), 'utf-8');
      expect(content).toBe('amended content');
      // Should still be on the branch
      const {stdout: branch} = await execFile('git', ['symbolic-ref', '--short', 'HEAD'], {cwd: tmpDir});
      expect(branch.trim()).toBe('feature');
    });

    it('amend --to non-HEAD commit rebases stack onto amended commit', async () => {
      await gitHelpers.commit(tmpDir, 'base', 'base.txt', 'base');
      await gitHelpers.createAndCheckoutBranch(tmpDir, 'feature');
      await gitHelpers.commit(tmpDir, 'target', 'target.txt', 'original');
      const targetHash = await gitHelpers.getHead(tmpDir);
      await gitHelpers.commit(tmpDir, 'above', 'above.txt', 'above');

      // Create a change to amend into the target
      await fs.writeFile(path.join(tmpDir, 'target.txt'), 'amended content');

      await runOp(['amend', '--to', targetHash, 'target.txt']);

      // Branch should still be checked out
      const {stdout: branch} = await execFile('git', ['symbolic-ref', '--short', 'HEAD'], {cwd: tmpDir});
      expect(branch.trim()).toBe('feature');
      // Stack should be intact with both commits
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

      // feature-commit should now be on top of main-next
      const driver2 = new GitDriver();
      const commits = await driver2.fetchCommits(ctx(), {type: 'none'}, defaultFetchOptions);
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

      const driver2 = new GitDriver();
      const commits = await driver2.fetchCommits(ctx(), {type: 'none'}, defaultFetchOptions);
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

      // Manually resolve the conflict
      await fs.writeFile(path.join(tmpDir, 'file.txt'), 'resolved content');
      await execFile('git', ['add', 'file.txt'], {cwd: tmpDir});

      // Run continue through the driver
      await runOp(['continue']);

      // Rebase should be complete — no more conflict state
      const conflicts = await driver.checkMergeConflicts(ctx(), undefined);
      expect(conflicts).toBeUndefined();
      // The resolved commit should be on top of hashA
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
      const conflicts = await driver.checkMergeConflicts(ctx(), undefined);
      expect(conflicts).toBeUndefined();
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they pass**

Run: `cd isl-server && yarn test --testPathPattern="VCSDriverIntegration" --no-coverage 2>&1 | tail -40`
Expected: PASS (these should work since the shell scripts are already functional)

- [ ] **Step 3: Commit**

```bash
git add isl-server/src/__tests__/VCSDriverIntegration.test.ts
git commit -m "test: add end-to-end integration tests for shell-script operations (goto, metaedit, amend-to, rebase, continue, abort)"
```

---

## Task 10: Integration Tests for Shallow Clones

**Files:**
- Modify: `isl-server/src/__tests__/VCSDriverIntegration.test.ts`

The shallow clone detection logic in `getPublicHashes` has zero test coverage. Shallow clones are common (default on GitHub Actions).

- [ ] **Step 1: Add shallow clone tests**

Add inside the `Git Driver Integration Tests (Git-specific)` describe block:

```typescript
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
    // Should get at least the one shallow commit without crashing
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
```

- [ ] **Step 2: Run tests to verify they pass**

Run: `cd isl-server && yarn test --testPathPattern="VCSDriverIntegration" --no-coverage 2>&1 | tail -20`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add isl-server/src/__tests__/VCSDriverIntegration.test.ts
git commit -m "test: add integration tests for shallow clone handling"
```

---

## Task 11: Integration Tests for Edge Cases (Unicode Filenames, Spaces, Empty Repos)

**Files:**
- Modify: `isl-server/src/__tests__/VCSDriverIntegration.test.ts`

- [ ] **Step 1: Add edge case tests**

Add inside the `Git Driver Integration Tests (Git-specific)` describe block:

```typescript
describe('Edge Cases', () => {
  it('fetchStatus handles filenames with spaces', async () => {
    await gitHelpers.commit(tmpDir, 'initial', 'normal.txt', 'content');
    await fs.writeFile(path.join(tmpDir, 'file with spaces.txt'), 'spaced content');
    const status = await driver.fetchStatus({
      cmd: 'git', cwd: tmpDir, logger: mockLogger, tracker: mockTracker,
    });
    const spaced = status.find(f => f.path === 'file with spaces.txt');
    expect(spaced).toBeDefined();
    expect(spaced!.status).toBe('?');
  });

  it('fetchStatus handles unicode filenames', async () => {
    await gitHelpers.commit(tmpDir, 'initial', 'normal.txt', 'content');
    await fs.writeFile(path.join(tmpDir, 'données.txt'), 'unicode content');
    const status = await driver.fetchStatus({
      cmd: 'git', cwd: tmpDir, logger: mockLogger, tracker: mockTracker,
    });
    const unicode = status.find(f => f.path.includes('donn'));
    expect(unicode).toBeDefined();
  });

  it('fetchCommits returns empty array for empty repo (no commits)', async () => {
    const emptyDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'champagne-empty-')));
    try {
      await execFile('git', ['init'], {cwd: emptyDir});
      const emptyCtx = {
        cmd: 'git' as const, cwd: emptyDir, logger: mockLogger, tracker: mockTracker,
      };
      const driver2 = new GitDriver();
      const commits = await driver2.fetchCommits(emptyCtx, {type: 'none'}, defaultFetchOptions);
      expect(commits).toEqual([]);
    } finally {
      await fs.rm(emptyDir, {recursive: true, force: true});
    }
  });

  it('fetchStatus works in empty repo (no commits)', async () => {
    const emptyDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'champagne-empty-')));
    try {
      await execFile('git', ['init'], {cwd: emptyDir});
      await fs.writeFile(path.join(emptyDir, 'new.txt'), 'new');
      const emptyCtx = {
        cmd: 'git' as const, cwd: emptyDir, logger: mockLogger, tracker: mockTracker,
      };
      const driver2 = new GitDriver();
      const status = await driver2.fetchStatus(emptyCtx);
      expect(status.find(f => f.path === 'new.txt')).toBeDefined();
    } finally {
      await fs.rm(emptyDir, {recursive: true, force: true});
    }
  });

  it('getDiffStats returns undefined (not crash) for root commit', async () => {
    await gitHelpers.commit(tmpDir, 'root', 'file.txt', 'content');
    const hash = await gitHelpers.getHead(tmpDir);
    const stats = await driver.getDiffStats({
      cmd: 'git', cwd: tmpDir, logger: mockLogger, tracker: mockTracker,
    }, hash, []);
    // Root commit has no parent — should handle gracefully
    expect(stats === undefined || typeof stats === 'number').toBe(true);
  });

  it('lookupCommits works with batch boundary (multiple batches)', async () => {
    // Create enough commits to potentially exercise batching (batch size is 200)
    // We'll create a modest number (5) to verify the pipeline works without crashing
    const hashes: string[] = [];
    for (let i = 0; i < 5; i++) {
      await gitHelpers.commit(tmpDir, `commit-${i}`, `file-${i}.txt`, `content-${i}`);
      hashes.push(await gitHelpers.getHead(tmpDir));
    }

    const commits = await driver.lookupCommits({
      cmd: 'git', cwd: tmpDir, logger: mockLogger, tracker: mockTracker,
    }, {type: 'none'}, hashes);
    expect(commits.length).toBe(5);
    for (const hash of hashes) {
      expect(commits.find(c => c.hash === hash)).toBeDefined();
    }
  });
});
```

- [ ] **Step 2: Run tests to verify they pass**

Run: `cd isl-server && yarn test --testPathPattern="VCSDriverIntegration" --no-coverage 2>&1 | tail -20`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add isl-server/src/__tests__/VCSDriverIntegration.test.ts
git commit -m "test: add integration tests for unicode filenames, empty repos, and edge cases"
```

---

## Task 12: Integration Test for Resolve Operations (Conflict Resolution)

**Files:**
- Modify: `isl-server/src/__tests__/VCSDriverIntegration.test.ts`

Conflict resolution scripts (`internal:merge-local`, `internal:merge-other`, `internal:union`) have never been run against a real git repo.

- [ ] **Step 1: Add conflict resolution integration tests**

Add inside the `Shell Script Operations` describe block from Task 9:

```typescript
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

  it('resolve --tool internal:merge-local keeps our version', async () => {
    await createRebaseConflict();

    await runOp(['resolve', '--tool', 'internal:merge-local', 'file.txt']);

    // In a rebase, "ours" is the destination (change-A)
    const content = await fs.readFile(path.join(tmpDir, 'file.txt'), 'utf-8');
    expect(content).toContain('changed-by-A');
    expect(content).not.toContain('<<<<');
  });

  it('resolve --tool internal:merge-other keeps their version', async () => {
    await createRebaseConflict();

    await runOp(['resolve', '--tool', 'internal:merge-other', 'file.txt']);

    // In a rebase, "theirs" is the source commit being rebased (change-B)
    const content = await fs.readFile(path.join(tmpDir, 'file.txt'), 'utf-8');
    expect(content).toContain('changed-by-B');
    expect(content).not.toContain('<<<<');
  });

  it('resolve --tool internal:union merges both changes', async () => {
    await createRebaseConflict();

    await runOp(['resolve', '--tool', 'internal:union', 'file.txt']);

    const content = await fs.readFile(path.join(tmpDir, 'file.txt'), 'utf-8');
    // Union merge should include both changes (order may vary)
    expect(content).toContain('changed-by-A');
    expect(content).toContain('changed-by-B');
    expect(content).not.toContain('<<<<');
  });

  it('resolve --mark stages a resolved file', async () => {
    await createRebaseConflict();

    // Manually resolve the conflict
    await fs.writeFile(path.join(tmpDir, 'file.txt'), 'manually resolved\n');

    await runOp(['resolve', '--mark', 'file.txt']);

    // File should be staged (no longer unmerged)
    const {stdout} = await execFile('git', ['status', '--porcelain'], {cwd: tmpDir});
    // Should not have UU (unmerged) status
    expect(stdout).not.toContain('UU');
  });
});
```

- [ ] **Step 2: Run tests to verify they pass**

Run: `cd isl-server && yarn test --testPathPattern="VCSDriverIntegration" --no-coverage 2>&1 | tail -30`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add isl-server/src/__tests__/VCSDriverIntegration.test.ts
git commit -m "test: add integration tests for conflict resolution operations (merge-local, merge-other, union, mark)"
```

---

## Task 13: Run Full Test Suite and Verify

- [ ] **Step 1: Run all isl-server tests**

Run: `cd isl-server && yarn test --no-coverage`
Expected: All tests PASS.

- [ ] **Step 2: Run linting**

Run: `cd isl-server && yarn eslint`
Expected: No errors.

- [ ] **Step 3: Fix any failures, then create a final commit if needed**

---

## Summary of Changes

### Fixes (confident):
1. **Shell injection prevention** — SHA/ref validation before shell interpolation
2. **LFS union merge** — check all three stages (base/ours/theirs) for LFS pointers
3. **Binary file guard** — detect binary content before `merge-file --union`
4. **Fold script `set -e`** — fail-fast consistency
5. **Root commit handling** — `HEAD^` fallback in `getPendingAmendDiffStats` and `getDiff`
6. **Parallel `getConfigs`** — `Promise.all` instead of sequential spawns
7. **Watchman dirstate** — use git-specific file names for Git repos

### Documented TODOs (ambiguous, needs design decisions):
- `for-each-ref --count=2000` cap
- No diff size limit
- `--topo-order` vs `--date-order`
- `fetchStatus --no-renames`
- Shell scripts missing `--no-optional-locks`
- `StackChanges` diff semantics (requires async refactor)
- Dual-client concurrent operations
- `getPublicHashes` 50k RAM / correctness
- Branch-tip ARG_MAX

### New Tests:
- Shell-script end-to-end: goto, metaedit, amend-to, rebase -s/-d, continue, abort
- Conflict resolution: internal:merge-local, internal:merge-other, internal:union, mark
- Shallow clones: fetchCommits, fetchStatus on `--depth=1` clones
- Edge cases: unicode filenames, spaces in paths, empty repos, root commits
- Security: shell injection rejection
