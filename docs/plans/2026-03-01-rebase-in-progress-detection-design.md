# Rebase-in-Progress Detection for Git Driver

**Date:** 2026-03-01
**Status:** Approved

## Problem

When a git rebase leaves behind `.git/rebase-merge` (e.g. from a failed `amend --to`), the ISL frontend does not detect the in-progress state and keeps all operations enabled. This allows the user to trigger another rebase, which fails with:

```
fatal: It seems that there is already a rebase-merge directory
```

## Root Cause

`Repository.checkForMergeConflicts()` has a Sapling-specific fast path that short-circuits before calling `driver.checkMergeConflicts()`:

```typescript
// Always returns early for git — .git/merge never exists
const mergeDirExists = await exists(path.join(this.info.dotdir, 'merge'));
if (!mergeDirExists) return;
```

`GitDriver.checkMergeConflicts()` already correctly checks for `.git/rebase-merge`, `.git/rebase-apply`, `.git/MERGE_HEAD`, and `.git/CHERRY_PICK_HEAD` — it is simply never called.

## Solution: Approach A

Three changes, in order of dependency:

### 1. Add `hasPotentialOperation` to the `VCSDriver` interface

```typescript
/** Fast check: are there signs a merge/rebase/cherry-pick might be in progress? */
hasPotentialOperation(dotdir: string): Promise<boolean>;
```

**SaplingDriver** (preserves existing behavior):
```typescript
return exists(path.join(dotdir, 'merge'));
```

**GitDriver:**
```typescript
return (
  exists(path.join(dotdir, 'rebase-merge')) ||
  exists(path.join(dotdir, 'rebase-apply')) ||
  exists(path.join(dotdir, 'MERGE_HEAD'))   ||
  exists(path.join(dotdir, 'CHERRY_PICK_HEAD'))
);
```

### 2. Fix the fast path in `Repository.checkForMergeConflicts()`

Replace:
```typescript
const mergeDirExists = await exists(path.join(this.info.dotdir, 'merge'));
```
With:
```typescript
const mergeDirExists = await this.driver.hasPotentialOperation(this.info.dotdir);
```

### 3. Auto-continue a rebase with no conflicts

Immediately after calling `driver.checkMergeConflicts()`, if this is **first detection** and the rebase has zero conflicting files, automatically run `git rebase --continue`:

```typescript
if (
  !wasAlreadyInConflicts &&
  this.mergeConflicts?.state === 'loaded' &&
  this.mergeConflicts.files.length === 0 &&
  this.mergeConflicts.command === 'rebase'
) {
  try {
    await this.driver.runCommand(ctx, ['rebase', '--continue']);
    this.mergeConflicts = undefined; // success: clear state silently
  } catch {
    // failed: fall through and surface Abort UI to user
  }
}
```

- Only triggers on first detection (`!wasAlreadyInConflicts`) — not on every poll
- Only for `command === 'rebase'` — merges and cherry-picks are not auto-continued
- On failure the user sees the existing Abort UI, which is the correct fallback

## Error Handling

- If `hasPotentialOperation` throws, treat as `false` (no regression)
- `serializeAsyncCall` wrapping prevents race conditions from concurrent file-change events
- Merge and cherry-pick in-progress states are detected and shown to the user as before

## Testing

**Unit tests:**
- `GitDriver.hasPotentialOperation`: returns `true` when each of the four sentinel paths exists, `false` when none exist
- `Repository.checkForMergeConflicts`: auto-continue path — mock rebase conflict with zero files, verify `rebase --continue` is called and state clears; mock `--continue` failure, verify conflict state is emitted to client

**Manual tests (required before declaring victory):**
1. Trigger a real rebase conflict via `amend --to` on a commit with conflicting changes — verify ISL shows the merge conflict UI with conflicting files and Continue/Abort buttons
2. Leave a stale `.git/rebase-merge` with no conflicts (simulate by starting a rebase and manually removing the conflict markers) — verify ISL silently auto-continues and returns to normal state
3. Leave a stale `.git/rebase-merge` where `git rebase --continue` fails — verify ISL shows the Abort button
4. Normal Sapling workflow — verify no regression in Sapling conflict detection
