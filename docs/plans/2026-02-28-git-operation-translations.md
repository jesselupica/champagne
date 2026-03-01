# Git Operation Translations Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Translate every Sapling-style operation arg to its Git equivalent — both server-side (so `git` runs the right command) and frontend (so the UI displays the right command string to the user).

**Architecture:** Each operation goes through two layers: (1) `GitDriver.normalizeOperationArgs()` in `isl-server/src/vcs/GitDriver.ts` transforms args before execution, (2) `translateArgsForDisplay()` in `isl/src/CommandHistoryAndProgress.tsx` transforms args before displaying in the UI. Both functions switch on `args[0]` (the Sapling subcommand name). Each task in this plan adds one or more translations to each layer, plus a unit test verifying the server-side translation.

**Tech Stack:** TypeScript, Jest (server tests via `cd isl-server && yarn test`), Vite hot-reload (frontend via `cd isl && yarn start`)

---

## Background: How the Two Layers Work

### Server layer — `normalizeOperationArgs` (`isl-server/src/vcs/GitDriver.ts:915`)

Called before every operation runs. Takes Sapling-style args and returns a `ResolvedCommand`:
```typescript
interface ResolvedCommand {
  args: string[];       // args passed to `git`
  stdin?: string;       // optional stdin
  env?: Record<string, string>;  // extra env vars
}
```
Special case: returning `{args: ['__shell__', 'script']}` runs `sh -c script` instead of `git`.

### Frontend layer — `translateArgsForDisplay` (`isl/src/CommandHistoryAndProgress.tsx:42`)

Called during render only. Takes `operation.getArgs()` output and `info.command` ('git' or 'sl'), returns display-friendly args. Currently only translates `forget → rm --cached`.

### Test file
All server-side translation unit tests go in a new file:
`isl-server/src/__tests__/GitDriverTranslations.test.ts`

Run tests with: `cd isl-server && yarn test --testPathPattern=GitDriverTranslations`

---

## What's Already Done

These translations exist and do NOT need to be added:
- `forget` → `git rm --cached` (server + frontend)
- `fold --exact HASH1::HASH2 --message MSG` → `git rebase -i BOTTOM^` with squash (server only)
- `hide --rev HASH` → shell script deleting branches (server only)
- `pull --rev HASH` → `git fetch origin HASH` (server only)

Frontend display for fold/hide/pull-rev is missing — those are covered in Task 9.

---

## Task 1: Test scaffolding for `normalizeOperationArgs`

**Files:**
- Create: `isl-server/src/__tests__/GitDriverTranslations.test.ts`

**Context:** `normalizeOperationArgs` takes a `RunnableOperation` (which has `args: OperationArg[]` and optional `stdin`). The `OperationArg` type is `string | {type: 'repo-relative-file', path: string} | ...`. For these translations, most args are plain strings; `repo-relative-file` objects are resolved to paths before the translation switch runs (lines 923–961 of GitDriver.ts).

**Step 1: Write the test file**

```typescript
// isl-server/src/__tests__/GitDriverTranslations.test.ts
import {GitDriver} from '../vcs/GitDriver';

const driver = new GitDriver();
const cwd = '/repo';
const repoRoot = '/repo';

function translate(args: string[], stdin?: string) {
  return driver.normalizeOperationArgs(cwd, repoRoot, {args, stdin});
}

describe('GitDriver.normalizeOperationArgs', () => {
  it('passes unknown commands through unchanged', () => {
    expect(translate(['status'])).toEqual({args: ['status'], stdin: undefined});
  });
});
```

**Step 2: Run to verify it passes**

```bash
cd /Users/jesselupica/Projects/champagne/isl-server
yarn test --testPathPattern=GitDriverTranslations
```
Expected: PASS (1 test)

**Step 3: Commit**

```bash
git add isl-server/src/__tests__/GitDriverTranslations.test.ts
git commit -m "test: add GitDriver translation test scaffold"
```

---

## Task 2: `commit` — strip `--addremove`, keep everything else

**Sapling:** `sl commit --addremove --message "msg" file.txt`
**Git:** `git commit --message "msg" file.txt`

`--addremove` is Sapling-only (auto-stages new/removed files). In git the UI explicitly stages files first, so it's safe to drop.

**Files:**
- Modify: `isl-server/src/vcs/GitDriver.ts` (in `normalizeOperationArgs` switch block)
- Modify: `isl/src/CommandHistoryAndProgress.tsx` (in `translateArgsForDisplay`)
- Test: `isl-server/src/__tests__/GitDriverTranslations.test.ts`

**Step 1: Write the failing test**

Add inside the `describe` block in `GitDriverTranslations.test.ts`:
```typescript
describe('commit', () => {
  it('strips --addremove', () => {
    expect(translate(['commit', '--addremove', '--message', 'hello'])).toEqual({
      args: ['commit', '--message', 'hello'],
      stdin: undefined,
    });
  });

  it('passes through commit without --addremove unchanged', () => {
    expect(translate(['commit', '--message', 'hello'])).toEqual({
      args: ['commit', '--message', 'hello'],
      stdin: undefined,
    });
  });
});
```

