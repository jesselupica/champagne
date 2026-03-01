# ISL VCS Semantic Specification

**Version**: 1.0
**Date**: 2026-02-28
**Ground Truth**: Sapling SCM

## Purpose

This document defines the **behavioral contract** for every operation and data-fetch in the ISL (Interactive Smartlog) UI. It describes what each action *does* to the repository — in terms of working directory state, commit graph, and named references — using Sapling as the reference implementation.

Use this document to implement a VCS driver for any system that supports single-developer feature branches. For each operation, find the semantic description, then map that description to your VCS's native commands.

---

## Concepts

Before reading the operation descriptions, understand these terms as used throughout:

### Commit Graph (DAG)
The directed acyclic graph of all commits in the repository. Each commit has a unique hash, one or more parents, and metadata (author, date, message). The graph is immutable for **public** commits; **draft** commits can be rewritten.

### Current Commit ("dot")
The commit whose snapshot is reflected in the working directory. All tracked files at this commit plus any uncommitted changes = what you see on disk. Exactly one commit is "dot" at any time. Sapling calls this `.`; Git calls this `HEAD`.

### Draft vs. Public Commits
- **Draft**: Commits that exist only locally and have not been pushed to a shared remote. Rewritable (amend, rebase, hide).
- **Public**: Commits that exist on a remote server or have been pushed. Immutable — the UI does not allow rewriting them.

