# Git Driver Parity Testing Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Achieve behavioral parity between the Git and Sapling VCS drivers by empirically testing every UI feature against both drivers and fixing differences.

**Architecture:** The test-git-repo.sh script creates identical Git repositories and launches ISL with either the Sapling or Git driver. We test each UI feature with one driver, then the other, and fix any behavioral differences in `isl-server/src/vcs/GitDriver.ts`.

**Tech Stack:** TypeScript, Git CLI, Sapling CLI, Chrome DevTools MCP for UI interaction

**Validation loop:** `scripts/test-git-repo.sh <sapling|git>` → interact via browser → compare results → fix GitDriver.ts → re-test

**Gap report reference:** `docs/git-driver-gaps.md` — 16 gaps identified (code appears to fix most, but needs empirical validation)

---

## Test Methodology

For each task below:
1. Start `scripts/test-git-repo.sh sapling` — perform the action, note the result (commit graph state, file state, UI behavior)
2. Kill the server (Ctrl+C), start `scripts/test-git-repo.sh git` — perform the same action
3. Compare: Does the git repo end up in the same state? Does the UI show the same thing?
4. If different: fix `GitDriver.ts`, restart, re-test
5. Mark task complete when behavior matches

**Pass/fail criteria:** The commit graph shows the same number of commits, the same parent/child relationships, and the same phase annotations. The working directory status lists the same files with the same status codes. Operations complete without errors.

**Important:** Take a screenshot after each action to document the state. Use `git log --oneline --all --graph` in the test repo to compare graph state between drivers.

---

## Task 1: Commit Graph Display (fetchCommits)

Test that the smartlog/commit tree renders the same topology and metadata for both drivers.

**Files:**
- Observe: `isl-server/src/vcs/GitDriver.ts` (fetchCommits ~line 200-400)
- Observe: `isl-server/src/vcs/SaplingDriver.ts` (fetchCommits)

- [ ] **Step 1: Launch with Sapling driver**

Run: `scripts/test-git-repo.sh sapling`

Open ISL in browser. Take screenshot of the commit tree. Note:
- Number of commits visible
- Branch names shown
- Which commits are "public" vs "draft"
- Which commit is marked as current ("you are here")
- Parent/child relationships

- [ ] **Step 2: Launch with Git driver**

Kill previous server. Run: `scripts/test-git-repo.sh git`

Open ISL. Take screenshot. Compare same attributes from Step 1.

- [ ] **Step 3: Document differences**

Write down every difference between the two views.

- [ ] **Step 4: Fix any differences in GitDriver.ts**

If the graph topology, phase detection, or branch display differs, fix in `fetchCommits()`.

- [ ] **Step 5: Re-test and verify**

Restart git driver, confirm the view matches sapling.

---

## Task 2: Uncommitted Changes Display (fetchStatus)

Test that modified/added/removed/untracked files display identically.

**Files:**
- Observe: `isl-server/src/vcs/GitDriver.ts` (fetchStatus)

- [ ] **Step 1: Create dirty working directory state**

In the test repo, create these states:
```bash
echo "modified" >> main.txt          # Modified tracked file
echo "new file" > brand-new.txt      # Untracked file
rm login.css                         # Missing/deleted file (if on that branch)
```

- [ ] **Step 2: Compare display with Sapling vs Git driver**

Both should show the same file statuses (M, ?, !, A, R).

- [ ] **Step 3: Fix any differences**

- [ ] **Step 4: Verify**

---

## Task 3: Commit Operation

Create a new commit from uncommitted changes.

- [ ] **Step 1: With Sapling driver — make changes, commit via UI**

1. Modify a file in the test repo
2. In ISL, type a commit message
3. Click "Commit"
4. Note: new commit appears in graph, working directory is clean

- [ ] **Step 2: With Git driver — same operation**

Same steps. Compare:
- Commit appears in graph
- Working directory clears
- Commit metadata (message, author, date) matches format

- [ ] **Step 3: Fix any differences**

- [ ] **Step 4: Verify**

---

## Task 4: Amend Operation (HEAD)

Amend the current commit with new changes.

- [ ] **Step 1: With Sapling — modify file, click Amend**

1. Modify a file
2. Click "Amend" button
3. Note: current commit updated, no new commit created

- [ ] **Step 2: With Git — same operation**

Compare: commit hash changes, message preserved, file changes absorbed.

- [ ] **Step 3: Fix any differences**