**Step 2: Run to verify it fails**

```bash
cd /Users/jesselupica/Projects/champagne/isl-server
yarn test --testPathPattern=GitDriverTranslations
```
Expected: FAIL — `--addremove` appears in output

**Step 3: Add server translation**

In `GitDriver.ts`, inside `normalizeOperationArgs`, just before `return {args, stdin}`:
```typescript
if (args[0] === 'commit') {
  return {args: args.filter(a => a !== '--addremove'), stdin};
}
```

**Step 4: Run to verify tests pass**

```bash
cd /Users/jesselupica/Projects/champagne/isl-server
yarn test --testPathPattern=GitDriverTranslations
```
Expected: PASS

**Step 5: Add frontend display translation**

In `translateArgsForDisplay` in `CommandHistoryAndProgress.tsx`, add after the `forget` case:
```typescript
if (first === 'commit') {
  return args.filter(a => a !== '--addremove');
}
```

**Step 6: Commit**

```bash
git add isl-server/src/vcs/GitDriver.ts isl/src/CommandHistoryAndProgress.tsx isl-server/src/__tests__/GitDriverTranslations.test.ts
git commit -m "feat: translate commit --addremove to git commit"
```

---

## Task 3: `amend` — translate to `git commit --amend`

**Sapling:** `sl amend --addremove --user "Name <email>" --message "msg" file.txt`
**Git:** `git commit --amend --author "Name <email>" --message "msg" file.txt`

Changes: add `--amend`, drop `--addremove`, rename `--user` to `--author`.

Also handle `amend --to COMMIT file` (no direct git equivalent — skip/throw for now since capability `partialAmend` covers the supported form via `debugimportstack`).

**Files:**
- Modify: `isl-server/src/vcs/GitDriver.ts`
- Modify: `isl/src/CommandHistoryAndProgress.tsx`
- Test: `isl-server/src/__tests__/GitDriverTranslations.test.ts`

**Step 1: Write the failing test**

```typescript
describe('amend', () => {
  it('translates to git commit --amend', () => {
    expect(translate(['amend', '--addremove', '--message', 'updated'])).toEqual({
      args: ['commit', '--amend', '--message', 'updated'],
      stdin: undefined,
    });
  });

  it('renames --user to --author', () => {
    expect(translate(['amend', '--user', 'Alice <a@b.com>', '--message', 'msg'])).toEqual({
      args: ['commit', '--amend', '--author', 'Alice <a@b.com>', '--message', 'msg'],
      stdin: undefined,
    });
  });
});
```

**Step 2: Run to verify it fails**

```bash
cd /Users/jesselupica/Projects/champagne/isl-server
yarn test --testPathPattern=GitDriverTranslations
```

**Step 3: Add server translation**

```typescript
if (args[0] === 'amend') {
  const out: string[] = ['commit', '--amend'];
  for (let i = 1; i < args.length; i++) {
    if (args[i] === '--addremove') continue;
    if (args[i] === '--user') { out.push('--author', args[++i]); continue; }
    out.push(args[i]);
  }
  return {args: out, stdin};
}
```

**Step 4: Run to verify tests pass**

```bash
cd /Users/jesselupica/Projects/champagne/isl-server
yarn test --testPathPattern=GitDriverTranslations
```

**Step 5: Add frontend display translation**

```typescript
if (first === 'amend') {
  const out: typeof args = ['commit', '--amend'];
  for (let i = 1; i < args.length; i++) {
    const a = args[i];
    if (a === '--addremove') continue;
    if (a === '--user') { out.push('--author', args[i + 1]); i++; continue; }
    out.push(a);
  }
  return out;
}
```

**Step 6: Commit**

```bash
git add isl-server/src/vcs/GitDriver.ts isl/src/CommandHistoryAndProgress.tsx isl-server/src/__tests__/GitDriverTranslations.test.ts
git commit -m "feat: translate amend to git commit --amend"
```

---

## Task 4: `metaedit` — amend message on any commit

**Sapling:** `sl metaedit --rev HASH --message "msg" --user "Author"`
**Git:** If HASH == HEAD: `git commit --amend --message "msg" --author "Author"`. Non-HEAD commits require interactive rebase — out of scope for now; throw an unsupported error.

**Files:**
- Modify: `isl-server/src/vcs/GitDriver.ts`
- Modify: `isl/src/CommandHistoryAndProgress.tsx`
- Test: `isl-server/src/__tests__/GitDriverTranslations.test.ts`

**Step 1: Write the failing test**

```typescript
describe('metaedit', () => {
  it('translates to git commit --amend', () => {
    expect(translate(['metaedit', '--rev', 'abc123', '--message', 'new msg'])).toEqual({
      args: ['commit', '--amend', '--message', 'new msg'],
      stdin: undefined,
    });
  });

  it('renames --user to --author', () => {
    expect(translate(['metaedit', '--rev', 'abc123', '--user', 'Bob <b@c.com>', '--message', 'msg'])).toEqual({
      args: ['commit', '--amend', '--author', 'Bob <b@c.com>', '--message', 'msg'],
      stdin: undefined,
    });
  });
});
```

