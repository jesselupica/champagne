# Champagne Implementation Plan

This document details the implementation strategy for extracting the VCS abstraction layer from ISL's Sapling-coupled codebase.

**Prerequisites**: [VCS Driver Specification](spec.md) must be approved before implementation begins.

---

## Phase 2: Refactor ISL Server

### Step 2.1: Create VCS Driver Interface and Types

**Goal**: Define the TypeScript interfaces and types that all drivers must implement.

**Files to create**:
- `isl-server/src/vcs/VCSDriver.ts` - Core interface (from spec.md)
- `isl-server/src/vcs/types.ts` - Supporting types (capabilities, watch config, exec params)
- `isl-server/src/vcs/index.ts` - Barrel export

**Tasks**:

1. Create `isl-server/src/vcs/` directory
2. Translate the interface from `docs/spec.md` into TypeScript files
3. Import existing types (`CommitInfo`, `ChangedFile`, etc.) from shared types
4. Define new types that don't exist yet (`VCSCapabilities`, `WatchConfig`, `ExecParams`, `ResolvedCommand`)
5. Export everything from `index.ts`

**Verification**: TypeScript compiles without errors. No runtime changes.

---

### Step 2.2: Extract Sapling Logic into SaplingDriver

**Goal**: Move all Sapling-specific code from Repository.ts, commands.ts, and templates.ts into a single SaplingDriver class.

**Files to create**:
- `isl-server/src/vcs/SaplingDriver.ts`

**Files to extract from**:
- `isl-server/src/Repository.ts` (primary)
- `isl-server/src/commands.ts`
- `isl-server/src/templates.ts`

**Extraction mapping**:

| Source Method (Repository.ts) | Target Method (SaplingDriver) |
|---|---|
| `getRepoInfo()` (static, line 516) | `validateRepo()` |
| `getCwdInfo()` (static, line 603) | (stays in Repository - VCS agnostic) |
| `fetchSmartlogCommits()` (line 969) | `fetchCommits()` |
| `fetchUncommittedChanges()` (line 880) | `fetchStatus()` |
| `checkForMergeConflicts()` (line 399) | `checkMergeConflicts()` |
| `lookupCommits()` (line 1367) | `lookupCommits()` |
| `cat()` (line 1212) | `getFileContents()` |
| `blame()` (line 1226) | `getBlame()` |
| `runDiff()` (line 1614) | `getDiff()` |
| `getAllChangedFiles()` (line 1531) | `getChangedFiles()` |
| `getShelvedChanges()` (line 1565) | `getShelvedChanges()` |
| `fetchSignificantLinesOfCode()` (line 1412) | `getDiffStats()` |
| `getConfig()` (line 1670) | `getConfig()` |
| `setConfig()` (line 1711) | `setConfig()` |
| `getMergeTool()` (line 474) | `getMergeTool()` |
| `getMergeToolEnvVars()` (line 833) | `getMergeToolEnvVars()` |
| `fetchSubmoduleMap()` (line 1173) | `fetchSubmodules()` |
| `getActiveAlerts()` (line 1588) | `getActiveAlerts()` |
| `getRagePaste()` (line 1605) | `collectDebugInfo()` |
| `getCommitCloudState()` (line 1264) | `getCommitCloudState()` |

| Source (commands.ts) | Target (SaplingDriver) |
|---|---|
| `findRoot()` (line 98) | `findRoot()` |
| `findRoots()` (line 120) | `findRoots()` |
| `findDotDir()` (line 129) | `findDotDir()` |
| `getConfigs()` (line 144) | `getConfigs()` |
| `setConfig()` (line 177) | `setConfig()` |
| `getExecParams()` (line 186) | `getExecParams()` |

| Source (templates.ts) | Target (SaplingDriver) |
|---|---|
| `mainFetchTemplateFields()` | Private method for commit template |
| `getMainFetchTemplate()` | Private method for template assembly |
| `parseCommitInfoOutput()` | Private method for output parsing |
| `SHELVE_FETCH_TEMPLATE` | Private constant |
| `parseShelvedCommitsOutput()` | Private method |

**Approach**: Copy-then-delegate pattern:

1. Copy each method's implementation into SaplingDriver
2. Update Repository.ts method to delegate to `this.driver.methodName()`
3. Keep the old method as a thin wrapper during transition
4. Once all methods are migrated, remove the old code