- [ ] **Step 4: Verify**

---

## Task 5: Amend Message (metaedit) — HEAD and Non-HEAD

Edit the commit message of any draft commit.

**Related gaps:** #5 (AmendMessageOperation on non-HEAD silently amends HEAD — now has shell script implementation, needs validation)

- [ ] **Step 1: With Sapling — edit HEAD commit message**

Click on current commit, edit message, save.

- [ ] **Step 2: With Sapling — edit non-HEAD commit message**

Click on an older draft commit, edit its message, save. Note: descendants are restacked with new hashes.

- [ ] **Step 3: With Git — edit HEAD commit message**

Same as Step 1. Compare behavior.

- [ ] **Step 4: With Git — edit non-HEAD commit message**

Same as Step 2. The Git driver should checkout→amend→rebase→restore. Compare:
- Target commit's message changes
- Descendants are restacked (new hashes)
- Branch pointer restored
- No spurious HEAD amend

- [ ] **Step 5: Fix any differences**

- [ ] **Step 6: Verify**

---

## Task 6: Goto Operation

Switch the working directory to a different commit.

**Related gaps:** Spec describes stash/checkout/pop for dirty WD in Git.

- [ ] **Step 1: With Sapling — goto with clean working directory**

Right-click a commit on feature/login → Goto. Note:
- Working directory updates
- "You are here" marker moves

- [ ] **Step 2: With Sapling — goto with dirty working directory**

Modify a file first, then goto a different commit. Sapling carries changes.

- [ ] **Step 3: With Git — goto with clean working directory**

Same as Step 1. Compare behavior.

- [ ] **Step 4: With Git — goto with dirty working directory**

Same as Step 2. Git uses stash/checkout/pop. Compare:
- Changes are preserved after goto
- No data loss

- [ ] **Step 5: Fix any differences**

- [ ] **Step 6: Verify**

---

## Task 7: Rebase Operation

Move a commit (and descendants) to a new parent.

- [ ] **Step 1: With Sapling — linear rebase (feature/login onto latest main)**

Use the UI rebase action (drag or context menu "Rebase onto").
Note: commit moves, descendants follow, hash changes.

- [ ] **Step 2: With Sapling — branching topology rebase**

Create a commit with two child branches diverging. Rebase the parent. Both branches should follow.

- [ ] **Step 3: With Git — same linear rebase**

Compare: same graph topology after rebase.

- [ ] **Step 4: With Git — same branching topology rebase**

Compare: both descendant branches rebased.

- [ ] **Step 5: Fix any differences**

- [ ] **Step 6: Verify**

---

## Task 8: Fold Operation

Squash multiple contiguous commits into one.

**Related gaps:** #4 (FoldOperation squashed too many commits for non-HEAD — now uses reset --soft approach, needs validation)

- [ ] **Step 1: With Sapling — fold 2 HEAD commits on feature/dashboard**

Select both commits, use Fold action. Note:
- Two commits become one
- Message is combined or uses provided message

- [ ] **Step 2: With Sapling — fold non-HEAD commits**

Fold commits that are NOT at the tip (e.g., in a stack A-B-C-D, fold B::C). Verify D is preserved as child of the fold.

- [ ] **Step 3: With Git — fold HEAD commits**

Compare behavior with Step 1.

- [ ] **Step 4: With Git — fold non-HEAD commits**

Compare with Step 2. Critically verify:
- Only the target range is folded
- Descendants above topHash are rebased onto the fold, not squashed into it

- [ ] **Step 5: Fix any differences**

- [ ] **Step 6: Verify**

---

## Task 9: Hide Operation

Make a commit (and descendants) disappear from the graph.

**Related gaps:** #8 (HideOperation didn't hide descendants — now uses `--contains`, needs validation)

- [ ] **Step 1: With Sapling — hide a leaf commit**

Right-click a draft commit with no children → Hide. Commit disappears.

- [ ] **Step 2: With Sapling — hide a commit with descendants**

Hide a commit that has child commits on separate branches. All descendants should disappear.

- [ ] **Step 3: With Git — hide a leaf commit**

Compare: branch pointing to commit is deleted, commit disappears from graph.

- [ ] **Step 4: With Git — hide a commit with descendants**

Set up: create a commit with at least two descendant commits on different branches. Hide the ancestor. Verify:
- All branches containing the hidden commit are deleted (using `--contains`)
- All descendant commits disappear from graph
- If currently on one of the deleted branches, HEAD detaches to parent