**Step 2: Run to verify it fails**

```bash
cd /Users/jesselupica/Projects/champagne/isl-server
yarn test --testPathPattern=GitDriverTranslations
```

**Step 3: Add server translation**

```typescript
if (args[0] === 'metaedit') {
  const out: string[] = ['commit', '--amend'];
  for (let i = 1; i < args.length; i++) {
    if (args[i] === '--rev') { i++; continue; }  // drop --rev HASH
    if (args[i] === '--user') { out.push('--author', args[++i]); continue; }
    out.push(args[i]);
  }
  return {args: out, stdin};
}
```

**Step 4: Run to verify tests pass**

```bash
cd /Users/jesselupica/Projects/champagne/isl-server
yarn test --testPathPattern=GitDriverTranslations
```

**Step 5: Add frontend display translation**

```typescript
if (first === 'metaedit') {
  const out: typeof args = ['commit', '--amend'];
  for (let i = 1; i < args.length; i++) {
    const a = args[i];
    if (a === '--rev') { i++; continue; }
    if (a === '--user') { out.push('--author', args[i + 1]); i++; continue; }
    out.push(a);
  }
  return out;
}
```

**Step 6: Commit**

```bash
git add isl-server/src/vcs/GitDriver.ts isl/src/CommandHistoryAndProgress.tsx isl-server/src/__tests__/GitDriverTranslations.test.ts
git commit -m "feat: translate metaedit to git commit --amend"
```

---

## Task 5: `goto` — translate to `git checkout`

**Sapling:** `sl goto --rev HASH`
**Git:** `git checkout HASH`

Also handle `goto --clean .` (DiscardOperation):
**Sapling:** `sl goto --clean .`
**Git:** `git checkout -- .`

**Files:**
- Modify: `isl-server/src/vcs/GitDriver.ts`
- Modify: `isl/src/CommandHistoryAndProgress.tsx`
- Test: `isl-server/src/__tests__/GitDriverTranslations.test.ts`

**Step 1: Write the failing test**

```typescript
describe('goto', () => {
  it('translates goto --rev HASH to checkout HASH', () => {
    expect(translate(['goto', '--rev', 'abc123'])).toEqual({
      args: ['checkout', 'abc123'],
      stdin: undefined,
    });
  });

  it('translates goto --clean . to checkout -- .', () => {
    expect(translate(['goto', '--clean', '.'])).toEqual({
      args: ['checkout', '--', '.'],
      stdin: undefined,
    });
  });
});
```

**Step 2: Run to verify it fails**

```bash
cd /Users/jesselupica/Projects/champagne/isl-server
yarn test --testPathPattern=GitDriverTranslations
```

**Step 3: Add server translation**

```typescript
if (args[0] === 'goto') {
  if (args.includes('--clean')) {
    // Discard all working directory changes
    const files = args.filter(a => a !== 'goto' && a !== '--clean');
    return {args: ['checkout', '--', ...files], stdin};
  }
  // goto --rev HASH → checkout HASH
  const revIdx = args.indexOf('--rev');
  const hash = revIdx !== -1 ? args[revIdx + 1] : args[1];
  return {args: ['checkout', hash], stdin};
}
```

**Step 4: Run to verify tests pass**

```bash
cd /Users/jesselupica/Projects/champagne/isl-server
yarn test --testPathPattern=GitDriverTranslations
```

**Step 5: Add frontend display translation**

```typescript
if (first === 'goto') {
  if (args.includes('--clean')) {
    const files = args.filter(a => a !== 'goto' && a !== '--clean');
    return ['checkout', '--', ...files];
  }
  const revIdx = args.indexOf('--rev');
  const hash = revIdx !== -1 ? args[revIdx + 1] : args[1];
  return ['checkout', hash];
}
```

**Step 6: Commit**

```bash
git add isl-server/src/vcs/GitDriver.ts isl/src/CommandHistoryAndProgress.tsx isl-server/src/__tests__/GitDriverTranslations.test.ts
git commit -m "feat: translate goto to git checkout"
```

---

## Task 6: `revert` — restore files to a revision

**Sapling:** `sl revert --rev HASH file.txt`
**Git:** `git checkout HASH -- file.txt` (or `git restore --source=HASH file.txt`)

Use `checkout HASH -- files` (compatible with older git).

**Files:**
- Modify: `isl-server/src/vcs/GitDriver.ts`
- Modify: `isl/src/CommandHistoryAndProgress.tsx`
- Test: `isl-server/src/__tests__/GitDriverTranslations.test.ts`

**Step 1: Write the failing test**

```typescript
describe('revert', () => {
  it('translates revert --rev HASH file to checkout HASH -- file', () => {
    expect(translate(['revert', '--rev', 'abc123', 'file.txt'])).toEqual({
      args: ['checkout', 'abc123', '--', 'file.txt'],
      stdin: undefined,
    });
  });

  it('handles multiple files', () => {
    expect(translate(['revert', '--rev', 'abc123', 'a.txt', 'b.txt'])).toEqual({
      args: ['checkout', 'abc123', '--', 'a.txt', 'b.txt'],
      stdin: undefined,
    });
  });
});
```