**Example (before)**:
```typescript
// Repository.ts
async fetchSmartlogCommits() {
  const fetchStartTimestamp = Date.now();
  const result = await this.serializedFetchSmartlog(async () => {
    const revset = buildSmartlogRevset(/* ... */);
    const proc = await this.runCommand(['log', '--template', getMainFetchTemplate(/* ... */), '--rev', revset], /* ... */);
    return parseCommitInfoOutput(/* ... */);
  });
  // ...
}
```

**Example (after)**:
```typescript
// Repository.ts
async fetchSmartlogCommits() {
  const fetchStartTimestamp = Date.now();
  const result = await this.serializedFetchSmartlog(async () => {
    return this.driver.fetchCommits(this.ctx, {
      maxDraftDays: this.visibleCommitRanges,
      stableLocations: this.stableLocations,
      recommendedBookmarks: this.recommendedBookmarks,
    });
  });
  // ...
}

// SaplingDriver.ts
async fetchCommits(ctx: RepositoryContext, options: FetchCommitsOptions): Promise<FetchedCommits> {
  const revset = this.buildSmartlogRevset(options);
  const template = this.getMainFetchTemplate();
  const proc = await runCommand(ctx, ['log', '--template', template, '--rev', revset], /* ... */);
  return {
    commits: { value: this.parseCommitInfoOutput(proc.stdout) },
    fetchStartTimestamp: Date.now(),
    fetchCompletedTimestamp: Date.now(),
  };
}
```

**Verification**: All existing tests pass. ISL works identically with SaplingDriver.

---

### Step 2.3: Refactor Repository.ts to Use VCSDriver

**Goal**: Make Repository.ts VCS-agnostic by delegating all VCS calls to the driver.

**File to modify**: `isl-server/src/Repository.ts`

**Changes**:

1. Add `driver: VCSDriver` parameter to constructor
2. Replace all direct VCS calls with driver delegations
3. Replace hardcoded `'sl'` references with `this.driver.command`
4. Move template imports out (now inside SaplingDriver)

**Constructor change**:

```typescript
// Before
constructor(info: ValidatedRepoInfo, ctx: RepositoryContext) {
  // ...
}

// After
constructor(info: ValidatedRepoInfo, ctx: RepositoryContext, driver: VCSDriver) {
  this.driver = driver;
  // ...
}
```

**Specific replacements**:

| Current Code | Replacement |
|---|---|
| `runCommand(ctx, ['log', '--template', ...])` | `this.driver.fetchCommits(ctx, options)` |
| `runCommand(ctx, ['status', '-Tjson', '--copies'])` | `this.driver.fetchStatus(ctx)` |
| `runCommand(ctx, ['resolve', '--tool', 'internal:dumpjson', '--all'])` | `this.driver.checkMergeConflicts(ctx)` |
| `runCommand(ctx, ['cat', path, '--rev', rev])` | `this.driver.getFileContents(ctx, path, rev)` |
| `getExecParams(ctx)` | `this.driver.getExecParams(ctx)` |
| `HGMERGE=:merge3` env var | `this.driver.getMergeToolEnvVars()` |

**Verification**: All existing tests pass. ISL works identically.

---

### Step 2.4: Refactor WatchForChanges

**Goal**: Remove hardcoded Sapling watch paths. Use driver's watch config.

**File to modify**: `isl-server/src/WatchForChanges.ts`

**Changes**:

1. Accept `WatchConfig` in constructor instead of hardcoded constants
2. Replace `WATCHMAN_DEFER = 'hg.update'` with `config.watchmanDefers`
3. Replace `'sapling-smartlog-dirstate-change'` with `config.subscriptionPrefix + '-dirstate-change'`
4. Replace hardcoded file list `['bookmarks.current', 'bookmarks', 'dirstate', 'merge']` with `config.dirstateFiles`
5. Replace EdenFS-specific logic with `config.supportsEdenFs` check

**Verification**: File watching works for Sapling repos. No functional change.

---

### Step 2.5: Refactor ServerToClientAPI and RepositoryCache

**Goal**: Integrate driver detection into the server startup flow.

**Files to create**:
- `isl-server/src/vcs/detectDriver.ts`

**Files to modify**:
- `isl-server/src/ServerToClientAPI.ts`
- `isl-server/src/RepositoryCache.ts`

**Changes to ServerToClientAPI.ts**:

In `setActiveRepoForCwd()` (line 167):