- [ ] **Step 5: Fix any differences**

- [ ] **Step 6: Verify**

---

## Task 10: Shelve / Unshelve / Delete Shelve Operations

Save, restore, and discard uncommitted changes.

- [ ] **Step 1: With Sapling — shelve changes**

1. Modify files
2. Click Shelve in the uncommitted changes panel
3. Note: changes disappear, shelved changes menu shows entry

- [ ] **Step 2: With Sapling — unshelve**

Restore shelved changes. Working directory shows the changes again.

- [ ] **Step 3: With Sapling — delete a shelved change**

Shelve again, then delete the shelved entry without restoring.

- [ ] **Step 4: With Git — same operations (shelve, unshelve, delete)**

Git uses `git stash`. Compare behavior for all three operations.

- [ ] **Step 5: Fix any differences**

- [ ] **Step 6: Verify**

---

## Task 11: Bookmark (Branch) Create / Delete

- [ ] **Step 1: With Sapling — create bookmark on a commit**

Right-click → Create Bookmark. Note: name appears on commit.

- [ ] **Step 2: With Sapling — delete bookmark**

Delete the bookmark. It disappears.

- [ ] **Step 3: With Git — same operations**

Git branches = Sapling bookmarks. Compare create/delete behavior.

- [ ] **Step 4: Fix any differences**

- [ ] **Step 5: Verify**

---

## Task 12: Rebase with Merge Conflicts + Resolve Strategies

Trigger and resolve merge conflicts using all resolution strategies.

**Related gaps:** #11 (resolve --tool variants), #12 (external merge tool), #13 (run merge drivers)

- [ ] **Step 1: With Sapling — rebase "rebase-me" onto "onto-me-for-merge-conflict"**

This should produce conflicts (content, delete/modify, add/add, rename).
Note:
- UI shows conflict state
- Conflicted files listed with resolution options

- [ ] **Step 2: Resolve with Sapling — test each strategy**

For each conflicted file, test a different strategy:
- **Mark as resolved** (manual edit + mark) on one file
- **Take local** (merge-local / `--ours`) on another
- **Take incoming** (merge-other / `--theirs`) on another
- **Combine both** (union) on another

Then click Continue. Note final graph state.

- [ ] **Step 3: With Git — same rebase to trigger conflicts**

Compare:
- Conflict detection (checks `rebase-merge`, `MERGE_HEAD`, `CHERRY_PICK_HEAD`)
- Conflicted files listed correctly
- Resolution options available in UI

- [ ] **Step 4: With Git — resolve with each strategy**

Test each: mark-resolved, merge-local (`--ours`), merge-other (`--theirs`), union (`merge-file --union`).
Then Continue. Compare final graph state with Sapling result.

- [ ] **Step 5: Test external merge tool resolution (if configured)**

With Git: `resolve --tool <tool> <file>` → should translate to `git mergetool --tool=<tool> <file>`.

- [ ] **Step 6: Test "resolve --all" (RunMergeDrivers)**

With Git: should translate to `git mergetool`.

- [ ] **Step 7: Fix any differences**

- [ ] **Step 8: Verify**

---

## Task 13: Abort Merge Operations

Test aborting an in-progress rebase/merge.

**Related gaps:** #1 (AbortMergeOperation crashed — now has operation-type detection)

- [ ] **Step 1: With Sapling — trigger rebase conflict, then abort**

Rebase to cause conflict, then click Abort. Repo returns to pre-rebase state.

- [ ] **Step 2: With Git — same abort**

Compare: abort correctly detects operation type and runs `git rebase --abort`. Repo returns to pre-rebase state.

- [ ] **Step 3: Test quit variant if available in UI**

Quit keeps already-applied commits. Git uses rewritten-list from rebase-merge dir.

- [ ] **Step 4: Fix any differences**

- [ ] **Step 5: Verify**

---

## Task 14: Continue Operation

Resume after resolving merge conflicts.

**Related gaps:** #6 (ContinueOperation always ran rebase --continue — now detects operation type)

- [ ] **Step 1: With Sapling — trigger conflict, resolve, continue**

Verify continue completes the rebase.

- [ ] **Step 2: With Git — trigger rebase conflict, resolve, continue**

Verify detection: checks `rebase-merge` dir → runs `git rebase --continue`.

- [ ] **Step 3: With Git — trigger cherry-pick conflict, resolve, continue**