**Step 2: Run to verify it fails**

```bash
cd /Users/jesselupica/Projects/champagne/isl-server
yarn test --testPathPattern=GitDriverTranslations
```

**Step 3: Add server translation**

```typescript
if (args[0] === 'revert') {
  const revIdx = args.indexOf('--rev');
  const hash = revIdx !== -1 ? args[revIdx + 1] : 'HEAD';
  const files = args.slice(1).filter((a, i, arr) =>
    a !== '--rev' && arr[i - 1] !== '--rev'
  );
  return {args: ['checkout', hash, '--', ...files], stdin};
}
```

**Step 4: Run to verify tests pass**

```bash
cd /Users/jesselupica/Projects/champagne/isl-server
yarn test --testPathPattern=GitDriverTranslations
```

**Step 5: Add frontend display translation**

```typescript
if (first === 'revert') {
  const revIdx = args.indexOf('--rev');
  const hash = revIdx !== -1 ? args[revIdx + 1] : 'HEAD';
  const files = args.slice(1).filter((a, i, arr) =>
    a !== '--rev' && arr[i - 1] !== '--rev'
  );
  return ['checkout', hash, '--', ...files];
}
```

**Step 6: Commit**

```bash
git add isl-server/src/vcs/GitDriver.ts isl/src/CommandHistoryAndProgress.tsx isl-server/src/__tests__/GitDriverTranslations.test.ts
git commit -m "feat: translate revert to git checkout REV -- files"
```

---

## Task 7: `rebase` — translate to `git rebase --onto`

**Sapling:** `sl rebase -s SRC -d DEST` (move SRC and descendants onto DEST)
**Git:** `git rebase --onto DEST SRC^ SRC` (for a single linear commit; branch tips require more)

Also handle `rebase --rev HASH -d DEST` (BulkRebaseOperation) and `rebase --keep --rev HASH --dest DEST` (RebaseKeepOperation → `git cherry-pick`).

**Files:**
- Modify: `isl-server/src/vcs/GitDriver.ts`
- Modify: `isl/src/CommandHistoryAndProgress.tsx`
- Test: `isl-server/src/__tests__/GitDriverTranslations.test.ts`

**Step 1: Write the failing test**

```typescript
describe('rebase', () => {
  it('translates rebase -s SRC -d DEST to rebase --onto DEST SRC^ SRC', () => {
    expect(translate(['rebase', '-s', 'abc123', '-d', 'def456'])).toEqual({
      args: ['rebase', '--onto', 'def456', 'abc123^', 'abc123'],
      stdin: undefined,
    });
  });

  it('translates rebase --keep --rev SRC --dest DEST to cherry-pick', () => {
    expect(translate(['rebase', '--keep', '--rev', 'abc123', '--dest', 'def456'])).toEqual({
      args: ['cherry-pick', 'abc123'],
      stdin: undefined,
    });
  });
});
```

**Step 2: Run to verify it fails**

```bash
cd /Users/jesselupica/Projects/champagne/isl-server
yarn test --testPathPattern=GitDriverTranslations
```

**Step 3: Add server translation**

```typescript
if (args[0] === 'rebase') {
  if (args.includes('--keep')) {
    // RebaseKeepOperation: copy without moving → cherry-pick
    const revIdx = args.indexOf('--rev');
    const src = revIdx !== -1 ? args[revIdx + 1] : undefined;
    if (!src) throw new Error('rebase --keep requires --rev');
    return {args: ['cherry-pick', src], stdin};
  }
  // Standard rebase: -s SRC -d DEST → rebase --onto DEST SRC^ SRC
  let src: string | undefined;
  let dest: string | undefined;
  for (let i = 1; i < args.length; i++) {
    if ((args[i] === '-s' || args[i] === '--source') && i + 1 < args.length) src = args[++i];
    else if ((args[i] === '-d' || args[i] === '--dest') && i + 1 < args.length) dest = args[++i];
  }
  if (!src || !dest) throw new Error('rebase requires -s and -d');
  return {args: ['rebase', '--onto', dest, src + '^', src], stdin};
}
```

**Step 4: Run to verify tests pass**

```bash
cd /Users/jesselupica/Projects/champagne/isl-server
yarn test --testPathPattern=GitDriverTranslations
```

**Step 5: Add frontend display translation**

```typescript
if (first === 'rebase') {
  if (args.includes('--keep')) {
    const revIdx = args.indexOf('--rev');
    const src = revIdx !== -1 ? args[revIdx + 1] : '??';
    return ['cherry-pick', src];
  }
  let src: typeof args[0] = '??';
  let dest: typeof args[0] = '??';
  for (let i = 1; i < args.length; i++) {
    if ((args[i] === '-s' || args[i] === '--source') && i + 1 < args.length) src = args[i + 1];
    else if ((args[i] === '-d' || args[i] === '--dest') && i + 1 < args.length) dest = args[i + 1];
  }
  return ['rebase', '--onto', dest, src + '^', src];
}
```

