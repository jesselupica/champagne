# Git Driver Gap Report

**Date**: 2026-02-28
**Driver file**: `isl-server/src/vcs/GitDriver.ts`
**Spec**: `docs/vcs-semantic-spec.md`

Audit of which operations in the semantic spec are correctly implemented, broken, or missing in the current Git driver. No fixes applied yet.

---

## Summary

| Category | Count |
|---|---|
| Crashes (throws or produces invalid command) | 4 |
| Silent wrong behavior (runs but wrong outcome) | 5 |
| Missing translations (pass-through to git, git fails) | 4 |
| Explicitly disabled via capabilities | 2 |
| Data fetch stub | 1 |
| **Total gaps** | **16** |

---

## Critical Bugs — Crashes or Invalid Commands

### 1. `AbortMergeOperation` crashes

**Operation sends**: `sl rebase --abort` or `sl rebase --quit`

**What happens**: Both hit the `rebase` switch case (`GitDriver.ts` ~line 1094). The case looks for `-s`/`--source` and `-d`/`--dest`. Neither is present, so it throws:
```
Error: rebase requires -s and -d
```

**Spec says**: Detect which operation is in progress via `.git/REBASE_MERGE`, `.git/MERGE_HEAD`, `.git/CHERRY_PICK_HEAD`, then call the appropriate `git <op> --abort`.

---

### 2. `BulkRebaseOperation` crashes

**Operation sends**: `sl rebase --rev <src1> --rev <src2> -d <dest>`

**What happens**: The rebase case looks for `-s`. It never finds it (the flag is `--rev`, not `-s`). Throws:
```
Error: rebase requires -s and -d
```

**Spec says**: Move each listed commit independently to the destination — translate to `git checkout <dest> && git cherry-pick <rev1> <rev2>`.

---

### 3. `RebaseAllDraftCommitsOperation` produces an invalid git command

**Operation sends**: `sl rebase -s 'draft()' -d <dest>` or `sl rebase -s 'draft()&date(-7)' -d <dest>`

**What happens**: The rebase case finds `-s` = `"draft()"` and `-d` = `<hash>`. Produces:
```
git rebase --onto <hash> draft()^ draft()
```
`draft()` is a Sapling revset — not a valid git ref. Git fails.

**Spec says**: `draft()` ≈ commits not on any remote tracking branch. Translate to a shell command using `git merge-base HEAD origin/HEAD` to find the local-only range, then `git rebase --onto <dest> $BASE HEAD`.

---

### 4. `FoldOperation` squashes too many commits for non-HEAD folds

**Operation sends**: `sl fold --exact <bottomHash>::<topHash> --message <msg>`

**What happens** (`translateFoldToGit`, ~line 1149): Sets `GIT_SEQUENCE_EDITOR` to `perl -i -pe 's/^pick/squash/ if $. > 1'` and runs `git rebase -i <bottomHash>^`.

`git rebase -i <bottomHash>^` presents all commits from `bottomHash` through **HEAD** (not through `topHash`). The perl script squashes every commit after the first into one. If the stack is `A-B-C-D` and the fold is `B::C`, the result squashes `B, C, D` into one commit — wrong. Only `B::C` should be merged; `D` should remain a separate child.

**Spec says**: Squash only the `bottom::top` range. All commits above `topHash` should be rebased onto the new folded commit unchanged.

---

## Silent Wrong Behavior — Runs But Produces the Wrong Outcome

### 5. `AmendMessageOperation` on non-HEAD commits silently amends HEAD

**Operation sends**: `sl metaedit --rev <any-hash> --message <msg>`

**What happens** (~line 1014): The `--rev <hash>` argument is explicitly dropped:
```typescript
if (args[i] === '--rev') { i++; continue; }
```
Always produces `git commit --amend --message <msg>` against HEAD, regardless of which commit was targeted.

**Spec says**: For non-HEAD commits, chain: `git checkout <hash>` → `git commit --amend` → `git rebase --onto <new> <old> <original-tip>` → restore branch pointer.