### Working Directory
The set of files on disk that differ from the current commit. Tracked by the VCS as a set of changes with per-file status codes:
- `M` = Modified (tracked file changed)
- `A` = Added (new file being tracked)
- `R` = Removed (tracked file deleted)
- `?` = Untracked (file exists on disk, VCS doesn't know about it)
- `!` = Missing (tracked file deleted from disk without `rm` command)
- `C` = Clean (tracked, unchanged — typically not shown)

### Bookmarks / Branches
Named, movable pointers to specific commits. In Sapling these are called **bookmarks**; in Git they are **branches**. They serve the same purpose: human-readable names for commits. In Sapling, bookmarks automatically advance when you amend or rebase the commit they point to. In Git, branches do not auto-advance.

### Shelved Changes
A saved snapshot of working directory changes, stored separately from the commit graph. Sapling calls these **shelves** (named); Git calls them **stash entries** (stack-based). A shelve stores the changes and removes them from the working directory until restored.

### Revset
An expression that identifies one or more commits. Sapling has a rich revset language (e.g., `draft()`, `ancestors(.)`, `::HEAD`). For other VCS drivers, a revset may be a branch name, a hash, `HEAD~1`, or a Git range.

### Merge/Rebase Conflict State
When an operation (rebase, cherry-pick, merge) encounters incompatible changes, the VCS pauses and marks files as conflicted. The UI detects this state and shows a conflict resolution panel. The operation is "in progress" until the user either **continues** (after resolving) or **aborts**.

---

## Data Model

### CommitInfo
Every commit in the smartlog must provide:

| Field | Type | Description |
|---|---|---|
| `hash` | string | Unique commit identifier |
| `title` | string | First line of commit message |
| `description` | string | Full commit message |
| `author` | string | Author name + email |
| `date` | Date | Commit timestamp |
| `parents` | Hash[] | Parent commit hashes (1 normally, 2 for merges) |
| `isDot` | boolean | True if this is the current commit |
| `bookmarks` | string[] | Local bookmark/branch names pointing here |
| `remoteBookmarks` | string[] | Remote branch names pointing here |
| `phase` | 'public' \| 'draft' | Whether this commit is rewritable |
| `isHead` | boolean | True if this is a branch tip (no children in smartlog) |
| `closestPredecessors` | Hash[] | For mutation-tracked VCS: what this commit replaced |

### UncommittedChanges
An array of file change entries, each with:
| Field | Type | Description |
|---|---|---|
| `path` | RepoRelativePath | File path relative to repo root |
| `status` | 'M' \| 'A' \| 'R' \| '?' \| '!' | Change type |
| `copy` | RepoRelativePath? | Original path if file was copied/renamed |

### MergeConflicts
When a conflict is in progress:
| Field | Type | Description |
|---|---|---|
| `state` | 'loading' \| 'loaded' | Whether conflict data has been fetched |
| `files` | ConflictFile[] | List of conflicted files with resolution status |
| `command` | string? | What command caused the conflict |
| `toContinue` | string? | Command to continue (e.g., `rebase --continue`) |
| `toAbort` | string? | Command to abort (e.g., `rebase --abort`) |

---

## Operations

Operations are initiated by the user via the UI. Each operation is executed by running a VCS command (or sequence of commands) on the server. The operation may succeed, fail, or pause in a conflict state.

After every operation completes, the UI refreshes: (1) uncommitted changes, (2) the commit graph, and (3) merge conflict state.

---

## Commit Operations

### CommitOperation

**Intent**: Package the current working directory changes into a new commit and add it to the graph as a child of the current commit.

**Parameters**:
- `message` (string): The commit message
- `filesPathsToCommit` (path[], optional): If provided, only commit changes to these specific files. If omitted, commit all tracked changes (M, A, R, !).

**Preconditions**:
- There must be at least one uncommitted change to commit (tracked changed files)
- No merge/rebase operation must be in progress

**Effects**:
- **Commit graph**: A new commit node is created as a child of the current commit. The new commit contains the snapshot of the specified files (or all changed files).
- **Working directory**: Files included in the commit are removed from the uncommitted changes list (status returns to clean). Files not included remain in the working directory unchanged.
- **Current commit (dot)**: Advances to the newly created commit.
- **Bookmarks**: Any bookmark pointing to the previous current commit does NOT automatically advance (the new commit has no bookmark by default).

**Sapling reference**: `sl commit --addremove --message <msg> [files...]`

**Behavioral notes**:
- Sapling's `--addremove` automatically stages untracked (`?`) files as Added and marks missing (`!`) files as Removed before committing. A Git driver must handle this explicitly by running `git add` / `git rm` before committing.
- If specific files are listed, only those files participate in the commit. The remaining changes stay in the working directory.
- The new commit's hash is not known until after execution (the client uses an optimistic fake hash during the operation).

---

### PartialCommitOperation

**Intent**: Create a new commit containing only specific selected lines/hunks from the working directory, leaving the remaining changes in place.

**Parameters**:
- `message` (string): Commit message
- `selection` (PartialSelection): The specific hunks and lines to include
- `allFiles` (path[]): All files that have changes

**Preconditions**:
- The VCS driver must support partial staging (`capabilities.partialCommit`)
- At least one hunk must be selected

**Effects**:
- **Commit graph**: A new commit is created containing only the selected hunks.
- **Working directory**: The selected hunks are removed. Non-selected hunks of the same files remain in the working directory.
- **Current commit (dot)**: Advances to the new commit.

**Sapling reference**: `sl debugimportstack` (via stdin with JSON ImportStack)

**Behavioral notes**:
- Sapling implements this via its internal `debugimportstack` API, which takes a JSON description of the exact file contents for the new commit. A Git driver implements this by constructing the index manually:
  1. `git stash push` — save all current WD changes
  2. `git stash show -p stash@{0} | git apply --index` — apply only the selected patch to the index
  3. `git commit -m <msg>` — commit what's in the index
  4. `git stash pop` — restore the remaining (non-selected) changes
  Alternatively, write the selected patch to a temp file and use `git apply --index <patchfile>` before committing.
- This is the most complex operation to port; its behavior must be precisely: commit exactly the selected diff, no more, no less.

---

### CreateEmptyInitialCommitOperation

**Intent**: Create an empty initial commit in a repository that has no commits yet (bootstrap a new repo with a history entry).

**Parameters**: None

**Preconditions**:
- Repository has no commits (empty repo)

**Effects**:
- **Commit graph**: One commit node is created with no parent, an empty tree, and message "Initial Commit".
- **Working directory**: Unchanged — all existing files remain untracked.
- **Current commit (dot)**: Set to the newly created empty commit.

**Sapling reference**: `sl commit --config ui.allowemptycommit=true --message 'Initial Commit'`

**Behavioral notes**:
- Git equivalent: `git commit --allow-empty --message 'Initial Commit'`
- In Sapling, empty commits are blocked by default; the `allowemptycommit` config override is required.

---

## Amend Operations

### AmendOperation

**Intent**: Modify the current commit to incorporate additional working directory changes. The existing commit is replaced with a new version that includes the new changes.

**Parameters**:
- `filePathsToAmend` (path[], optional): Specific files to incorporate. If omitted, incorporates all tracked changes.
- `message` (string, optional): New commit message. If omitted, keeps the existing message.
- `author` (string, optional): New author string. If omitted, keeps the existing author.

**Preconditions**:
- The current commit must be a draft commit (not public/immutable)
- No merge/rebase operation must be in progress

**Effects**:
- **Commit graph**: The current commit is **replaced** with a new commit node. The new commit has the same parents as the old one. The old commit is made obsolete (it may become hidden in mutation-tracking VCS). If the amended commit had children (a "stack"), those children's parents now point to the new commit (auto-restack, if configured).
- **Working directory**: Files incorporated in the amend are removed from uncommitted changes.
- **Current commit (dot)**: Updates to the new amended commit hash.
- **Bookmarks**: Any bookmark pointing to the old commit is updated to point to the new commit.

**Sapling reference**: `sl amend --addremove [files...] [--message <msg>] [--user <author>] [--config amend.autorestack=...]`

**Behavioral notes**:
- `amend.autorestack=true` (Sapling config): After amending, Sapling automatically rebases any child commits onto the new amended commit. Without auto-restack, children remain pointing to the obsolete old commit and appear as "orphaned" in the graph.
- Git's `git commit --amend` only works when HEAD is the current commit. The Champagne architecture always sends amend to the working directory parent, which should always be HEAD in a Git repo (except in detached HEAD state during conflicts).
- Sapling's `--addremove` must be translated to explicit `git add`/`git rm` calls before `git commit --amend`.

---

### PartialAmendOperation

**Intent**: Incorporate only selected hunks/lines from the working directory into the current commit. Non-selected changes remain in the working directory.

**Parameters**:
- `message` (string | undefined): New commit message (keep existing if omitted)
- `originalHeadHash` (Hash): Current commit hash before amend
- `selection` (PartialSelection): Selected hunks/lines to incorporate
- `allFiles` (path[]): All files with changes

**Preconditions**: Same as AmendOperation, plus `capabilities.partialAmend` must be true.

**Effects**:
- **Commit graph**: Current commit is replaced with a new commit that includes the selected hunks added to its existing content.
- **Working directory**: Only the selected hunks are removed from the working directory.

**Sapling reference**: `sl debugimportstack` (via stdin)

**Behavioral notes**:
- Git implementation via chaining:
  1. `git stash push` — save all current WD changes
  2. Apply only the selected patch to the index: write the selected diff to a temp file, then `git apply --index <patchfile>`
  3. `git commit --amend --no-edit` — fold the selected changes into the current commit
  4. `git stash pop` — restore the remaining (non-selected) changes to the working directory

---

### AmendMessageOperation

**Intent**: Change the commit message (and optionally author) of any draft commit, without changing the commit's file content.

**Parameters**:
- `revset` (Revset): Target commit to modify
- `message` (string): New commit message
- `author` (string, optional): New author

**Preconditions**:
- Target commit must be draft

**Effects**:
- **Commit graph**: The specified commit is replaced with a new commit that has identical file content but a different message/author. All descendants are rebased onto the new commit (their content is unchanged, but their parent hash changes).
- **Working directory**: Unchanged.

**Sapling reference**: `sl metaedit --rev <revset> --message <msg> [--user <author>]`

**Behavioral notes**:
- In Sapling, `metaedit` works on any draft commit in the graph — not just HEAD. Git requires a multi-step sequence for non-HEAD commits.
- For HEAD: `git commit --amend --only --message <msg> [--author <author>]`
- For non-HEAD commits, chain:
  1. `git checkout <target-hash>` — detach HEAD to the target commit
  2. `git commit --amend --only --message <msg> [--author <author>]` — amend the message in place
  3. `NEW_HASH=$(git rev-parse HEAD)` — capture the new hash
  4. `git rebase --onto $NEW_HASH <target-hash> <original-branch-tip>` — replay all commits that were after the target onto the new amended commit
  5. `git checkout <branch-name>` — restore the branch pointer to the rebased tip
- All commits above the amended commit get new hashes (their parent changed), but their content is preserved exactly.

---

### AmendToOperation

**Intent**: Take working directory changes and fold them into a *specific* non-HEAD draft commit (not the current commit). This is "absorb" functionality — changes are sucked into an earlier commit.

**Parameters**:
- `commit` (Revset): Target commit (anywhere in the draft stack)
- `filePathsToAmend` (path[], optional): Specific files to absorb

**Preconditions**:
- Target commit must be draft
- Target commit is not necessarily the current commit
- Any commits between the target and the current commit will be rebased to accommodate the change

**Effects**:
- **Commit graph**: The target commit gains the new file content. All commits between the target and HEAD are rebased (their content is unchanged, but their parent hashes change because the base changed).
- **Working directory**: The absorbed files are removed from uncommitted changes.

**Sapling reference**: `sl amend --to <commit> [files...]`

**Behavioral notes**:
- Git implementation via chained commands:
  1. `git stash push -- <files>` — save the WD changes to absorb
  2. `git checkout <target-hash>` — detach HEAD to the target commit
  3. `git stash pop` — apply the saved changes onto the target
  4. `git add <files>` — stage the applied changes
  5. `git commit --amend --no-edit` — fold them into the target commit
  6. `NEW_TARGET=$(git rev-parse HEAD)` — capture the new hash
  7. `git rebase --onto $NEW_TARGET <target-hash> <original-branch-tip>` — replay all commits that were above the target
  8. `git checkout <branch-name>` — restore the branch pointer
- If step 3 produces conflicts (the stash changes conflict with the target commit's context), the operation pauses for manual resolution before continuing.

---

## Navigation Operations

### GotoOperation

**Intent**: Move the working directory to a different commit — the equivalent of "checking out" a commit.

**Parameters**:
- `destination` (Revset): Target commit

**Preconditions**:
- The working directory must not have uncommitted tracked changes (or the VCS must support carrying changes forward — Sapling does, Git does not by default)
- No merge/rebase in progress

**Effects**:
- **Working directory**: All tracked files are updated to match the target commit's snapshot. Any files added in the old commit but not in the new commit become untracked (`?`) or are deleted.
- **Commit graph**: The graph itself does not change.
- **Current commit (dot)**: Changes to the target commit.
- **File status**: All previously clean files remain clean. Uncommitted changes are carried along if the VCS supports it (Sapling does; Git requires `git stash` first or uses `git checkout` which fails if there are changes).

**Sapling reference**: `sl goto --rev <destination>`

**Behavioral notes**:
- Sapling carries uncommitted changes to the new commit if there are no conflicts. To replicate this in Git:
  1. `git stash push` — save uncommitted changes
  2. `git checkout <destination>` — switch to the target
  3. `git stash pop` — reapply the changes (may produce conflicts if the new base is incompatible)
  If stash pop produces conflicts, the operation pauses in conflict state; the user must resolve and `git stash drop` manually.
- When navigating to a public commit in Git, HEAD becomes detached. This is expected — the UI shows the detached state and the user can navigate normally.
- If the destination is a branch name, use `git checkout <branch>` (not detached) to preserve the branch association.
- If there are no uncommitted changes, use `git checkout <destination>` directly with no stash needed.

---

## Rebase Operations

### RebaseOperation

**Intent**: Move a commit *and all of its descendants* to a new parent commit. The commit's content is unchanged; only its position in the graph changes.

**Parameters**:
- `source` (Revset): The commit to rebase (the "root" of the subtree to move)
- `destination` (Revset): The new parent commit

**Preconditions**:
- Source commit must be draft
- Destination must not be a descendant of source (no cycles)

**Effects**:
- **Commit graph**: The source commit and all of its draft descendants are detached from their current position and re-attached under the destination. New commit nodes are created (different hashes) with the same changes but new parents. The old nodes become obsolete.
- **Working directory**: If the current commit (dot) was in the rebased subtree, dot advances to the new version of that commit. Uncommitted changes are carried forward.
- **File status**: Unchanged, except files may now differ from the new base (if conflicts occur, the operation pauses in conflict state).

**Sapling reference**: `sl rebase -s <source> -d <destination>`

**Behavioral notes**:
- `-s` (source) in Sapling: rebase the commit AND all its descendants. This differs from Git's default `git rebase`, which only reapplies commits from a branch tip.
- Git implementation:
  1. Find the tip of the stack rooted at `source`: walk the commit graph forward from source, collecting all descendants. For a linear stack this is the last commit in the chain.
  2. `git rebase --onto <destination> <source>^ <tip-of-stack>` — replay source through tip onto destination
  3. Update any branch pointers that were on the old commits to point to the rebased equivalents: `git branch -f <branch> <new-hash>`
- For a single commit with no children: `git rebase --onto <destination> <source>^ <source>` (or `git cherry-pick <source>` after checking out destination).
- When multiple branches diverge from the source (a "diamond" shape), each branch tip must be rebased separately in sequence:
  1. `git rebase --onto <destination> <source>^ <branch1-tip>`
  2. `git rebase --onto <destination> <source>^ <branch2-tip>`
  Then update branch refs accordingly.
- If the rebase results in conflicts, the operation pauses. The user must resolve conflicts and then use ContinueOperation or AbortMergeOperation.

---

### BulkRebaseOperation

**Intent**: Move multiple specific commits (not their descendants) to the same new parent. Each commit is rebased independently.

**Parameters**:
- `sources` (Revset[]): List of commits to rebase
- `destination` (Revset): New parent for all source commits

**Preconditions**: All source commits must be draft.

**Effects**:
- **Commit graph**: Each source commit is moved individually to have `destination` as its parent. Their descendants (if any) are rebased onto the new versions.
- Note: if sources are currently in a stack (linear chain), after bulk rebase they form parallel branches off `destination`.

**Sapling reference**: `sl rebase --rev <src1> --rev <src2> ... -d <destination>`

**Behavioral notes**:
- `--rev` in Sapling (unlike `-s`) rebases only the specified commit(s), not their descendants. Descendants of each commit are rebased to follow the newly moved commit.
- Git implementation (for N source commits):
  1. For each `src` in `sources` (in topological order, parents first):
     - `git rebase --onto <destination> <src>^ <src>` — move just this commit
     - `NEW_SRC=$(git rev-parse HEAD)` — record the new hash
     - For each child of `src`: `git rebase --onto $NEW_SRC <src> <child-tip>` — rebase the children onto the new position
  2. Update all affected branch refs.
- If sources are currently independent (not in a linear chain), each can be rebased independently as cherry-picks: `git checkout <destination>; git cherry-pick <src1> <src2> ...`

---

### RebaseAllDraftCommitsOperation

**Intent**: Move all draft commits (with optional date filter) to a new base, effectively rebasing your entire local work onto a new upstream.

**Parameters**:
- `timeRangeDays` (number | undefined): Only rebase draft commits newer than N days
- `destination` (Revset): New parent

**Preconditions**: There must be at least one draft commit.

**Effects**:
- **Commit graph**: All draft commits within the time range are moved to be descendants of `destination`. The relative order of draft commits is preserved.

**Sapling reference**: `sl rebase -s 'draft()' -d <destination>` or `sl rebase -s 'draft()&date(-N)' -d <destination>`

**Behavioral notes**:
- The Sapling revset `draft()` maps to "commits not yet on any remote tracking branch." Git implementation:
  1. Find the common ancestor: `BASE=$(git merge-base HEAD origin/HEAD)` (or whichever remote tracking branch is the upstream)
  2. Optionally apply the date filter: find commits newer than N days since `$BASE`
  3. `git rebase --onto <destination> $BASE HEAD` — replay all local commits onto the new base
- If multiple local branches exist (not just a linear stack), each branch tip must be rebased separately:
  1. For each local branch not on the remote: `git rebase --onto <destination> $(git merge-base <branch> origin/HEAD) <branch>`
- After rebasing, any local branch refs must be force-updated to their rebased positions.

---

### RebaseKeepOperation

**Intent**: Copy a commit to a new parent location, **leaving the original commit in place**. This is like cherry-pick — you get a duplicate commit with the same changes at the new location.

**Parameters**:
- `source` (Revset): Commit to copy
- `destination` (Revset): New parent for the copy

**Preconditions**: Source commit should be draft (or accessible).

**Effects**:
- **Commit graph**: A new commit is added as a child of `destination` with the same changes as `source`. The original `source` commit remains unchanged at its current location. Both exist simultaneously.
- **Working directory**: Unchanged unless the operation encounters conflicts.

**Sapling reference**: `sl rebase --keep --rev <source> --dest <destination>`

**Behavioral notes**:
- Direct Git equivalent: `git cherry-pick <source>` (after checking out `destination` first, or using `git cherry-pick` from the destination branch).
- The key distinction from RebaseOperation: the original commit is preserved. The graph gains a new commit rather than moving one.

---

## Fold/Squash Operations

### FoldOperation

**Intent**: Merge a contiguous range of commits in the graph into a single commit. The combined commit has the net changes of all folded commits and a user-specified message.

**Parameters**:
- `foldRange` (CommitInfo[]): The contiguous commits to merge (must form a linear chain)
- `newMessage` (string): The message for the combined commit

**Preconditions**:
- All commits in the range must be draft
- Commits must be contiguous (each is the parent of the next)
- No commit outside the range may be a child of any commit inside the range (except the topmost)

**Effects**:
- **Commit graph**: The range of commits collapses into one commit. The new commit's parent is the parent of the bottommost folded commit. The new commit's child is whatever was the child of the topmost folded commit. The new commit contains the net file changes of all folded commits combined.
- **Current commit (dot)**: If dot was one of the folded commits, it advances to the new combined commit.
- **Bookmarks**: If a bookmark pointed to any folded commit, it moves to the new combined commit.

**Sapling reference**: `sl fold --exact <bottomHash>::<topHash> --message <msg>`

**Behavioral notes**:
- The `bottomHash::topHash` range is a Sapling revset meaning "all commits from bottom to top inclusive."
- Git implementation for a fold at the tip of HEAD (simple case):
  1. `git reset --soft <bottomHash>^` — move HEAD back to just before bottom, keeping all changes staged
  2. `git commit --message <newMessage>` — create one commit with the net changes
- Git implementation for a non-HEAD fold (range is in the middle of a stack):
  1. Record the original tip: `ORIGINAL_TIP=$(git rev-parse <current-branch>)`
  2. `git checkout <topHash>` — detach at the top of the range
  3. `git reset --soft <bottomHash>^` — collapse the range onto the staging area
  4. `git commit --message <newMessage>` — create the folded commit
  5. `FOLD_HASH=$(git rev-parse HEAD)` — record the new commit
  6. `git rebase --onto $FOLD_HASH <topHash> $ORIGINAL_TIP` — replay all commits that were above the fold range
  7. `git checkout <branch-name>` — restore the branch pointer
- The net diff must be preserved exactly — all intermediate states are discarded, only the net changes from the range's start to end are kept.

---

### UncommitOperation

**Intent**: Undo the most recent commit, returning all of its changes to the working directory as uncommitted changes. The commit is removed from the graph.

**Parameters**:
- `originalDotCommit` (CommitInfo): Metadata of the commit being uncommitted

**Preconditions**:
- Current commit must be draft
- No merge/rebase in progress

**Effects**:
- **Commit graph**: The current commit is removed. Its parent becomes the new current commit.
- **Working directory**: All files that were changed in the removed commit appear as uncommitted changes in the working directory (with their appropriate status codes: M, A, R).
- **Current commit (dot)**: Moves back to what was the current commit's parent.
- **Bookmarks**: If a bookmark pointed to the uncommitted commit, it moves to the parent commit.

**Sapling reference**: `sl uncommit`

**Behavioral notes**:
- Git equivalent: `git reset --soft HEAD~1`. This moves HEAD back one commit and keeps all changes staged in the index.
- The key semantic: all changes are preserved and visible, just no longer in a commit. This is the inverse of CommitOperation.
- If the commit had children (it's in the middle of a stack), those children's parent hashes change — they now point to the new uncommitted commit.

---

## Visibility Operations

### HideOperation

**Intent**: Mark a commit as obsolete/hidden so it no longer appears in the commit graph. The commit is not deleted — it is archived and can be recovered.

**Parameters**:
- `source` (Revset): Commit to hide

**Preconditions**:
- Commit must be draft (cannot hide public commits)
- If the current commit (dot) would be hidden, dot moves to the nearest visible ancestor

**Effects**:
- **Commit graph**: The specified commit (and all its draft descendants) disappear from the visible graph. They continue to exist internally but are filtered out of all fetched commit data.
- **Current commit (dot)**: If dot was hidden, it moves to the nearest visible ancestor.
- **Bookmarks**: Any bookmark pointing to a hidden commit is also removed or relocated to the ancestor.

**Sapling reference**: `sl hide --rev <source>`

**Behavioral notes**:
- This is a Sapling-specific concept. Sapling has an "obsstore" (obsolescence store) that records which commits have been replaced or hidden.
- Git Branchless has a native `git hide` command that provides true hiding functionality.
- For a plain Git driver, implement via chained commands:
  1. Find all local branch names pointing to the commit or its descendants: `git branch --contains <hash> --format='%(refname:short)'`
  2. For each such branch: `git branch -D <branch>` — delete it. This severs the only reachable reference to the commit.
  3. If the current HEAD is the hidden commit or one of its descendants: `git checkout <parent-of-hidden>` first, then delete the branches.
  4. The commit becomes unreachable and will be collected by `git gc` / reflog expiry (usually 30–90 days). For immediate cleanup: `git gc --prune=now`.
- Note: unlike Sapling's hide (which is reversible via `sl unhide`), Git's approach is effectively permanent once the reflog expires. A driver could record the hidden hashes in `.git/champagne-hidden` to support a future "unhide" feature.
- Git Branchless drivers should use `git hide <hash>` directly.

---

### DiscardOperation

**Intent**: Discard all uncommitted **tracked** changes in the working directory, restoring all modified/added/removed files to their committed state.

**Parameters**: None

**Preconditions**: No merge/rebase in progress.

**Effects**:
- **Working directory**: All files with status M (modified), A (added/tracked), R (removed), and ! (missing) are restored to their committed state.
  - Modified files revert to the committed version
  - Added files that were previously tracked are removed from tracking (returned to `?` or deleted)
  - Removed files are restored from the commit
  - Missing files are restored from the commit
- **Untracked files (`?`)**: NOT affected — files not tracked by the VCS remain as-is.
- **Commit graph**: Unchanged.

**Sapling reference**: `sl goto --clean .`

**Behavioral notes**:
- Git equivalent: `git checkout -- .` (restores tracked files to HEAD state). Does NOT delete untracked files.
- Sapling's `goto --clean .` navigates to the current commit with the `--clean` flag, which discards all working directory changes.
- This is a destructive operation with no undo — discarded changes cannot be recovered unless they were previously shelved.

---

### PartialDiscardOperation

**Intent**: Discard only the selected hunks/lines from the working directory, keeping the non-selected changes in place.

**Parameters**:
- `selection` (PartialSelection): Hunks/lines to discard (inverse selection — the UI shows which hunks to KEEP)

**Preconditions**: `capabilities.partialCommit` required.

**Effects**:
- **Working directory**: Only the selected hunks are reverted. Non-selected hunks remain.

**Sapling reference**: `sl debugimportstack` (via stdin, write operation with inverse patch)

---

### PurgeOperation

**Intent**: Permanently delete untracked files (`?`) from the working directory.

**Parameters**:
- `files` (path[], optional): Specific files to delete. If empty, deletes ALL untracked files.

**Preconditions**: Files must have status `?` (untracked). Cannot be used on tracked files.

**Effects**:
- **Working directory**: The specified untracked files are deleted from disk.
- **Commit graph**: Unchanged.
- **File status**: Deleted files no longer appear in the uncommitted changes list.

**Sapling reference**: `sl purge --files --abort-on-err [files...]`

**Behavioral notes**:
- Git equivalent: `git clean -f [files...]`. `git clean -fd` also removes untracked directories.
- This operation is destructive and unrecoverable — deleted files cannot be brought back.
- `--abort-on-err` in Sapling stops if any deletion fails (e.g., permission denied). A Git driver should use similar fail-fast behavior.

---

## File Staging Operations

### AddOperation

**Intent**: Begin tracking a specific untracked file. The file's current contents will be included in the next commit.

**Parameters**:
- `filePath` (path): File to start tracking

**Preconditions**: File must exist on disk with status `?` (untracked).

**Effects**:
- **File status**: Changes from `?` (untracked) to `A` (added/staged).
- **Commit graph**: Unchanged.
- **Working directory**: File content unchanged; VCS now knows about it.

**Sapling reference**: `sl add <file>`

**Behavioral notes**:
- Direct equivalent in all VCS: `git add <file>`. In Sapling, after `sl add` the file appears in the next commit automatically. In Git, `git add` stages the file, and `git commit` includes staged files.
- Sapling does not have an explicit staging area (index). All tracked changes are automatically included in the next commit unless you use partial operations.

---

### AddRemoveOperation

**Intent**: Auto-detect and stage both new files and deleted files. Equivalent to running Add on all untracked files and Remove on all missing files.

**Parameters**:
- `paths` (path[], optional): Specific paths to process. If empty, processes all untracked and missing files in the repo.

**Preconditions**: None.

**Effects**:
- **File status**: All `?` files become `A`; all `!` files become `R`.
- **Commit graph**: Unchanged.

**Sapling reference**: `sl addremove [files...]`

**Behavioral notes**:
- Git equivalent: For each untracked file: `git add <file>`; for each missing file: `git rm <file>`. Or: `git add -A` (stages all changes including deletions and new files).
- This is used by CommitOperation and AmendOperation (via `--addremove` flag) to automatically handle files that were added or deleted outside of VCS tracking.

---

### ForgetOperation

**Intent**: Stop tracking a file without deleting it from disk. The file reverts to untracked (`?`) status.

**Parameters**:
- `filePath` (path): File to untrack

**Preconditions**: File must be tracked (status M, A, or C).

**Effects**:
- **File status**: Becomes `?` (untracked). The VCS no longer includes this file in commits.
- **File on disk**: Unchanged — the file remains on disk at its current path.
- **Commit graph**: Unchanged. The file will no longer appear in future commits.

**Sapling reference**: `sl forget <file>`

**Behavioral notes**:
- Git equivalent: `git rm --cached <file>`. This removes from the index but leaves the file on disk.
- The file will appear as untracked in future status checks until explicitly added back.

---

### RmOperation

**Intent**: Remove a tracked file — both stop tracking it AND delete it from disk.

**Parameters**:
- `filePath` (path): File to remove
- `force` (boolean): Remove even if the file has uncommitted modifications

**Preconditions**: File must be tracked.

**Effects**:
- **File on disk**: Deleted.
- **File status**: Removed from the uncommitted changes list (it becomes `R` until committed, then gone entirely).
- **Commit graph**: The next commit will not include this file.

**Sapling reference**: `sl rm [-f] <file>`

**Behavioral notes**:
- Direct Git equivalent: `git rm [-f] <file>`. Behavior is identical.

---

### RevertOperation

**Intent**: Restore specific files to their state at a given revision, discarding any uncommitted changes to those files.

**Parameters**:
- `files` (path[]): Files to revert
- `revset` (Revset, optional): Revision to revert to. If omitted, reverts to the current commit's version.

**Preconditions**: Files must exist at the target revision.

**Effects**:
- **Working directory**: The specified files are overwritten with their content from the target revision.
- **File status**:
  - If reverting to current commit (no revset): File status changes from M/A/R to clean (C) — the uncommitted changes are discarded.
  - If reverting to a specific revision: File status becomes M (modified) relative to the current commit, showing the historical version.
- **Commit graph**: Unchanged.

**Sapling reference**: `sl revert [--rev <revset>] [files...]`

**Behavioral notes**:
- Git equivalent (no revset): `git checkout -- <files>` (restore to HEAD)
- Git equivalent (with revset): `git checkout <rev> -- <files>` (restore to specific revision)

---

## Shelve Operations

### ShelveOperation

**Intent**: Temporarily save uncommitted working directory changes away from the working directory, leaving the working directory clean. The changes can be restored later.

**Parameters**:
- `name` (string, optional): A label for the shelved change
- `filesPathsToCommit` (path[], optional): Specific files to shelve. If omitted, shelves all changes.

**Preconditions**: Must have uncommitted changes to shelve.

**Effects**:
- **Working directory**: The shelved files are restored to their committed state (changes are removed from WD).
- **Shelved changes store**: A new entry is created containing the saved changes, named with the provided name (or auto-named).
- **Commit graph**: Unchanged.

**Sapling reference**: `sl shelve --unknown [--name <name>] [files...]`

**Behavioral notes**:
- `--unknown` in Sapling: also shelves untracked (`?`) files. Git's `git stash push` does NOT include untracked files by default — add `--include-untracked` (`-u`) for equivalent behavior.
- Sapling shelves are **named** and can coexist. Git stash is a **stack** (LIFO) with optional messages but primarily accessed by index. A Git driver must handle the name→index mapping.
- Git equivalent: `git stash push [-u] [-m <name>] [-- <files>]`

---

### UnshelveOperation

**Intent**: Restore shelved changes back into the working directory.

**Parameters**:
- `shelvedChange` (ShelvedChange): The specific shelved change to restore
- `keep` (boolean): If true, keep the shelved change in the store after restoring. If false, remove it.

**Preconditions**:
- The specified shelved change must exist
- Working directory should be compatible (no conflicts with the shelved changes)

**Effects**:
- **Working directory**: The shelved changes are applied. Files that were shelved now have their saved changes back.
- **Shelved changes store**: If `keep=false`, the entry is removed. If `keep=true`, it remains.
- **Commit graph**: Unchanged.

**Sapling reference**: `sl unshelve [--keep] --name <name>`

**Behavioral notes**:
- Git equivalent (keep=false): `git stash pop`
- Git equivalent (keep=true): `git stash apply`
- Since Git stash is stack-based and Sapling shelves are named, a Git driver that stores stashes in order must find the correct stash index for the named entry.

---

### DeleteShelveOperation

**Intent**: Permanently discard a shelved change without restoring it.

**Parameters**:
- `shelvedChange` (ShelvedChange): The shelved change to delete

**Preconditions**: The specified shelved change must exist.

**Effects**:
- **Shelved changes store**: The entry is removed permanently.
- **Working directory**: Unchanged.

**Sapling reference**: `sl shelve --delete <name>`

**Behavioral notes**:
- Git equivalent: `git stash drop <stash-ref>`

---

## Bookmark Operations

### BookmarkCreateOperation

**Intent**: Create a named pointer to a specific commit.

**Parameters**:
- `revset` (Revset): Target commit
- `bookmark` (string): Name for the bookmark/branch

**Preconditions**: The name must not already be in use (or the VCS must allow overwriting).

**Effects**:
- **Named references**: A new bookmark/branch is created pointing to the target commit.
- **Commit graph**: Unchanged. The commit now has an additional label.

**Sapling reference**: `sl bookmark <name> --rev <revset>`

**Behavioral notes**:
- Git equivalent: `git branch <name> <ref>`
- In Sapling, bookmarks automatically advance when the commit they point to is amended or rebased (the bookmark follows the commit through mutations). Git branches do NOT auto-advance — they stay on the original commit hash.
- This behavioral difference means that after amending a commit with a bookmark in Sapling, the bookmark still points to the new commit; in Git the branch stays on the old (now dangling) commit.

---

### BookmarkDeleteOperation

**Intent**: Remove a named pointer from the repository.

**Parameters**:
- `bookmark` (string): Name to delete

**Preconditions**: The named bookmark/branch must exist.

**Effects**:
- **Named references**: The bookmark/branch is removed. The commit it pointed to remains in the graph.
- **Working directory**: Unchanged.

**Sapling reference**: `sl bookmark --delete <name>`

**Behavioral notes**:
- Git equivalent: `git branch -d <name>` (safe delete, fails if unmerged) or `git branch -D <name>` (force delete).
- If the current commit has no other references pointing to it (no bookmark, not on any tracked remote branch), deleting the only bookmark in Git makes the commit "unreachable" and subject to eventual garbage collection.

---

## Remote Operations

### PullOperation

**Intent**: Fetch all new commits from the remote repository, updating the local view of remote branches/bookmarks.

**Parameters**: None

**Preconditions**: Network access to remote.

**Effects**:
- **Commit graph**: New commits from the remote are added. Remote bookmark references are updated to their new positions.
- **Working directory**: Unchanged. Sapling and Git pull/fetch do not merge into the working directory.
- **Local bookmarks**: Unchanged (only remote references update).

**Sapling reference**: `sl pull`

**Behavioral notes**:
- Git equivalent: `git fetch --all` (fetches all remotes, updates remote-tracking branches like `origin/main`).
- Sapling `sl pull` is fetch-only (does not auto-merge). This is analogous to `git fetch`, not `git pull` (which does `fetch + merge`).

---

### PullRevOperation

**Intent**: Fetch a specific commit (by hash or ref) from the remote, even if it's not referenced by any branch.

**Parameters**:
- `rev` (ExactRevset): Specific commit hash to fetch

**Preconditions**: The hash must exist on the remote.

**Effects**:
- **Commit graph**: The specified commit (and its ancestors not already present locally) are added to the local graph.

**Sapling reference**: `sl pull --rev <rev>`

**Behavioral notes**:
- Git equivalent: `git fetch origin <hash>`. Note: most Git hosting services do not allow fetching arbitrary commits by hash unless the server has `uploadpack.allowReachableSHA1InWant` enabled. This may not be universally available.
- This is used to fetch commits referenced in code review systems (e.g., pull a specific PR commit to review locally).

---

### PushOperation

**Intent**: Send local commits to a remote branch.

**Parameters**:
- `topOfStackRev` (Revset): The topmost commit to push (and all its ancestors that aren't already on the remote)
- `toBranchName` (string): Remote branch to push to
- `destination` (string, optional): Remote name (e.g., "origin")

**Preconditions**: Network access to remote. User must have write permissions.

**Effects**:
- **Remote**: The commits up to `topOfStackRev` are uploaded to the remote branch.
- **Remote bookmarks**: The remote branch reference updates to point to `topOfStackRev`.
- **Local commit graph**: The pushed commits may be marked as "public" (Sapling updates phase to public). In Git, remote-tracking refs (e.g., `origin/main`) update.

**Sapling reference**: `sl push --rev <topOfStackRev> --to <toBranchName> [destination]`

**Behavioral notes**:
- Git equivalent: `git push <remote> <localRef>:<toBranchName>`
- In Sapling, `--rev` specifies what to include — all ancestors up to and including that commit are pushed. In Git, `git push` pushes the current branch's history to the target branch.

---

### PrSubmitOperation

**Intent**: Create or update pull requests for the current stack of commits on a code review platform (e.g., GitHub).

**Parameters**:
- `options.draft` (boolean, optional): Submit as draft PR
- `options.updateMessage` (string, optional): Message for the PR update

**Effects**:
- **Remote**: PRs are created or updated on the configured code review platform.
- **Commit graph**: May add remote bookmark references (e.g., the PR branch on GitHub).

**Sapling reference**: `sl pr submit [--draft] [--message <msg>]`

**Behavioral notes**:
- This is code-review-system specific. Git itself has no PR concept — this maps to GitHub CLI (`gh pr create`), Graphite (`gt submit`), or other tooling.
- A Git driver exposes this through `capabilities.submitCommands`, which lists the available submit commands and their CLI arguments.

---

## Merge Conflict Operations

### ContinueOperation

**Intent**: Continue a paused rebase, merge, or cherry-pick after the user has resolved all conflicts.

**Parameters**: None

**Preconditions**:
- A merge/rebase operation must be in progress
- All conflicted files must be marked as resolved

**Effects**:
- **Merge/conflict state**: The interrupted operation resumes and runs to completion (or pauses again if more conflicts arise).
- **Commit graph**: The in-progress operation's commits are finalized (new commits are created with the resolved content).
- **Working directory**: Updated to the next state of the operation.

**Sapling reference**: `sl continue`

**Behavioral notes**:
- Sapling's `sl continue` is a universal "continue" command that detects which operation is in progress and continues it.
- Git implementation — detect which operation is in progress, then run the corresponding continue:
  1. Check `.git/REBASE_MERGE/` or `.git/REBASE_APPLY/` → `git rebase --continue`
  2. Check `.git/MERGE_HEAD` → `git merge --continue`
  3. Check `.git/CHERRY_PICK_HEAD` → `git cherry-pick --continue`
  4. Check `.git/BISECT_LOG` → `git bisect skip` (edge case, not a user-initiated operation)
- Before continuing, verify all conflicted files have been resolved: `git diff --name-only --diff-filter=U` should return empty. If not, the continue command will fail — surface this to the user as "unresolved files remain."

---

### AbortMergeOperation

**Intent**: Cancel an in-progress merge/rebase operation and restore the repository to its state before the operation began.

**Parameters**:
- `conflicts` (MergeConflicts): Current conflict state (determines which abort to run)
- `isPartialAbort` (boolean): If true, "quit" (keep already-applied commits, abandon the rest). If false, fully abort and restore to pre-operation state.

**Preconditions**: A merge/rebase operation must be in progress.

**Effects**:
- **Full abort (`isPartialAbort=false`)**: Repository is fully restored to its pre-operation state. All in-progress commits are removed. Working directory is restored.
- **Partial abort/quit (`isPartialAbort=true`)**: Commits already successfully rebased are kept. The remaining commits (those not yet rebased) are abandoned. Working directory is at the last successfully rebased commit.
- **Merge/conflict state**: Cleared.

**Sapling reference**: `sl rebase --abort` (full) or `sl rebase --quit` (partial)

**Behavioral notes**:
- Git full abort (same detection logic as ContinueOperation):
  1. Check `.git/REBASE_MERGE/` or `.git/REBASE_APPLY/` → `git rebase --abort`
  2. Check `.git/MERGE_HEAD` → `git merge --abort`
  3. Check `.git/CHERRY_PICK_HEAD` → `git cherry-pick --abort`
- Git partial abort (`isPartialAbort=true`, keep already-applied commits): Git has no `--quit` flag. Approximate by:
  1. Read `.git/REBASE_MERGE/rewritten-list` (maps old hashes → new hashes for commits already successfully rebased)
  2. Find the last successfully rebased commit: the last entry's new hash
  3. `git rebase --abort` — fully abort and restore pre-rebase state
  4. `git cherry-pick <new-hash-1> <new-hash-2> ...` — replay only the already-rebased commits onto the restored state
  This gives the same result as Sapling's `--quit`: you keep the portion that was already done and abandon the rest. Note: this requires the rewritten-list file to be readable before aborting.

---

### ResolveOperation

**Intent**: Mark a conflicted file as resolved (or unresolved), or resolve it using a specific merge strategy.

**Parameters**:
- `filePath` (path): File to resolve
- `tool` (ResolveTool): How to resolve:
  - `mark`: Mark the file as resolved (user has manually fixed it)
  - `unmark`: Mark the file as unresolved (revert resolved status)
  - `both`: Accept both sides (union merge)
  - `local`: Accept the local/current version (discard incoming changes)
  - `other`: Accept the incoming/other version (discard local changes)

**Preconditions**: File must be in conflicted state.

**Effects**:
- **Merge conflict state**: The file's resolved status is updated.
- **Working directory**: If using `local`, `other`, or `both`, the file content is rewritten with the resolved content.

**Sapling reference**:
- `sl resolve --mark <file>` (mark resolved)
- `sl resolve --unmark <file>` (mark unresolved)
- `sl resolve --tool internal:union <file>` (both sides)
- `sl resolve --tool internal:merge-local <file>` (keep local)
- `sl resolve --tool internal:merge-other <file>` (keep other)

**Behavioral notes**:
- Git equivalent for `mark` (resolved): `git add <file>`
- Git equivalent for `unmark` (unresolved): `git rm --cached <file>` (removes from index, restoring conflict markers)
- Git equivalent for `local` (keep our side): `git checkout --ours -- <file>; git add <file>`
- Git equivalent for `other` (keep their side): `git checkout --theirs -- <file>; git add <file>`
- Git equivalent for `both` (union — keep all lines from both sides):
  1. Extract the three versions: `git show :1:<file> > base.tmp; git show :2:<file> > ours.tmp; git show :3:<file> > theirs.tmp`
  2. Run a union merge: `git merge-file -p --union ours.tmp base.tmp theirs.tmp > <file>`
  3. `git add <file>`
  4. Clean up temp files.
- In Git, `:1:`, `:2:`, `:3:` are the index stages for base, ours, and theirs respectively during a conflict.

---

### ResolveInExternalMergeToolOperation

**Intent**: Open a conflicted file (or all conflicted files) in the user's configured external merge tool.

**Parameters**:
- `tool` (string): External merge tool name (e.g., "vimdiff", "meld")
- `filePath` (path, optional): Specific file, or all files if omitted

**Preconditions**: Conflict in progress; the specified tool must be installed.

**Effects**:
- **Working directory**: After the merge tool runs, the file contains the resolved content.
- **Merge conflict state**: Not automatically marked resolved — user must explicitly run ResolveOperation after.

**Sapling reference**: `sl resolve --tool <tool> --skip [--all | <file>]`

**Behavioral notes**:
- Git equivalent: `git mergetool --tool=<tool> [<file>]`

---

### RunMergeDriversOperation

**Intent**: Run all configured automatic merge drivers on conflicted files to attempt automatic resolution.

**Parameters**: None

**Preconditions**: Conflict in progress.

**Effects**:
- **Merge conflict state**: Automatically-resolvable files are marked as resolved. Files that cannot be auto-resolved remain conflicted.

**Sapling reference**: `sl resolve --all`

**Behavioral notes**:
- Git equivalent: `git mergetool` (runs the configured merge tool on all unresolved files).

---

## Data Fetching

These are not user-initiated operations but server-side reads that keep the UI state current. Each must be implemented by the VCS driver.

---

### fetchCommits (Smartlog)

**Purpose**: Get the commit DAG to display in the smartlog panel.

**Must include**:
- All draft (local) commits
- The current commit (dot) — marked `isDot: true`
- Public commits that are parents of draft commits (branch points)
- Commits referenced by local bookmarks/branches
- Commits referenced by remote tracking bookmarks
- Stable/pinned commits from `stableLocations`

**Must NOT include**:
- Old public commits with no draft descendants (to keep the graph readable)
- Hidden/obsolete commits

**Output**: Array of `CommitInfo`, topologically sorted (parents before children).

**Sapling reference**: `sl log --template <TEMPLATE> --rev 'smartlog(interestingbookmarks() + heads(draft()) & date(-N)) + . + present(stableLocations)'`

**Git approximation**: `git log --branches --remotes --format=... --graph` filtered to only include local branch tips, their upstream tracking branches, and the working tree HEAD. The graph must be reconstructed by parsing parent hashes.

---

### fetchStatus (Uncommitted Changes)

**Purpose**: Get the current state of the working directory — all files that differ from the current commit.

**Must return**: All files with status M, A, R, ?, !

**Must include**: Copy tracking — if a file was renamed, include the original path in `copy` field.

**Output**: Array of `{path, status, copy?}` entries.

**Sapling reference**: `sl status -Tjson --copies`

**Git equivalent**: `git status --porcelain=v2` (parse R→copy tracking from rename detection).

---

### checkMergeConflicts

**Purpose**: Detect whether a merge/rebase operation is currently in progress with unresolved conflicts.

**Returns**: `MergeConflicts` object if a conflict is active, `undefined` if no conflict.

**MergeConflicts must include**:
- List of all conflicted files with resolution status
- The command that caused the conflict (for display)
- The command to continue
- The command to abort

**Sapling reference**: `sl resolve --tool internal:dumpjson --all`

**Git equivalent**: Check for `.git/MERGE_HEAD` (merge), `.git/REBASE_MERGE/` (rebase), `.git/CHERRY_PICK_HEAD` (cherry-pick). Parse unmerged paths from `git status --porcelain`.

---

### getFileContents

**Purpose**: Retrieve the contents of a file at a specific revision.

**Parameters**:
- `path`: Repository-relative file path
- `revset`: Revision specifier. `"."` means the current commit.

**Returns**: File contents as a UTF-8 string.

**Sapling reference**: `sl cat <path> --rev <revset>`

**Git equivalent**: `git show <rev>:<path>`

---

### getBlame

**Purpose**: Get line-by-line authorship information for a file at a specific revision.

**Parameters**:
- `path`: File path
- `hash`: Commit hash

**Returns**: Array of `{lineContent, commit}` — one entry per line.

**Sapling reference**: `sl blame <file> -Tjson --change --rev <hash>`, then `sl log` for commit details.

**Git equivalent**: `git blame --porcelain <hash> -- <file>` (parse per-line output).

---

### getChangedFiles

**Purpose**: Get the list of files changed in a specific commit.

**Parameters**: `hash` — commit hash

**Returns**: Array of `{path, status, copy?}` entries showing what changed in that commit.

**Sapling reference**: `sl log --template <CHANGED_FILES_TEMPLATE> --rev <hash>`

**Git equivalent**: `git diff-tree --no-commit-id -r --name-status <hash>` or `git show --stat --name-status <hash>`.

---

### getShelvedChanges

**Purpose**: List all currently shelved/stashed changes.

**Returns**: Array of `ShelvedChange` sorted by date (most recent first), each with a name and metadata.

**Sapling reference**: `sl log --rev 'shelved()' --template <SHELVE_TEMPLATE>`

**Git equivalent**: `git stash list --format=...`; each stash becomes a `ShelvedChange`.

---

### getDiff

**Purpose**: Generate a unified diff for a comparison (working directory vs commit, commit vs commit, etc.).

**Parameters**:
- `comparison`: Specifies what to compare (uncommitted vs committed, two commits, etc.)
- `contextLines`: Number of context lines in the diff

**Returns**: Unified diff string.

**Sapling reference**: `sl diff <revset-args> --noprefix --no-binary --nodate --unified <contextLines>`

**Git equivalent**: `git diff [--cached] [<rev>] -- [<path>]`

---

### lookupCommits

**Purpose**: Fetch full `CommitInfo` for a set of commit hashes. Used for blame lookups and on-demand fetching.

**Parameters**: `hashes` — array of commit hashes

**Returns**: `Map<Hash, CommitInfo>`

**Sapling reference**: `sl log --template <MAIN_FETCH_TEMPLATE> --rev <h1>+<h2>+...`

**Git equivalent**: Multiple `git log --format=... -1 <hash>` calls, or a single `git log --format=... <h1> <h2>...`.

---

### getDiffStats

**Purpose**: Get line addition/removal counts for a commit or for pending changes.

**Parameters**:
- `hash` (for committed changes): Commit hash
- `excludePatterns` (optional): File patterns to exclude
- `includePatterns` (for pending): Specific files to include

**Returns**: `{linesAdded, linesRemoved}`

**Sapling reference**: `sl diff --stat -B -X <excluded> -c <hash>`

**Git equivalent**: `git diff --stat <hash>^..<hash>` (committed) or `git diff --stat` (uncommitted).

---

### getConfig / setConfig

**Purpose**: Read and write VCS configuration values.

**Config scopes**:
- `user`: User-level config (`~/.hgrc` or `~/.gitconfig`)
- `local`: Repository-level config (`.sl/hgrc` or `.git/config`)
- `global`: System-level config

**ISL-specific configs** (stored under `champagne.*` namespace in non-Sapling VCS):

| ISL Config Name | Sapling Name | Description |
|---|---|---|
| `ui.merge` | `ui.merge` | Merge tool name |
| `isl.submitAsDraft` | `isl.submitAsDraft` | Submit PRs as drafts |
| `amend.autorestack` | `amend.autorestack` | Auto-rebase children on amend |
| `isl.changedFilesDisplayType` | `isl.changedFilesDisplayType` | How to show changed files |
| `isl.hasShownGettingStarted` | `isl.hasShownGettingStarted` | UI onboarding state |

**Sapling reference**: `sl config <name>` / `sl config --<scope> <name> <value>`

**Git equivalent**: `git config <name>` / `git config --<scope> <name> <value>`. ISL-specific configs that don't exist in Git map to `champagne.*` keys in the Git config.

---

## Operations with No Git Equivalent

The following are genuinely Sapling-specific and cannot be approximated in Git. All others described in this document, including operations that previously appeared complex, can be implemented via chained Git commands as described in each section above.

| Operation | Reason | Capability Flag |
|---|---|---|
| `CommitCloudSyncOperation` | Sapling's proprietary cloud sync service | `capabilities.commitCloud` |
| `CommitCloudChangeWorkspaceOperation` | Same | `capabilities.commitCloud` |
| `CommitCloudCreateWorkspaceOperation` | Same | `capabilities.commitCloud` |

### Previously "No Equivalent" — Now Implementable via Chaining

| Operation | Git Implementation Strategy |
|---|---|
| `PartialCommitOperation` / `PartialAmendOperation` | `git stash` → apply selected patch to index → `git commit` → `git stash pop` |
| `AmendMessageOperation` (non-HEAD) | `git checkout <target>` → `git commit --amend` → `git rebase --onto <new> <old> <tip>` |
| `AmendToOperation` | `git stash push` → `git checkout <target>` → `git stash pop` → `git commit --amend` → `git rebase --onto` |
| `RebaseAllDraftCommitsOperation` | `git merge-base HEAD origin/HEAD` → `git rebase --onto <dest> $BASE HEAD` |
| `FoldOperation` (non-HEAD) | `git checkout <top>` → `git reset --soft <bottom>^` → `git commit` → `git rebase --onto <fold> <top> <tip>` |
| `HideOperation` | Find branches pointing to commit → `git branch -D` each |
| `AbortMergeOperation` (partial) | Read `rewritten-list` → `git rebase --abort` → `git cherry-pick <already-applied-commits>` |
| `ResolveOperation` (local/other/both) | `git checkout --ours/--theirs` or `git merge-file --union` |
| `PullRevOperation` | `git fetch origin <hash>` (server-dependent; may not work on all hosts) |

---

## Summary: Operations by Repo State Change

| Operation | WD Changes? | Graph Changes? | References? |
|---|---|---|---|
| CommitOperation | Removes committed files | New commit added | — |
| AmendOperation | Removes amended files | Replaces current commit | Bookmarks follow |
| AmendMessageOperation | — | Replaces commit + all descendants | Bookmarks follow |
| GotoOperation | Replaces with target snapshot | — | — |
| RebaseOperation | — (dot follows) | Subtree moves | Bookmarks follow |
| FoldOperation | — | Range collapses to 1 | Bookmarks to new |
| UncommitOperation | WD gains commit changes | Current commit removed | Bookmarks to parent |
| HideOperation | dot moves if hidden | Commit hidden | Bookmarks removed |
| DiscardOperation | Tracked changes cleared | — | — |
| PurgeOperation | Untracked files deleted | — | — |
| AddOperation | `?` → `A` | — | — |
| ForgetOperation | Tracked → `?` | — | — |
| ShelveOperation | Changes moved to shelve | — | — |
| UnshelveOperation | Shelved changes restored | — | — |
| BookmarkCreateOperation | — | — | New bookmark |
| BookmarkDeleteOperation | — | — | Bookmark removed |
| PullOperation | — | Remote commits added | Remote refs update |
| PushOperation | — | — | Remote branch updates |
| ContinueOperation | Resolves conflict state | Finalizes in-progress commits | — |
| AbortMergeOperation | Restored to pre-op state | In-progress commits removed | — |