**Step 6: Commit**

```bash
git add isl-server/src/vcs/GitDriver.ts isl/src/CommandHistoryAndProgress.tsx isl-server/src/__tests__/GitDriverTranslations.test.ts
git commit -m "feat: translate rebase -s -d to git rebase --onto"
```

---

## Task 8: `bookmark` — translate to `git branch`

**Sapling:** `sl bookmark NAME --rev HASH` → create branch
**Git:** `git branch NAME HASH`

**Sapling:** `sl bookmark --delete NAME`
**Git:** `git branch -d NAME`

**Files:**
- Modify: `isl-server/src/vcs/GitDriver.ts`
- Modify: `isl/src/CommandHistoryAndProgress.tsx`
- Test: `isl-server/src/__tests__/GitDriverTranslations.test.ts`

**Step 1: Write the failing test**

```typescript
describe('bookmark', () => {
  it('translates bookmark NAME --rev HASH to branch NAME HASH', () => {
    expect(translate(['bookmark', 'my-branch', '--rev', 'abc123'])).toEqual({
      args: ['branch', 'my-branch', 'abc123'],
      stdin: undefined,
    });
  });

  it('translates bookmark --delete NAME to branch -d NAME', () => {
    expect(translate(['bookmark', '--delete', 'my-branch'])).toEqual({
      args: ['branch', '-d', 'my-branch'],
      stdin: undefined,
    });
  });
});
```

**Step 2: Run to verify it fails**

```bash
cd /Users/jesselupica/Projects/champagne/isl-server
yarn test --testPathPattern=GitDriverTranslations
```

**Step 3: Add server translation**

```typescript
if (args[0] === 'bookmark') {
  if (args[1] === '--delete') {
    return {args: ['branch', '-d', args[2]], stdin};
  }
  // bookmark NAME --rev HASH → branch NAME HASH
  const name = args[1];
  const revIdx = args.indexOf('--rev');
  const hash = revIdx !== -1 ? args[revIdx + 1] : 'HEAD';
  return {args: ['branch', name, hash], stdin};
}
```

**Step 4: Run to verify tests pass**

```bash
cd /Users/jesselupica/Projects/champagne/isl-server
yarn test --testPathPattern=GitDriverTranslations
```

**Step 5: Add frontend display translation**

```typescript
if (first === 'bookmark') {
  if (args[1] === '--delete') return ['branch', '-d', args[2]];
  const name = args[1];
  const revIdx = args.indexOf('--rev');
  const hash = revIdx !== -1 ? args[revIdx + 1] : 'HEAD';
  return ['branch', name, hash];
}
```

**Step 6: Commit**

```bash
git add isl-server/src/vcs/GitDriver.ts isl/src/CommandHistoryAndProgress.tsx isl-server/src/__tests__/GitDriverTranslations.test.ts
git commit -m "feat: translate bookmark to git branch"
```

---

## Task 9: `shelve` / `unshelve` / `shelve --delete` — translate to `git stash`

**Sapling:** `sl shelve --unknown --name NAME files...`
**Git:** `git stash push -u -m NAME -- files...`