---

### 6. `ContinueOperation` always runs `git rebase --continue`

**Operation sends**: `sl continue`

**What happens** (~line 1067): Hard-coded to `['rebase', '--continue']`.

If the conflict was caused by `git merge`, `git rebase --continue` will fail or do nothing. The correct command would be `git commit --no-edit`. If caused by `git cherry-pick`, it should be `git cherry-pick --continue`.

**Spec says**: Detect in-progress operation by checking `.git/REBASE_MERGE`, `.git/MERGE_HEAD`, `.git/CHERRY_PICK_HEAD`, then call the matching `--continue` variant.

---

### 7. `PullOperation` (plain, no `--rev`) passes through as `git pull`

**Operation sends**: `sl pull`

**What happens**: No case in the switch handles `pull` without `--rev`. It passes through to git unchanged: `git pull`, which does a fetch **plus merge** into the current branch.

**Spec says**: Pull should be fetch-only — `git fetch --all`. It must not merge or rebase into the working directory.

---

### 8. `HideOperation` does not hide descendant commits

**Operation sends**: `sl hide --rev <hash>`

**What happens** (`translateHideToGit`, ~line 1213): Uses:
```bash
git for-each-ref --points-at <hash> refs/heads/
```
`--points-at` finds only refs pointing **exactly** at the given hash. Branches on commits that are **children** of the hidden commit are not found and not deleted. Those descendant commits remain visible in the graph.

**Spec says**: The specified commit **and all its draft descendants** should disappear from the graph. Use `git branch --contains <hash>` to find branches that include the hidden commit anywhere in their ancestry, then delete them all.

---

### 9. `RebaseKeepOperation` ignores the destination, cherry-picks at HEAD

**Operation sends**: `sl rebase --keep --rev <src> --dest <dest>`

**What happens** (~line 1097): The `--dest` argument is not parsed at all. Produces `git cherry-pick <src>`, which applies to wherever HEAD currently is — not at `<dest>`.

**Spec says**: First `git checkout <dest>`, then `git cherry-pick <src>`, so the copy lands as a child of `dest`.

---

## Missing Translations — Pass Through to Git and Fail

### 10. `AmendToOperation` passes through unchanged

**Operation sends**: `sl amend --to <commit> [files...]`

**What happens**: No case in the switch. Passes to git as-is: `git amend --to ...` — git has no such command, fails immediately.

**Spec says**: Chain: `git stash push -- <files>` → `git checkout <target>` → `git stash pop` → `git add <files>` → `git commit --amend --no-edit` → `git rebase --onto <new-target> <old-target> <original-tip>` → restore branch.

---

### 11. `ResolveOperation` with `--tool` variants passes through unchanged

**Operation sends**:
- `sl resolve --tool internal:merge-local <file>` (keep ours)
- `sl resolve --tool internal:merge-other <file>` (keep theirs)
- `sl resolve --tool internal:union <file>` (keep both)

**What happens**: The `resolve` case only handles `--mark` and `--unmark`. All `--tool` variants pass through: `git resolve --tool internal:merge-local ...` — git has no `resolve` command, fails.

**Spec says**:
- `merge-local` → `git checkout --ours -- <file> && git add <file>`
- `merge-other` → `git checkout --theirs -- <file> && git add <file>`
- `union` → `git merge-file --union` with the three index stages (`:1:`, `:2:`, `:3:`)

---

### 12. `ResolveInExternalMergeToolOperation` passes through unchanged

**Operation sends**: `sl resolve --tool <external-tool> --skip [--all | <file>]`

**What happens**: Hits the `resolve` case, doesn't match `--mark` or `--unmark`, falls through. Passes to git as `git resolve --tool vimdiff --skip ...` — fails.

**Spec says**: Translate to `git mergetool --tool=<tool> [<file>]`.

---

### 13. `RunMergeDriversOperation` passes through unchanged

**Operation sends**: `sl resolve --all`

