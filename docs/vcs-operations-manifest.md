# VCS Operations Manifest

This document maps every ISL UI action to its underlying VCS command. Each entry documents the Operation class, the Sapling command it generates, the arguments it accepts, and any behavioral divergences from standard VCS behavior.

**Reference**: See [docs/spec.md](spec.md) for the VCS Driver interface these operations map to.

---

## Table of Contents

1. [Commit Operations](#commit-operations)
2. [Amend Operations](#amend-operations)
3. [Navigation Operations](#navigation-operations)
4. [Rebase Operations](#rebase-operations)
5. [Fold/Squash Operations](#foldsquash-operations)
6. [Visibility Operations](#visibility-operations)
7. [File Staging Operations](#file-staging-operations)
8. [Shelve Operations](#shelve-operations)
9. [Bookmark Operations](#bookmark-operations)
10. [Remote Operations](#remote-operations)
11. [Merge Conflict Operations](#merge-conflict-operations)
12. [Commit Cloud Operations](#commit-cloud-operations)
13. [Stack Operations](#stack-operations)
14. [Configuration Operations](#configuration-operations)
15. [Data Fetching Operations](#data-fetching-operations)

---

## Commit Operations

### CommitOperation

- **Client class**: `CommitOperation` (`isl/src/operations/CommitOperation.ts`)
- **Sapling command**: `sl commit --addremove --message <msg> [files...]`
- **Purpose**: Create a new commit from working directory changes
- **Arguments**:
  - `message` (string, required): Commit message
  - `originalHeadHash` (Hash, required): Current HEAD hash (for optimistic state)
  - `filesPathsToCommit` (RepoRelativePath[], optional): Specific files to commit. If omitted, commits all changes.
- **Divergences**:
  - Uses `--addremove` by default (auto-adds untracked files, auto-removes missing files)
  - Git equivalent would need separate `git add` step
- **Optimistic state**: Creates fake commit with hash `OPTIMISTIC_COMMIT_<base>`, removes committed files from uncommitted changes
- **VCS Driver method**: `resolveOperationArgs()` with args `['commit', '--addremove', '--message', msg, ...files]`

### PartialCommitOperation

- **Client class**: `PartialCommitOperation` (subclass in `CommitOperation.ts`)
- **Sapling command**: `sl debugimportstack` (via stdin)
- **Purpose**: Commit only selected hunks/lines from changed files
- **Arguments**:
  - `message` (string): Commit message
  - `originalHeadHash` (Hash): Current HEAD hash
  - `selection` (PartialSelection): Selected hunks/lines
  - `allFiles` (RepoRelativePath[]): All changed files
- **Stdin**: JSON-serialized `ImportStack` with `['commit', {...}]` action
- **Divergences**: Uses Sapling's `debugimportstack` which has no Git equivalent. Git driver would use `git add --patch` or index manipulation.
- **VCS Driver method**: Requires `capabilities.partialCommit` and `capabilities.stackOperations`

### CreateEmptyInitialCommitOperation

- **Client class**: `CreateEmptyInitialCommitOperation` (`CreateEmptyInitialCommitOperation.ts`)
- **Sapling command**: `sl commit --config ui.allowemptycommit=true --message 'Initial Commit'`
- **Purpose**: Create an empty initial commit in a new repository
- **Arguments**: None
- **Divergences**: Requires `ui.allowemptycommit` config override. Git has `--allow-empty` flag.

---

## Amend Operations

### AmendOperation

- **Client class**: `AmendOperation` (`isl/src/operations/AmendOperation.ts`)
- **Sapling command**: `sl amend --addremove [files...] [--message <msg>] [--user <author>] [--config amend.autorestack=...]`
- **Purpose**: Amend the current commit with working directory changes
- **Arguments**:
  - `filePathsToAmend` (RepoRelativePath[], optional): Specific files to amend
  - `message` (string, optional): New commit message
  - `author` (string, optional): New author string
- **Divergences**:
  - Uses `--addremove` by default
  - Supports `amend.autorestack` config to auto-rebase children
  - Git `--amend` only works on HEAD, Sapling amend works on working directory parent
- **Optimistic state**: Removes amended files from uncommitted changes, updates title/description

### PartialAmendOperation

- **Client class**: `PartialAmendOperation` (subclass in `AmendOperation.ts`)
- **Sapling command**: `sl debugimportstack` (via stdin)
- **Purpose**: Amend only selected hunks/lines into the current commit
- **Arguments**:
  - `message` (string | undefined): New commit message
  - `originalHeadHash` (Hash): Current HEAD hash
  - `selection` (PartialSelection): Selected hunks/lines
  - `allFiles` (RepoRelativePath[]): All changed files
- **Divergences**: Same as PartialCommitOperation - uses `debugimportstack`
- **VCS Driver method**: Requires `capabilities.partialAmend` and `capabilities.stackOperations`

### AmendMessageOperation

- **Client class**: `AmendMessageOperation` (`AmendMessageOperation.ts`)
- **Sapling command**: `sl metaedit --rev <revset> --message <msg> [--user <author>]`
- **Purpose**: Change the commit message (and optionally author) of any commit
- **Arguments**:
  - `revset` (Revset): Target commit
  - `message` (string): New commit message
  - `author` (string, optional): New author
- **Divergences**:
  - Sapling `metaedit` works on any draft commit, not just HEAD
  - Git equivalent for HEAD: `git commit --amend -m <msg>`
  - Git equivalent for non-HEAD: requires interactive rebase
- **Optimistic state**: Updates commit title/description in DAG

### AmendToOperation

- **Client class**: `AmendToOperation` (`AmendToOperation.ts`)
- **Sapling command**: `sl amend --to <commit> [files...]`
- **Purpose**: Move working directory changes into a specific (non-HEAD) commit
- **Arguments**:
  - `commit` (Revset): Target commit to amend into
  - `filePathsToAmend` (RepoRelativePath[], optional): Specific files
- **Divergences**:
  - Sapling-specific command. No direct Git equivalent.
  - Git would require: stash, interactive rebase to target commit, apply changes, continue rebase
- **Optimistic state**: Removes amended files from uncommitted changes

---

## Navigation Operations

### GotoOperation

- **Client class**: `GotoOperation` (`isl/src/operations/GotoOperation.ts`)
- **Sapling command**: `sl goto --rev <destination>`
- **Purpose**: Move the working directory to a different commit
- **Arguments**:
  - `destination` (Revset): Target commit
- **Divergences**:
  - Sapling `goto` = Git `checkout` (for commit navigation)
  - Does not create branches in Sapling; Git may need detached HEAD or branch checkout
- **Optimistic state**: Marks destination as `isDot=true`, marks old location with `GOTO_PREVIOUS_LOCATION` preview

---

## Rebase Operations

### RebaseOperation

- **Client class**: `RebaseOperation` (`isl/src/operations/RebaseOperation.ts`)
- **Sapling command**: `sl rebase -s <source> -d <destination>`
- **Purpose**: Move a commit and its descendants to a new parent
- **Arguments**:
  - `source` (Revset): Commit to rebase (and all descendants)
  - `destination` (Revset): New parent commit
- **Divergences**:
  - Sapling `-s` (source) rebases the commit and all descendants
  - Git equivalent: `git rebase --onto <dest> <source>^ <source-branch>`
- **Optimistic state**: Creates preview commits with `REBASE_PREVIEW` hash prefix, handles partial rebase state
- **Inline progress**: Shows "rebasing..." on source commit

### BulkRebaseOperation

- **Client class**: `BulkRebaseOperation` (`BulkRebaseOperation.ts`)
- **Sapling command**: `sl rebase --rev <src1> --rev <src2> ... -d <destination>`
- **Purpose**: Rebase multiple individual commits to the same destination
- **Arguments**:
  - `sources` (Revset[]): Commits to rebase
  - `destination` (Revset): New parent commit
- **Divergences**:
  - Sapling `--rev` rebases individual commits (not their descendants)
  - Git would require multiple `git cherry-pick` or `git rebase --onto` commands

### RebaseAllDraftCommitsOperation

- **Client class**: `RebaseAllDraftCommitsOperation` (`RebaseAllDraftCommitsOperation.ts`)
- **Sapling command**: `sl rebase -s 'draft()' -d <destination>` or `sl rebase -s 'draft()&date(-N)' -d <destination>`
- **Purpose**: Rebase all draft commits to a new destination
- **Arguments**:
  - `timeRangeDays` (number | undefined): Optional date filter
  - `destination` (Revset): New parent commit
- **Divergences**: Uses Sapling revset language. Git has no equivalent concept of "all draft commits."

### RebaseKeepOperation

- **Client class**: `RebaseKeepOperation` (`RebaseKeepOperation.ts`)
- **Sapling command**: `sl rebase --keep --rev <source> --dest <destination>`
- **Purpose**: Copy a commit to a new parent, leaving the original in place
- **Arguments**:
  - `source` (Revset): Commit to copy
  - `destination` (Revset): New parent commit
- **Divergences**:
  - `--keep` preserves original commit
  - Git equivalent: `git cherry-pick <source>` (after checking out destination)

---

## Fold/Squash Operations

### FoldOperation

- **Client class**: `FoldOperation` (`isl/src/operations/FoldOperation.ts`)
- **Sapling command**: `sl fold --exact <bottomHash>::<topHash> --message <msg>`
- **Purpose**: Combine a contiguous range of commits into one
- **Arguments**:
  - `foldRange` (CommitInfo[]): Commits to fold (must be contiguous)
  - `newMessage` (string): Message for the combined commit
- **Divergences**:
  - Sapling `fold` works on any draft range
  - Git equivalent: interactive rebase with `squash`/`fixup`, or `git reset --soft <base> && git commit`
- **Optimistic state**: Marks commits with `FOLD_PREVIEW`/`FOLD` types, updates children to point to folded commit

### UncommitOperation

- **Client class**: `UncommitOperation` (`isl/src/operations/Uncommit.ts`)
- **Sapling command**: `sl uncommit`
- **Purpose**: Undo the last commit, moving changes back to working directory
- **Arguments**:
  - `originalDotCommit` (CommitInfo): Current HEAD commit info
  - `changedFiles` (ChangedFile[]): Files in the commit being uncommitted
- **Divergences**:
  - Sapling `uncommit` moves HEAD changes to working directory
  - Git equivalent: `git reset --soft HEAD~1`
- **Optimistic state**: If commit has children, moves isDot to parent; otherwise hides commit

---

## Visibility Operations

### HideOperation

- **Client class**: `HideOperation` (`isl/src/operations/HideOperation.ts`)
- **Sapling command**: `sl hide --rev <source>`
- **Purpose**: Mark a commit as obsolete/hidden
- **Arguments**:
  - `source` (Revset): Commit to hide
- **Divergences**:
  - Sapling-specific concept of "hiding" commits (they still exist but are not shown)
  - Git has no equivalent. Closest: delete the branch pointing to the commit
  - Git Branchless has `git hide` support
- **Preview state**: Marks commits with `HIDDEN_ROOT`/`HIDDEN_DESCENDANT` types
- **Optimistic state**: Removes hidden commits from DAG, moves dot to parent if needed

### DiscardOperation

- **Client class**: `DiscardOperation` (`isl/src/operations/DiscardOperation.ts`)
- **Sapling command**: `sl goto --clean .`
- **Purpose**: Discard all uncommitted tracked changes
- **Arguments**: None
- **Divergences**:
  - Only discards tracked changes (M, A, R, !). Leaves untracked files (?) alone.
  - Git equivalent: `git checkout -- .` (does not remove untracked)
- **Optimistic state**: Filters out tracked changes from uncommitted changes

### PartialDiscardOperation

- **Client class**: `PartialDiscardOperation` (subclass in `DiscardOperation.ts`)
- **Sapling command**: `sl debugimportstack` (via stdin)
- **Purpose**: Discard selected hunks/lines from working directory
- **Stdin**: JSON ImportStack with `['write', {...}]` action (inverse of selected changes)
- **Divergences**: Uses `debugimportstack`. Git would use `git checkout --patch` or write file directly.

### PurgeOperation

- **Client class**: `PurgeOperation` (`isl/src/operations/PurgeOperation.ts`)
- **Sapling command**: `sl purge --files --abort-on-err [files...]`
- **Purpose**: Delete untracked files from working directory
- **Arguments**:
  - `files` (RepoRelativePath[]): Specific files to purge. If empty, purges all untracked files.
- **Divergences**:
  - Sapling `purge` = Git `clean`
  - Git equivalent: `git clean -f [files...]`
- **Optimistic state**: Removes purged files from uncommitted changes

---

## File Staging Operations

### AddOperation

- **Client class**: `AddOperation` (`isl/src/operations/AddOperation.ts`)
- **Sapling command**: `sl add <file>`
- **Purpose**: Start tracking an untracked file
- **Arguments**:
  - `filePath` (RepoRelativePath): File to add
- **Divergences**: Direct equivalent across all VCS
- **Optimistic state**: Changes file status from `?` to `A`

### AddRemoveOperation

- **Client class**: `AddRemoveOperation` (`isl/src/operations/AddRemoveOperation.ts`)
- **Sapling command**: `sl addremove [files...]`
- **Purpose**: Auto-detect and stage new files and removed files
- **Arguments**:
  - `paths` (RepoRelativePath[]): Specific paths. If empty, operates on all untracked/missing files.
- **Divergences**:
  - Combined add+remove in one command
  - Git equivalent: `git add <new-files> && git rm <missing-files>`
- **Optimistic state**: Converts `?` to `A`, `!` to `R`

### ForgetOperation

- **Client class**: `ForgetOperation` (`isl/src/operations/ForgetOperation.ts`)
- **Sapling command**: `sl forget <file>`
- **Purpose**: Stop tracking a file without deleting it
- **Arguments**:
  - `filePath` (RepoRelativePath): File to forget
- **Divergences**:
  - Git equivalent: `git rm --cached <file>`
- **Optimistic state**: Changes file status to `?`

### RmOperation

- **Client class**: `RmOperation` (`isl/src/operations/RmOperation.ts`)
- **Sapling command**: `sl rm [-f] <file>`
- **Purpose**: Remove a tracked file
- **Arguments**:
  - `filePath` (RepoRelativePath): File to remove
  - `force` (boolean): Force removal even if modified
- **Divergences**: Direct equivalent: `git rm [-f] <file>`

### RevertOperation

- **Client class**: `RevertOperation` (`isl/src/operations/RevertOperation.ts`)
- **Sapling command**: `sl revert [--rev <revset>] [files...]`
- **Purpose**: Revert files to their state at a given revision
- **Arguments**:
  - `files` (RepoRelativePath[]): Files to revert
  - `revset` (Revset, optional): Revision to revert to. If omitted, reverts to working directory parent.
- **Divergences**:
  - Git equivalent (no revset): `git checkout -- <files>`
  - Git equivalent (with revset): `git checkout <rev> -- <files>`
- **Optimistic state**: Removes reverted files from uncommitted changes (if no revset); marks as 'M' (if reverting to specific commit)

---

## Shelve Operations

### ShelveOperation

- **Client class**: `ShelveOperation` (`isl/src/operations/ShelveOperation.ts`)
- **Sapling command**: `sl shelve --unknown [--name <name>] [files...]`
- **Purpose**: Temporarily store uncommitted changes
- **Arguments**:
  - `name` (string, optional): Name for the shelved change
  - `filesPathsToCommit` (RepoRelativePath[], optional): Specific files to shelve
- **Divergences**:
  - `--unknown` includes untracked files
  - Git equivalent: `git stash push [-m <name>] [-- <files>]`
  - Git stash doesn't include untracked by default (needs `--include-untracked`)
- **Optimistic state**: Removes shelved files from uncommitted changes

### UnshelveOperation

- **Client class**: `UnshelveOperation` (`isl/src/operations/UnshelveOperation.ts`)
- **Sapling command**: `sl unshelve [--keep] --name <name>`
- **Purpose**: Restore shelved changes to working directory
- **Arguments**:
  - `shelvedChange` (ShelvedChange): The shelved change to restore
  - `keep` (boolean): Keep the shelved change after restoring
- **Divergences**:
  - Named shelves vs Git's stack-based stash
  - Git equivalent: `git stash apply <ref>` (keep) or `git stash pop <ref>` (no keep)
- **Optimistic state**: Adds unshelved files to uncommitted changes

### DeleteShelveOperation

- **Client class**: `DeleteShelveOperation` (`isl/src/operations/DeleteShelveOperation.ts`)
- **Sapling command**: `sl shelve --delete <name>`
- **Purpose**: Delete a shelved change without restoring it
- **Arguments**:
  - `shelvedChange` (ShelvedChange): The shelved change to delete
- **Divergences**: Git equivalent: `git stash drop <ref>`

---

## Bookmark Operations

### BookmarkCreateOperation

- **Client class**: `BookmarkCreateOperation` (`BookmarkCreateOperation.ts`)
- **Sapling command**: `sl bookmark <name> --rev <revset>`
- **Purpose**: Create a bookmark (label) on a commit
- **Arguments**:
  - `revset` (Revset): Target commit
  - `bookmark` (string): Bookmark name
- **Divergences**:
  - Sapling bookmarks are lightweight movable labels
  - Git equivalent: `git branch <name> <ref>`
  - Bookmarks in Sapling move with amend/rebase; Git branches do not auto-move
- **Optimistic state**: Adds bookmark to commit in DAG

### BookmarkDeleteOperation

- **Client class**: `BookmarkDeleteOperation` (`BookmarkDeleteOperation.ts`)
- **Sapling command**: `sl bookmark --delete <name>`
- **Purpose**: Delete a bookmark
- **Arguments**:
  - `bookmark` (string): Bookmark name to delete
- **Divergences**: Git equivalent: `git branch -d <name>`
- **Optimistic state**: Removes bookmark from commit in DAG

---

## Remote Operations

### PullOperation

- **Client class**: `PullOperation` (`isl/src/operations/PullOperation.ts`)
- **Sapling command**: `sl pull`
- **Purpose**: Fetch changes from the remote repository
- **Arguments**: None
- **Divergences**:
  - Sapling `pull` fetches new commits from remote
  - Git equivalent: `git fetch --all` (fetch only, no merge)

### PullRevOperation

- **Client class**: `PullRevOperation` (`isl/src/operations/PullRevOperation.ts`)
- **Sapling command**: `sl pull --rev <rev>`
- **Purpose**: Fetch a specific revision from the remote
- **Arguments**:
  - `rev` (ExactRevset): Specific revision to pull
- **Divergences**:
  - Sapling can pull individual revisions
  - Git doesn't support pulling individual commits by hash from most remotes

### PushOperation

- **Client class**: `PushOperation` (`isl/src/operations/PushOperation.ts`)
- **Sapling command**: `sl push --rev <topOfStackRev> --to <toBranchName> [destination]`
- **Purpose**: Push commits to a remote branch
- **Arguments**:
  - `topOfStackRev` (Revset): Top commit of the stack to push
  - `toBranchName` (string): Remote branch name
  - `destination` (string, optional): Remote destination
- **Divergences**:
  - Sapling pushes a specific revision to a named remote branch
  - Git equivalent: `git push <remote> <branch>`

### PrSubmitOperation

- **Client class**: `PrSubmitOperation` (`isl/src/operations/PrSubmitOperation.ts`)
- **Sapling command**: `sl pr submit [--draft] [--message <msg>]`
- **Purpose**: Submit commits as pull requests
- **Arguments**:
  - `options.draft` (boolean, optional): Submit as draft PR
  - `options.updateMessage` (string, optional): PR update message
- **Divergences**: Sapling-specific PR workflow. Git/Graphite have their own submit flows.

### GhStackSubmitOperation

- **Client class**: `GhStackSubmitOperation` (`GhStackSubmitOperation.ts`)
- **Sapling command**: `sl ghstack submit [--draft] [--message <msg>]`
- **Purpose**: Submit commits via ghstack (GitHub stacked PRs)
- **Arguments**: Same as PrSubmitOperation
- **Divergences**: Uses external `ghstack` tool. Only relevant for GitHub repositories.

---

## Merge Conflict Operations

### ContinueOperation

- **Client class**: `ContinueOperation` (`isl/src/operations/ContinueMergeOperation.ts`)
- **Sapling command**: `sl continue`
- **Purpose**: Continue a paused merge/rebase after resolving conflicts
- **Arguments**: None
- **Divergences**:
  - Sapling `continue` works for any interrupted operation
  - Git equivalent depends on operation: `git rebase --continue`, `git merge --continue`, `git cherry-pick --continue`

### AbortMergeOperation

- **Client class**: `AbortMergeOperation` (`isl/src/operations/AbortMergeOperation.ts`)
- **Sapling command**: `sl rebase --abort` or `sl rebase --quit` (partial abort)
- **Purpose**: Abort an in-progress merge/rebase
- **Arguments**:
  - `conflicts` (MergeConflicts): Current conflict state (determines which abort command to use)
  - `isPartialAbort` (boolean): Whether to quit (keep progress) vs abort (full rollback)
- **Divergences**:
  - `--quit` keeps already-rebased commits (Sapling-specific)
  - Git: `git rebase --abort` (full rollback only), no quit equivalent

### ResolveOperation

- **Client class**: `ResolveOperation` (`isl/src/operations/ResolveOperation.ts`)
- **Sapling command**: `sl resolve [--mark|--unmark|--tool <tool>] <file>`
- **Purpose**: Mark/unmark files as resolved, or resolve using a tool
- **Arguments**:
  - `filePath` (RepoRelativePath): File to resolve
  - `tool` (ResolveTool): Resolution strategy
- **ResolveTool values**:
  - `mark`: Mark as resolved
  - `unmark`: Mark as unresolved
  - `both`: Use internal:union (keep both sides)
  - `local`: Use internal:merge-local (keep local)
  - `other`: Use internal:merge-other (keep other)
- **Divergences**:
  - Git: `git add <file>` to mark resolved, no direct "unmark" equivalent
  - Git doesn't have built-in `internal:union`/`internal:merge-local`/`internal:merge-other` tools
- **Optimistic state**: Updates both uncommitted changes and merge conflicts to 'Resolved'

### ResolveInExternalMergeToolOperation

- **Client class**: `ResolveInExternalMergeToolOperation` (`ResolveInExternalMergeToolOperation.ts`)
- **Sapling command**: `sl resolve --tool <tool> --skip [--all | <file>]`
- **Purpose**: Open a file in an external merge tool
- **Arguments**:
  - `tool` (string): External merge tool name
  - `filePath` (RepoRelativePath, optional): Specific file, or all files if omitted

### RunMergeDriversOperation

- **Client class**: `RunMergeDriversOperation` (`RunMergeDriversOperation.ts`)
- **Sapling command**: `sl resolve --all`
- **Purpose**: Run automatic merge drivers on all conflicted files
- **Arguments**: None

---

## Commit Cloud Operations

### CommitCloudSyncOperation

- **Client class**: `CommitCloudSyncOperation` (`CommitCloudSyncOperation.ts`)
- **Sapling command**: `sl cloud sync [--full]`
- **Purpose**: Sync draft commits with commit cloud
- **Arguments**:
  - `full` (boolean): Whether to do a full sync
- **Divergences**: Sapling-specific. No Git equivalent.
- **VCS Driver**: Requires `capabilities.commitCloud`

### CommitCloudChangeWorkspaceOperation

- **Client class**: `CommitCloudChangeWorkspaceOperation` (`CommitCloudChangeWorkspaceOperation.ts`)
- **Sapling command**: `sl cloud switch -w <workspaceName>`
- **Purpose**: Switch to a different commit cloud workspace
- **Arguments**:
  - `workspaceName` (string): Target workspace
- **Divergences**: Sapling-specific. No Git equivalent.

### CommitCloudCreateWorkspaceOperation

- **Client class**: `CommitCloudCreateWorkspaceOperation` (`CommitCloudCreateWorkspaceOperation.ts`)
- **Sapling command**: `sl cloud switch --create -w <workspaceName>`
- **Purpose**: Create and switch to a new commit cloud workspace
- **Arguments**:
  - `workspaceName` (string): New workspace name
- **Divergences**: Sapling-specific. No Git equivalent.

---

## Stack Operations

### ImportStackOperation

- **Client class**: `ImportStackOperation` (`isl/src/operations/ImportStackOperation.ts`)
- **Sapling command**: `sl debugimportstack` (via stdin)
- **Purpose**: Apply a set of stack editing operations (commit, amend, goto, reset, hide, write)
- **Arguments**:
  - `importStack` (ImportStack): Array of import actions
  - `originalStack` (ExportStack): Original stack state (for optimistic state)
- **Stdin**: JSON-serialized ImportStack
- **Divergences**: Sapling-specific `debugimportstack` command. Git would need to decompose into individual operations.
- **VCS Driver**: Requires `capabilities.stackOperations`

### GraftOperation

- **Client class**: `GraftOperation` (`isl/src/operations/GraftOperation.ts`)
- **Sapling command**: `sl graft <source>`
- **Purpose**: Copy a commit to the current location (like cherry-pick)
- **Arguments**:
  - `source` (Revset): Commit to copy
- **Divergences**: Git equivalent: `git cherry-pick <source>`
- **Inline progress**: Shows "grafting..." on source commit

---

## Configuration Operations

### SetConfigOperation

- **Client class**: `SetConfigOperation` (`isl/src/operations/SetConfigOperation.ts`)
- **Sapling command**: `sl config --<scope> <configName> <value>`
- **Purpose**: Set a VCS configuration value
- **Arguments**:
  - `scope` ('user' | 'local' | 'global'): Config scope
  - `configName` (SettableConfigName): Configuration key
  - `value` (string): Configuration value
- **Divergences**: Git equivalent: `git config --<scope> <name> <value>`

---

## Data Fetching Operations

These are not client-side `Operation` classes but direct calls from Repository.ts to VCS commands.

### Fetch Smartlog Commits

- **Sapling command**: `sl log --template <MAIN_FETCH_TEMPLATE> --rev <smartlog-revset>`
- **Repository method**: `fetchSmartlogCommits()` (Repository.ts:969)
- **Revset**: `smartlog(interestingbookmarks() + heads(draft()) & date(-N)) + . + present(stableLocations) + present(recommendedBookmarks)`
- **Output**: Array of `CommitInfo` parsed via `parseCommitInfoOutput()`
- **VCS Driver method**: `fetchCommits(ctx, options)`

### Fetch Uncommitted Changes

- **Sapling command**: `sl status -Tjson --copies`
- **Repository method**: `fetchUncommittedChanges()` (Repository.ts:880)
- **Output**: JSON array of file status objects
- **VCS Driver method**: `fetchStatus(ctx)`

### Check Merge Conflicts

- **Sapling command**: `sl resolve --tool internal:dumpjson --all`
- **Repository method**: `checkForMergeConflicts()` (Repository.ts:399)
- **Output**: JSON with conflict details (file contents, conflict types)
- **VCS Driver method**: `checkMergeConflicts(ctx)`

### Get File Contents

- **Sapling command**: `sl cat <file> --rev <revset>`
- **Repository method**: `cat()` (Repository.ts:1212)
- **Output**: File contents as string
- **VCS Driver method**: `getFileContents(ctx, path, revset)`

### Get Blame

- **Sapling command**: `sl blame <file> -Tjson --change --rev <hash>`
- **Repository method**: `blame()` (Repository.ts:1226)
- **Output**: JSON array of line-by-line blame data, then `sl log` for commit details
- **VCS Driver method**: `getBlame(ctx, path, hash)`

### Get Changed Files

- **Sapling command**: `sl log --template <CHANGED_FILES_TEMPLATE> --rev <hash>`
- **Repository method**: `getAllChangedFiles()` (Repository.ts:1531)
- **Output**: Parsed array of `ChangedFile`
- **VCS Driver method**: `getChangedFiles(ctx, hash)`

### Get Shelved Changes

- **Sapling command**: `sl log --rev 'shelved()' --template <SHELVE_FETCH_TEMPLATE>`
- **Repository method**: `getShelvedChanges()` (Repository.ts:1565)
- **Output**: Array of `ShelvedChange` sorted by date
- **VCS Driver method**: `getShelvedChanges(ctx)`

### Generate Diff

- **Sapling command**: `sl diff <revset-args> --noprefix --no-binary --nodate --unified <contextLines>`
- **Repository method**: `runDiff()` (Repository.ts:1614)
- **Output**: Unified diff string
- **VCS Driver method**: `getDiff(ctx, comparison, contextLines)`

### Lookup Commits

- **Sapling command**: `sl log --template <MAIN_FETCH_TEMPLATE> --rev <hash1>+<hash2>+...`
- **Repository method**: `lookupCommits()` (Repository.ts:1367)
- **Output**: `Map<Hash, CommitInfo>`
- **VCS Driver method**: `lookupCommits(ctx, hashes)`

### Get Diff Stats

- **Sapling command**: `sl diff --stat -B -X <excluded> -c <hash>`
- **Repository method**: `fetchSignificantLinesOfCode()` (Repository.ts:1412)
- **Output**: Parsed line count (insertions + deletions)
- **VCS Driver method**: `getDiffStats(ctx, hash, excludePatterns)`

### Get Config

- **Sapling command**: `sl config <name>` (batched: `sl config -Tjson <section1> <section2>...`)
- **Repository method**: `getConfig()` / `getKnownConfigs()` (Repository.ts:1670/1693)
- **Output**: Config value string or undefined
- **VCS Driver method**: `getConfig(ctx, name)` / `getConfigs(ctx, names)`

### Fetch Submodules

- **Sapling command**: `sl debuggitmodules --json --repo <root>`
- **Repository method**: `fetchSubmoduleMap()` (Repository.ts:1173)
- **Output**: Submodule map by root
- **VCS Driver method**: `fetchSubmodules?(ctx, repoRoots)`

### Get Active Alerts

- **Sapling command**: `sl config -Tjson alerts`
- **Repository method**: `getActiveAlerts()` (Repository.ts:1588)
- **Output**: Array of `Alert`
- **VCS Driver method**: `getActiveAlerts?(ctx)`

### Collect Debug Info

- **Sapling command**: `sl rage`
- **Repository method**: `getRagePaste()` (Repository.ts:1605)
- **Output**: Paste ID string
- **VCS Driver method**: `collectDebugInfo?(ctx)`

### Export Stack

- **Sapling command**: `sl debugexportstack --rev <revs> [--assume-tracked <files>]`
- **Server handler**: `ServerToClientAPI.ts:938`
- **Output**: JSON `ExportStack`
- **VCS Driver method**: `exportStack?(ctx, revs, assumeTracked)`

### Import Stack

- **Sapling command**: `sl debugimportstack` (via stdin)
- **Server handler**: `ServerToClientAPI.ts:959`
- **Input**: JSON `ImportStack` via stdin
- **VCS Driver method**: `importStack?(ctx, stack)`

### Commit Cloud State

- **Sapling commands**: `sl config extensions.commitcloud`, `sl log --rev 'draft()-backedup()'`, `sl cloud status`, `sl cloud list`
- **Repository method**: `getCommitCloudState()` (Repository.ts:1264)
- **VCS Driver method**: `getCommitCloudState?(ctx)`

---

## Summary Statistics

| Category | Count |
|---|---|
| Client-side Operation classes | 49 (including subclasses) |
| Unique Sapling commands used | 19 |
| Data fetching operations | 15 |
| Total VCS touchpoints | 64 |
| Operations requiring `capabilities.stackOperations` | 4 |
| Sapling-only operations (no Git equivalent) | 8 |
| Operations with optimistic UI state | 25 |