Graft a conflicting commit. Verify detection: checks `CHERRY_PICK_HEAD` → runs `git cherry-pick --continue`.

- [ ] **Step 4: Fix any differences**

- [ ] **Step 5: Verify**

---

## Task 15: Pull Operation

Fetch new commits from remote.

**Related gaps:** #7 (PullOperation did fetch+merge — now translates to `fetch --all`)

- [ ] **Step 1: Push a new commit to the bare remote from outside ISL**

```bash
# Find the bare remote path (printed when test-git-repo.sh runs)
BARE_REMOTE=$(ls -d /tmp/champagne-remote-* | tail -1)
TEST_REPO=$(ls -d /tmp/champagne-git-test-* | tail -1)

# Create a temporary clone, make a commit, push it
TEMP_CLONE=$(mktemp -d)
git clone "$BARE_REMOTE" "$TEMP_CLONE"
cd "$TEMP_CLONE"
git config user.email "remote@test.dev"
git config user.name "Remote User"
echo "remote change" > remote-file.txt
git add remote-file.txt
git commit -m "Remote commit for pull testing"
git push origin main
cd "$TEST_REPO"
rm -rf "$TEMP_CLONE"
```

- [ ] **Step 2: With Sapling — click Pull**

Note: new commits appear in graph. No merge into working directory. HEAD stays put.

- [ ] **Step 3: With Git — click Pull**

Verify it does `git fetch --all` (not `git pull`):
- New commits appear in graph
- HEAD does NOT move
- No merge commit created
- Working directory unchanged

- [ ] **Step 4: Fix any differences**

- [ ] **Step 5: Verify**

---

## Task 16: Uncommit Operation

Undo the last commit, returning changes to working directory.

- [ ] **Step 1: With Sapling — uncommit**

Click Uncommit on current commit. Changes return to uncommitted.

- [ ] **Step 2: With Git — same operation**

Should do `git reset --soft HEAD~1`. Compare.

- [ ] **Step 3: Fix any differences**

- [ ] **Step 4: Verify**

---

## Task 17: Amend-To Operation (Absorb)

Absorb working directory changes into a non-HEAD commit.

**Related gaps:** #10 (AmendToOperation passed through unchanged — now has shell script implementation)

- [ ] **Step 1: With Sapling — amend changes to an older commit**

Modify a file, right-click older commit → "Amend changes to here".

- [ ] **Step 2: With Git — same operation**

Compare: changes absorbed into target commit, descendants restacked. The Git driver should stash→checkout→pop→amend→rebase→restore.

- [ ] **Step 3: Fix any differences**

- [ ] **Step 4: Verify**

---

## Task 18: Rebase Keep (Cherry-Pick) Operation

Copy a commit to a new location without removing the original.

**Related gaps:** #9 (RebaseKeepOperation ignored destination — now parses --dest)

- [ ] **Step 1: With Sapling — rebase --keep a commit to a specific destination**

If available in UI, cherry-pick a commit to a different parent.

- [ ] **Step 2: With Git — same operation**

Verify it checks out dest first, then cherry-picks. The original commit remains.

- [ ] **Step 3: Fix any differences**

- [ ] **Step 4: Verify**

---

## Task 19: Bulk Rebase Operation

Move multiple commits to the same destination.

**Related gaps:** #2 (BulkRebaseOperation crashed on --rev — now handles --rev flag)

- [ ] **Step 1: With Sapling — select multiple commits, rebase all to same dest**

- [ ] **Step 2: With Git — same operation**

Git should `checkout <dest> && cherry-pick <rev1> <rev2>...`.

- [ ] **Step 3: Fix any differences**

- [ ] **Step 4: Verify**

---

## Task 20: Rebase All Draft Commits

Move all local-only commits onto a new base.

**Related gaps:** #3 (RebaseAllDraftCommitsOperation used invalid `draft()` revset — now uses merge-base)

- [ ] **Step 1: With Sapling — use "Suggested Rebase" or Bulk Actions menu**

Bulk Actions → Suggested Rebase (or equivalent).

- [ ] **Step 2: With Git — same operation**

Verify `draft()` revset translates to `git merge-base HEAD origin/HEAD` calculation.

- [ ] **Step 3: Fix any differences**

- [ ] **Step 4: Verify**

---

## Task 21: File Operations (Add, Forget, Revert, Rm, Discard, Purge)