**What happens**: Hits the `resolve` case, no `--mark`/`--unmark`, falls through. Passes to git as `git resolve --all` — fails.

**Spec says**: Translate to `git mergetool` (run on all unresolved files).

---

## Explicitly Disabled via Capabilities

### 14. `PartialCommitOperation` — capability off

`capabilities.partialCommit = false`. The UI hides the partial commit feature. The spec describes a viable Git implementation via `git stash` + `git apply --index` (selected patch) + `git commit` + `git stash pop`. Not yet implemented.

### 15. `PartialAmendOperation` — capability off

`capabilities.partialAmend = false`. Same pattern as above but for amend. Not yet implemented.

---

## Data Fetch Gaps

### 16. `getBlame()` is an unimplemented stub

**Location**: `GitDriver.ts` ~line 622

**What happens**: Returns an empty object. Comment reads `// TODO: Implement git blame`.

**Spec says**: Run `git blame --porcelain <hash> -- <file>` and parse the per-line output to return `{lineContent, commit}[]`. The porcelain format provides one header block per unique commit (hash, author, date, summary) followed by line content, allowing full attribution per line.

---

## Non-Gaps (Correctly Implemented)

For completeness, these operations are correctly translated:

| Operation | Translation | Status |
|---|---|---|
| `CommitOperation` | strips `--addremove` | ✓ |
| `AmendOperation` | `commit --amend`, `--user`→`--author` | ✓ |
| `AmendMessageOperation` (HEAD only) | `commit --amend` | ✓ (HEAD only) |
| `GotoOperation` (`--clean`) | `checkout -- <files>` | ✓ |
| `GotoOperation` (clean WD) | `checkout <hash>` | ✓ (fails if WD dirty) |
| `RevertOperation` | `checkout <hash> -- <files>` | ✓ |
| `AddRemoveOperation` | `add -A` or `add -- <files>` | ✓ |
| `ForgetOperation` | `rm --cached <file>` | ✓ |
| `FoldOperation` (HEAD fold) | `rebase -i` with squash | ✓ |
| `HideOperation` (exact hash branches) | shell `branch -D` | ✓ (descendants missing) |
| `PullRevOperation` | `fetch origin <hash>` | ✓ |
| `BookmarkCreateOperation` | `branch <name> <hash>` | ✓ |
| `BookmarkDeleteOperation` | `branch -d <name>` | ✓ |
| `ShelveOperation` | `stash push [-u] [-m] [-- files]` | ✓ |
| `UnshelveOperation` | `stash apply` / `stash pop` | ✓ |
| `DeleteShelveOperation` | `stash drop` | ✓ |
| `RebaseOperation` (linear) | `rebase --onto dest src^ src` | ✓ |
| `RebaseKeepOperation` (no dest) | `cherry-pick <src>` | ✓ (dest ignored) |
| `GraftOperation` | `cherry-pick <hash>` | ✓ |
| `UncommitOperation` | `reset --soft HEAD~1` | ✓ |
| `ResolveOperation` (`--mark`) | `add <file>` | ✓ |
| `ResolveOperation` (`--unmark`) | `rm --cached <file>` | ✓ |
| `PurgeOperation` | shell `rm -f <files>` | ✓ |
| `PushOperation` | `push <remote> <rev>:<branch>` | ✓ |
| `fetchCommits` | full implementation | ✓ |
| `fetchStatus` | `git status --porcelain=v2` | ✓ |
| `checkMergeConflicts` | detects rebase/merge/cherry-pick | ✓ |
| `getFileContents` | `git show <hash>:<path>` | ✓ |
| `getDiff` | `git diff` variants | ✓ |
| `getChangedFiles` | `git diff-tree` | ✓ |
| `getShelvedChanges` | `git stash list` | ✓ |
| `getDiffStats` | `git diff --stat` | ✓ |
| `getConfig` / `setConfig` | `git config` | ✓ |
| `lookupCommits` | `git cat-file --batch` | ✓ |