```typescript
// Before
const command = this.connection.command ?? 'sl';
const ctx: RepositoryContext = { cwd: newCwd, cmd: command, /* ... */ };

// After
const driver = await detectDriver({ cwd: newCwd, cmd: 'auto', /* ... */ });
const ctx: RepositoryContext = { cwd: newCwd, cmd: driver.command, /* ... */ };
```

**Changes to RepositoryCache.ts**:

In `getOrCreate()` (line 138):

```typescript
// Before
const repoInfo = await this.RepositoryType.getRepoInfo(ctx);
return new this.RepositoryType(repoInfo, ctx);

// After
const driver = await detectDriver(ctx);
const repoInfo = await driver.validateRepo(ctx);
return new this.RepositoryType(repoInfo, ctx, driver);
```

**Changes to commands.ts**:

- `getExecParams()` becomes a thin wrapper that calls `driver.getExecParams()`
- `findRoot()`, `findRoots()`, `findDotDir()` remain as standalone utilities (used during detection before a driver exists)

**Verification**: ISL starts up and auto-detects Sapling repos. No functional change.

---

### Step 2.6: Resolve Stack and Cloud Operations

**Goal**: Handle Sapling-specific operations that run through ServerToClientAPI directly.

**File to modify**: `isl-server/src/ServerToClientAPI.ts`

**Changes**:

In `handleIncomingMessageWithRepo()`, wrap Sapling-specific handlers with capability checks:

```typescript
case 'exportStack': {
  if (!driver.exportStack) {
    this.postMessage({ type: 'error', message: 'Stack operations not supported' });
    break;
  }
  const result = await driver.exportStack(ctx, data.revs, data.assumeTracked);
  // ...
}
```

Operations that need this treatment:
- `exportStack` / `importStack` (lines 934-969)
- Commit cloud operations (various handlers)
- `getRepoUrlAtHash` (line 1178 - uses `sl url`)

**Verification**: Stack editing and commit cloud features work for Sapling. Non-Sapling repos gracefully report unsupported.

---

## Phase 3: Implement Additional VCS Drivers

### Step 3.1: Git Driver

**File to create**: `isl-server/src/vcs/GitDriver.ts`

**Capabilities**:

```typescript
capabilities: {
  smartlog: false,           // Git has no smartlog; use branch-based view
  commitPhases: false,       // Git has no public/draft phases
  bookmarks: true,           // Git branches ≈ bookmarks
  amend: true,               // git commit --amend (HEAD only)
  partialCommit: true,       // git add --patch
  partialAmend: true,        // git add --patch + git commit --amend
  rebase: true,              // git rebase
  fold: true,                // git reset --soft + commit
  hide: false,               // no native equivalent
  shelve: true,              // git stash
  graft: true,               // git cherry-pick
  goto: true,                // git checkout / git switch
  stackOperations: false,    // no debugimportstack equivalent
  commitCloud: false,        // no commit cloud
  submodules: true,          // native git submodules
  alerts: false,             // no alerts system
  debugInfo: false,          // no rage equivalent
  mutationTracking: false,   // no mutation tracking
  push: true,
  pullRevision: false,       // can't pull individual commits
  submitCommands: [],        // depends on setup
}
```

**Key implementation challenges**:

1. **Commit graph**: Use `git log --all --graph --format=<custom>` to build commit graph. Since Git has no smartlog, show recent branches (last N days of commits across all branches).

2. **Commit phases**: Map to `remote-tracking` (public) vs `local-only` (draft) by checking if commits are reachable from any `refs/remotes/` ref.

3. **Bookmarks ↔ Branches**: Map Sapling bookmarks to Git branches. `remoteBookmarks` → `refs/remotes/origin/*`.

4. **Amend non-HEAD commits**: Git can only `--amend` HEAD. For non-HEAD amendments, need interactive rebase or warn unsupported.

5. **Rebase**: Translate `-s <source> -d <dest>` to `git rebase --onto <dest> <source>^ <branch>`.

6. **File watching**: Watch `.git/HEAD`, `.git/index`, `.git/refs/` for changes.

### Step 3.2: Graphite Driver

**File to create**: `isl-server/src/vcs/GraphiteDriver.ts`

**Approach**: Extend GitDriver with Graphite-specific enhancements.