Test individual file management operations.

- [ ] **Step 1: Test Add (untracked → tracked)**

Create untracked file, use Add in UI. Compare sapling vs git.

- [ ] **Step 2: Test Forget (tracked → untracked)**

Use Forget on a tracked file. File stays on disk but becomes untracked.

- [ ] **Step 3: Test Revert (restore file to commit state)**

Modify a file, revert via UI. Changes discarded, file restored.

- [ ] **Step 4: Test Rm (remove file from tracking and disk)**

Use Rm on a tracked file. File deleted from disk and removed from tracking.

- [ ] **Step 5: Test Discard (discard all tracked uncommitted changes)**

Multiple dirty files. Use Discard All. Working directory matches current commit. Note: Discard is `sl goto --clean .` in Sapling, translates to `git checkout -- <files>` in Git.

- [ ] **Step 6: Test Purge (delete untracked files)**

Create untracked files, purge. Files deleted from disk.

- [ ] **Step 7: Compare all operations between drivers**

- [ ] **Step 8: Fix any differences**

---

## Task 22: Graft (Cherry-Pick) Operation

Copy a commit onto the current location.

- [ ] **Step 1: With Sapling — graft a commit**

- [ ] **Step 2: With Git — same operation**

Should translate to `git cherry-pick <hash>`.

- [ ] **Step 3: Fix any differences**

- [ ] **Step 4: Verify**

---

## Task 23: getBlame

Test blame/annotate display.

**Related gaps:** #16 (getBlame was unimplemented stub — now has porcelain parser)

- [ ] **Step 1: With Sapling — view blame for a file**

Open blame view for main.txt (or similar multi-commit file).

- [ ] **Step 2: With Git — same operation**

Compare: line-by-line attribution matches (same commit hashes, same line content).

- [ ] **Step 3: Fix any differences**

- [ ] **Step 4: Verify**

---

## Task 24: getFileContents / getDiff / getDiffStats

Test viewing file contents at specific revisions, diffs, and diff statistics.

- [ ] **Step 1: With Sapling — view a file at an older revision**

Click on a commit, view a changed file's diff.

- [ ] **Step 2: With Git — same operation**

Compare diff display.

- [ ] **Step 3: Compare diff stats**

If visible in UI (line counts, additions/removals), compare between drivers.

- [ ] **Step 4: Fix any differences**

- [ ] **Step 5: Verify**

---

## Task 25: Push Operation

Push commits to remote.

- [ ] **Step 1: With Sapling — create a commit and push**

Create new commit, push to remote.

- [ ] **Step 2: With Git — same operation**

Compare: commit arrives at remote, tracking updated, commit phase changes to public.

- [ ] **Step 3: Fix any differences**

- [ ] **Step 4: Verify**

---

## Task 26: Capability-Gated Features Verification

Verify that features disabled via capabilities are correctly hidden in the Git driver UI.

- [ ] **Step 1: Verify partialCommit is hidden**

With Git driver, confirm the UI does NOT show partial commit controls (selecting individual hunks to commit). With Sapling driver, confirm it IS available (if `partialCommit: true`).

- [ ] **Step 2: Verify partialAmend is hidden**

Same check for partial amend (selecting individual hunks to amend).

- [ ] **Step 3: Verify commitCloud features are hidden**

With Git driver, no commit cloud UI. With Sapling, cloud sync UI may appear.

- [ ] **Step 4: Verify stackOperations are hidden**

With Git driver, stack edit UI should be disabled or hidden.

- [ ] **Step 5: Document which capability-gated features need future implementation**

---

## Task 27: Final Regression Pass

Run through all operations once more with the git driver to confirm everything works together.

- [ ] **Step 1: Fresh test repo**

`scripts/test-git-repo.sh git` with a clean repo.

- [ ] **Step 2: Rapid walkthrough**

Commit → Amend → Amend Message (non-HEAD) → Goto (clean + dirty) → Rebase → Fold (HEAD + non-HEAD) → Hide (leaf + with descendants) → Shelve/Unshelve/Delete → Pull → Push → Rebase to Conflict → Resolve (all strategies) → Continue → Abort

- [ ] **Step 3: Run unit tests**

```bash
cd isl-server && yarn test --testPathPattern="VCSDriverIntegration|GitDriverTranslations" --no-coverage
```

- [ ] **Step 4: Confirm all tests pass**

- [ ] **Step 5: Commit all fixes**