**Sapling:** `sl unshelve --keep --name NAME` (or `sl unshelve --name NAME`)
**Git:** `git stash apply` (by index; Sapling stash names don't map directly, use index 0)

**Sapling:** `sl shelve --delete NAME`
**Git:** `git stash drop` (drop stash@{0})

Note: Git stash doesn't support named lookup the way Sapling does; the UnshelveOperation applies the most recent stash (index 0).

**Files:**
- Modify: `isl-server/src/vcs/GitDriver.ts`
- Modify: `isl/src/CommandHistoryAndProgress.tsx`
- Test: `isl-server/src/__tests__/GitDriverTranslations.test.ts`

**Step 1: Write the failing test**

```typescript
describe('shelve', () => {
  it('translates shelve to git stash push', () => {
    expect(translate(['shelve', '--unknown', '--name', 'wip', 'file.txt'])).toEqual({
      args: ['stash', 'push', '-u', '-m', 'wip', '--', 'file.txt'],
      stdin: undefined,
    });
  });

  it('translates shelve with no files', () => {
    expect(translate(['shelve', '--unknown', '--name', 'wip'])).toEqual({
      args: ['stash', 'push', '-u', '-m', 'wip'],
      stdin: undefined,
    });
  });

  it('translates shelve --delete to stash drop', () => {
    expect(translate(['shelve', '--delete', 'wip'])).toEqual({
      args: ['stash', 'drop'],
      stdin: undefined,
    });
  });
});

describe('unshelve', () => {
  it('translates unshelve --keep to stash apply', () => {
    expect(translate(['unshelve', '--keep', '--name', 'wip'])).toEqual({
      args: ['stash', 'apply'],
      stdin: undefined,
    });
  });

  it('translates unshelve (no --keep) to stash pop', () => {
    expect(translate(['unshelve', '--name', 'wip'])).toEqual({
      args: ['stash', 'pop'],
      stdin: undefined,
    });
  });
});
```

**Step 2: Run to verify it fails**

```bash
cd /Users/jesselupica/Projects/champagne/isl-server
yarn test --testPathPattern=GitDriverTranslations
```

**Step 3: Add server translation**

```typescript
if (args[0] === 'shelve') {
  if (args[1] === '--delete') {
    return {args: ['stash', 'drop'], stdin};
  }
  const out: string[] = ['stash', 'push'];
  let name: string | undefined;
  const files: string[] = [];
  for (let i = 1; i < args.length; i++) {
    if (args[i] === '--unknown') { out.push('-u'); continue; }
    if (args[i] === '--name' && i + 1 < args.length) { name = args[++i]; continue; }
    files.push(args[i]);
  }
  if (name) out.push('-m', name);
  if (files.length > 0) out.push('--', ...files);
  return {args: out, stdin};
}
if (args[0] === 'unshelve') {
  const keep = args.includes('--keep');
  return {args: ['stash', keep ? 'apply' : 'pop'], stdin};
}
```

**Step 4: Run to verify tests pass**

```bash
cd /Users/jesselupica/Projects/champagne/isl-server
yarn test --testPathPattern=GitDriverTranslations
```

**Step 5: Add frontend display translation**

```typescript
if (first === 'shelve') {
  if (args[1] === '--delete') return ['stash', 'drop'];
  const out: typeof args = ['stash', 'push'];
  let name: typeof args[0] | undefined;
  const files: typeof args = [];
  for (let i = 1; i < args.length; i++) {
    const a = args[i];
    if (a === '--unknown') { out.push('-u'); continue; }
    if (a === '--name' && i + 1 < args.length) { name = args[i + 1]; i++; continue; }
    files.push(a);
  }
  if (name !== undefined) out.push('-m', name);
  if (files.length > 0) out.push('--', ...files);
  return out;
}
if (first === 'unshelve') {
  return ['stash', args.includes('--keep') ? 'apply' : 'pop'];
}
```

**Step 6: Commit**

```bash
git add isl-server/src/vcs/GitDriver.ts isl/src/CommandHistoryAndProgress.tsx isl-server/src/__tests__/GitDriverTranslations.test.ts
git commit -m "feat: translate shelve/unshelve to git stash push/pop"
```

---

## Task 10: `graft` and `uncommit`

**Sapling:** `sl graft HASH` → cherry-pick a commit
**Git:** `git cherry-pick HASH`

**Sapling:** `sl uncommit` → pop HEAD back to working directory
**Git:** `git reset --soft HEAD~1`

**Files:**
- Modify: `isl-server/src/vcs/GitDriver.ts`
- Modify: `isl/src/CommandHistoryAndProgress.tsx`
- Test: `isl-server/src/__tests__/GitDriverTranslations.test.ts`

**Step 1: Write the failing test**

```typescript
describe('graft', () => {
  it('translates graft HASH to cherry-pick HASH', () => {
    expect(translate(['graft', 'abc123'])).toEqual({
      args: ['cherry-pick', 'abc123'],
      stdin: undefined,
    });
  });
});

describe('uncommit', () => {
  it('translates uncommit to reset --soft HEAD~1', () => {
    expect(translate(['uncommit'])).toEqual({
      args: ['reset', '--soft', 'HEAD~1'],
      stdin: undefined,
    });
  });
});
```

**Step 2: Run to verify it fails**

```bash
cd /Users/jesselupica/Projects/champagne/isl-server
yarn test --testPathPattern=GitDriverTranslations
```

**Step 3: Add server translation**

```typescript
if (args[0] === 'graft') {
  return {args: ['cherry-pick', ...args.slice(1)], stdin};
}
if (args[0] === 'uncommit') {
  return {args: ['reset', '--soft', 'HEAD~1'], stdin};
}
```

**Step 4: Run to verify tests pass**

```bash
cd /Users/jesselupica/Projects/champagne/isl-server
yarn test --testPathPattern=GitDriverTranslations
```

**Step 5: Add frontend display translation**

```typescript
if (first === 'graft') return ['cherry-pick', ...args.slice(1)];
if (first === 'uncommit') return ['reset', '--soft', 'HEAD~1'];
```

**Step 6: Commit**

```bash
git add isl-server/src/vcs/GitDriver.ts isl/src/CommandHistoryAndProgress.tsx isl-server/src/__tests__/GitDriverTranslations.test.ts
git commit -m "feat: translate graft→cherry-pick, uncommit→reset --soft HEAD~1"
```

---

## Task 11: `resolve` and `continue`

**Sapling:** `sl resolve --mark file.txt` → mark conflict resolved
**Git:** `git add file.txt`

**Sapling:** `sl resolve --unmark file.txt` → mark conflict unresolved
**Git:** `git rm --cached file.txt` (same as forget, removes from index)

**Sapling:** `sl continue` → continue after resolving conflicts
**Git:** `git rebase --continue` (covers the most common case; cherry-pick/merge --continue are equivalent in terms of UI usage)

**Files:**
- Modify: `isl-server/src/vcs/GitDriver.ts`
- Modify: `isl/src/CommandHistoryAndProgress.tsx`
- Test: `isl-server/src/__tests__/GitDriverTranslations.test.ts`

**Step 1: Write the failing test**

```typescript
describe('resolve', () => {
  it('translates resolve --mark file to add file', () => {
    expect(translate(['resolve', '--mark', 'conflict.txt'])).toEqual({
      args: ['add', 'conflict.txt'],
      stdin: undefined,
    });
  });

  it('translates resolve --unmark file to rm --cached file', () => {
    expect(translate(['resolve', '--unmark', 'conflict.txt'])).toEqual({
      args: ['rm', '--cached', 'conflict.txt'],
      stdin: undefined,
    });
  });
});

describe('continue', () => {
  it('translates continue to rebase --continue', () => {
    expect(translate(['continue'])).toEqual({
      args: ['rebase', '--continue'],
      stdin: undefined,
    });
  });
});
```

**Step 2: Run to verify it fails**

```bash
cd /Users/jesselupica/Projects/champagne/isl-server
yarn test --testPathPattern=GitDriverTranslations
```

**Step 3: Add server translation**

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
  // resolve --tool internal:dumpjson --all (used for conflict detection, not a user action)
  return {args, stdin};
}
if (args[0] === 'continue') {
  return {args: ['rebase', '--continue'], stdin};
}
```

**Step 4: Run to verify tests pass**

```bash
cd /Users/jesselupica/Projects/champagne/isl-server
yarn test --testPathPattern=GitDriverTranslations
```

**Step 5: Add frontend display translation**

```typescript
if (first === 'resolve') {
  if (args.includes('--mark')) {
    return ['add', ...args.filter(a => a !== 'resolve' && a !== '--mark')];
  }
  if (args.includes('--unmark')) {
    return ['rm', '--cached', ...args.filter(a => a !== 'resolve' && a !== '--unmark')];
  }
  return args;
}
if (first === 'continue') return ['rebase', '--continue'];
```

**Step 6: Commit**

```bash
git add isl-server/src/vcs/GitDriver.ts isl/src/CommandHistoryAndProgress.tsx isl-server/src/__tests__/GitDriverTranslations.test.ts
git commit -m "feat: translate resolve/continue to git add/rebase --continue"
```

---

## Task 12: `purge`, `push`, and frontend display for already-translated operations

**`purge`:** `sl purge --files file.txt` — delete untracked files
**Git:** No direct equivalent; use shell `rm -f file.txt`. Return `__shell__` command.

**`push`:** `sl push --rev REV --to BRANCH REMOTE` → `git push REMOTE REV:BRANCH`
Currently passes through unchanged (git push syntax is similar enough for basic cases).

**Display-only fixes for fold/hide/pull-rev:** These already have server translations but no frontend display translations — add them to `translateArgsForDisplay`.

**Files:**
- Modify: `isl-server/src/vcs/GitDriver.ts`
- Modify: `isl/src/CommandHistoryAndProgress.tsx`
- Test: `isl-server/src/__tests__/GitDriverTranslations.test.ts`

**Step 1: Write the failing tests**

```typescript
describe('purge', () => {
  it('translates purge --files file to shell rm -f file', () => {
    const result = translate(['purge', '--files', '--abort-on-err', 'dead.txt']);
    expect(result.args[0]).toBe('__shell__');
    expect(result.args[1]).toContain('dead.txt');
  });
});