```typescript
class GraphiteDriver extends GitDriver {
  readonly name = 'Graphite';
  readonly command = 'gt';

  // Override to use Graphite's stack-aware commands
  async fetchCommits(ctx, options) {
    // Use `gt log --json` for better stack visualization
  }
}
```

**Graphite-specific advantages**:
- `gt log --json` provides stack-aware commit graph
- `gt restack` for rebasing (simpler than git rebase)
- `gt submit` for PR submission
- `gt sync` for pulling

### Step 3.3: Git Branchless Driver

**File to create**: `isl-server/src/vcs/GitBranchlessDriver.ts`

**Approach**: Extend GitDriver with git-branchless enhancements.

```typescript
class GitBranchlessDriver extends GitDriver {
  readonly name = 'Git Branchless';
  readonly command = 'git';  // Uses git with extensions

  capabilities = {
    ...super.capabilities,
    smartlog: true,        // git-branchless has smartlog!
    hide: true,            // git-branchless has hide
    mutationTracking: true, // git-branchless tracks mutations
  };
}
```

**Git Branchless advantages**:
- `git smartlog` provides native smartlog output
- `git move` for rebasing (closer to Sapling semantics)
- `git hide`/`git unhide` for commit visibility
- Mutation tracking for predecessor/successor info

---

## Phase 4: Testing Strategy

### Unit Tests

For each driver, test:
1. `findRoot()` - detects repo correctly
2. `validateRepo()` - returns correct RepoInfo
3. `fetchCommits()` - returns valid CommitInfo array
4. `fetchStatus()` - returns correct file statuses
5. `resolveOperationArgs()` - correctly maps abstract args to CLI args
6. `getExecParams()` - returns correct environment

**Test structure**:
```
isl-server/src/__tests__/
  vcs/
    SaplingDriver.test.ts
    GitDriver.test.ts
    GraphiteDriver.test.ts
    detectDriver.test.ts
```

### Integration Tests

Test the full flow through Repository.ts → VCSDriver:
1. Start ISL in a Sapling repo → SaplingDriver detected, all features work
2. Start ISL in a Git repo → GitDriver detected, limited features shown
3. Run each operation type through the driver pipeline
4. Verify file watching triggers correct refreshes

### Regression Tests

1. All existing ISL tests must pass without modification
2. Run the existing test suite against SaplingDriver to verify behavioral equivalence
3. No UI changes should be needed

---

## Migration Checklist

### Pre-implementation
- [ ] VCS Driver spec approved (docs/spec.md)
- [ ] All documentation complete (manifest, plan)

### Step 2.1: Interface creation
- [ ] `isl-server/src/vcs/VCSDriver.ts` created
- [ ] `isl-server/src/vcs/types.ts` created
- [ ] TypeScript compiles

### Step 2.2: SaplingDriver extraction
- [ ] `isl-server/src/vcs/SaplingDriver.ts` created
- [ ] All methods from Repository.ts delegated
- [ ] Templates moved to SaplingDriver
- [ ] All tests pass

### Step 2.3: Repository.ts refactor
- [ ] Constructor accepts VCSDriver
- [ ] All VCS calls go through driver
- [ ] No hardcoded 'sl' references remain
- [ ] All tests pass

### Step 2.4: WatchForChanges refactor
- [ ] Uses WatchConfig from driver
- [ ] No hardcoded Sapling paths
- [ ] File watching works

### Step 2.5: Server integration
- [ ] detectDriver.ts created
- [ ] ServerToClientAPI uses driver detection
- [ ] RepositoryCache passes driver
- [ ] ISL starts correctly

### Step 2.6: Capability-gated operations
- [ ] Stack operations check capabilities
- [ ] Cloud operations check capabilities
- [ ] Graceful degradation for unsupported operations

### Step 3.1: Git Driver
- [ ] GitDriver.ts created
- [ ] Basic operations work (commit, amend, rebase, goto)
- [ ] File watching works for .git
- [ ] Tests pass

### Step 3.2: Graphite Driver
- [ ] GraphiteDriver.ts created
- [ ] Stack-aware features work
- [ ] Submit flow works

### Step 3.3: Git Branchless Driver
- [ ] GitBranchlessDriver.ts created
- [ ] Smartlog works
- [ ] Hide/unhide work
- [ ] Move (rebase) works

### Final
- [ ] All drivers pass their test suites
- [ ] No regressions in Sapling functionality
- [ ] Documentation updated
- [ ] Feature parity matrix documented