describe('push', () => {
  it('translates push --rev REV --to BRANCH REMOTE to push REMOTE REV:BRANCH', () => {
    expect(translate(['push', '--rev', 'abc123', '--to', 'main', 'origin'])).toEqual({
      args: ['push', 'origin', 'abc123:main'],
      stdin: undefined,
    });
  });
});
```

**Step 2: Run to verify it fails**

```bash
cd /Users/jesselupica/Projects/champagne/isl-server
yarn test --testPathPattern=GitDriverTranslations
```

**Step 3: Add server translation**

```typescript
if (args[0] === 'purge') {
  const files = args.filter(a => a !== 'purge' && a !== '--files' && a !== '--abort-on-err');
  const rmCmds = files.map(f => `rm -f "${f}"`).join(' && ');
  return {args: ['__shell__', rmCmds || 'true'], stdin};
}
if (args[0] === 'push') {
  let rev: string | undefined, branch: string | undefined, remote: string | undefined;
  for (let i = 1; i < args.length; i++) {
    if (args[i] === '--rev' && i + 1 < args.length) rev = args[++i];
    else if (args[i] === '--to' && i + 1 < args.length) branch = args[++i];
    else if (!args[i].startsWith('-')) remote = args[i];
  }
  if (rev && branch) {
    return {args: ['push', remote ?? 'origin', `${rev}:${branch}`], stdin};
  }
  return {args, stdin};
}
```

**Step 4: Add frontend display translations for fold/hide/pull-rev**

In `translateArgsForDisplay`, add:
```typescript
if (first === 'fold') {
  // fold --exact HASH1::HASH2 --message MSG → rebase -i BOTTOM^ (simplified)
  const exactIdx = args.indexOf('--exact');
  const revset = exactIdx !== -1 ? String(args[exactIdx + 1]) : '??';
  const bottom = revset.split('::')[0] ?? '??';
  return ['rebase', '-i', bottom + '^'];
}
if (first === 'hide') {
  const revIdx = args.indexOf('--rev');
  const hash = revIdx !== -1 ? args[revIdx + 1] : '??';
  return ['branch', '-D', '<branches-at-' + String(hash).slice(0, 8) + '>'];
}
if (first === 'pull' && args.includes('--rev')) {
  const revIdx = args.indexOf('--rev');
  const hash = revIdx !== -1 ? args[revIdx + 1] : '??';
  return ['fetch', 'origin', hash];
}
if (first === 'purge') {
  const files = args.filter(a => a !== 'purge' && a !== '--files' && a !== '--abort-on-err');
  return ['rm', '-f', ...files];
}
if (first === 'push') {
  let rev: typeof args[0] = '??', branch: typeof args[0] = '??', remote: typeof args[0] = 'origin';
  for (let i = 1; i < args.length; i++) {
    if (args[i] === '--rev' && i + 1 < args.length) { rev = args[i + 1]; i++; continue; }
    if (args[i] === '--to' && i + 1 < args.length) { branch = args[i + 1]; i++; continue; }
    if (typeof args[i] === 'string' && !String(args[i]).startsWith('-')) remote = args[i];
  }
  return ['push', remote, rev + ':' + branch];
}
```

**Step 5: Run tests**

```bash
cd /Users/jesselupica/Projects/champagne/isl-server
yarn test --testPathPattern=GitDriverTranslations
```
Expected: all PASS

**Step 6: Commit**

```bash
git add isl-server/src/vcs/GitDriver.ts isl/src/CommandHistoryAndProgress.tsx isl-server/src/__tests__/GitDriverTranslations.test.ts
git commit -m "feat: translate purge/push, add display translations for fold/hide/pull-rev"
```

---

## Task 13: Run full test suite and verify no regressions

**Step 1: Run server tests**

```bash
cd /Users/jesselupica/Projects/champagne/isl-server
yarn test 2>&1 | tail -20
```
Expected: all tests pass (no regressions in Repository.test.ts, RepositoryCache.test.ts, etc.)

**Step 2: Run client tests**

```bash
cd /Users/jesselupica/Projects/champagne/isl
yarn test 2>&1 | tail -20
```
Expected: all tests pass

**Step 3: TypeScript compile check**

```bash
cd /Users/jesselupica/Projects/champagne/isl-server && yarn build 2>&1 | tail -5
cd /Users/jesselupica/Projects/champagne/isl && npx tsc --noEmit 2>&1 | head -20
```
Expected: no TypeScript errors

**Step 4: Commit if any cleanup needed**

```bash
git commit -m "chore: fix any type errors from operation translations"
```

---

## Summary of All Translations

| Sapling command | Git command | Task |
|---|---|---|
| `commit --addremove ...` | `commit ...` (drop flag) | Task 2 |
| `amend --addremove --user A ...` | `commit --amend --author A ...` | Task 3 |
| `metaedit --rev H --user A --message M` | `commit --amend --author A --message M` | Task 4 |
| `goto --rev H` | `checkout H` | Task 5 |
| `goto --clean .` | `checkout -- .` | Task 5 |
| `revert --rev H files` | `checkout H -- files` | Task 6 |
| `rebase -s S -d D` | `rebase --onto D S^ S` | Task 7 |
| `rebase --keep --rev S --dest D` | `cherry-pick S` | Task 7 |
| `bookmark N --rev H` | `branch N H` | Task 8 |
| `bookmark --delete N` | `branch -d N` | Task 8 |
| `shelve --unknown --name N files` | `stash push -u -m N -- files` | Task 9 |
| `unshelve --keep --name N` | `stash apply` | Task 9 |
| `unshelve --name N` | `stash pop` | Task 9 |
| `shelve --delete N` | `stash drop` | Task 9 |
| `graft H` | `cherry-pick H` | Task 10 |
| `uncommit` | `reset --soft HEAD~1` | Task 10 |
| `resolve --mark F` | `add F` | Task 11 |
| `resolve --unmark F` | `rm --cached F` | Task 11 |
| `continue` | `rebase --continue` | Task 11 |
| `purge --files F` | shell: `rm -f F` | Task 12 |
| `push --rev R --to B REMOTE` | `push REMOTE R:B` | Task 12 |
| `forget F` *(already done)* | `rm --cached F` | — |
| `fold --exact ...` *(server done)* | `rebase -i BOTTOM^` display | Task 12 |
| `hide --rev H` *(server done)* | branch delete display | Task 12 |
| `pull --rev H` *(server done)* | `fetch origin H` display | Task 12 |
| `add F` | passes through unchanged | — |
| `rm F` | passes through unchanged | — |
| `pull` | passes through unchanged | — |
