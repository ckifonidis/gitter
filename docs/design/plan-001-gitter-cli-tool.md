# Plan 001: Gitter CLI Tool - Implementation Plan

## Plan Overview

Build **gitter**, a TypeScript CLI tool that maintains a persistent JSON registry of local git repositories. The tool enables users to scan, register, list, search, navigate to, inspect, and remove repositories from the registry. It is invoked from the command line and integrates with bash/zsh via a shell function wrapper for directory navigation.

**Target Stack**:
- CLI Framework: commander.js v14
- Interactive Selection: @inquirer/prompts v8
- Terminal Colors: picocolors v1
- Table Output: cli-table3 v0.6
- Git Interaction: Node.js built-in child_process.execFileSync
- File System: Node.js built-in fs module with atomic writes
- Module System: ESM ("type": "module")
- Build: tsx (dev), tsc (production)

**Production Dependencies**: 4 (commander, @inquirer/prompts, picocolors, cli-table3)
**Dev Dependencies**: 3 (typescript, tsx, @types/node)

---

## Implementation Phases

### Phase 1: Project Scaffolding

**Objective**: Set up the TypeScript project structure, configuration files, and install dependencies.

**Dependencies**: None (starting point)

**Tasks**:
1. Initialize the project with `npm init` inside `/Users/giorgosmarinos/aiwork/coding-platform/gitter/`
2. Configure `package.json` with `"type": "module"`, `bin` field pointing to `./dist/cli.js`, and npm scripts (`dev`, `build`, `start`, `typecheck`)
3. Create `tsconfig.json` with target ES2022, module Node16, moduleResolution Node16, strict mode, outDir `dist`, rootDir `src`
4. Install production dependencies: `commander`, `@inquirer/prompts`, `picocolors`, `cli-table3`
5. Install dev dependencies: `typescript`, `tsx`, `@types/node`
6. Create the `src/` directory structure
7. Create a minimal `src/cli.ts` entry point with shebang (`#!/usr/bin/env node`) that imports commander and defines a placeholder program

**Files to Create**:
- `package.json`
- `tsconfig.json`
- `src/cli.ts` (entry point, minimal)

**Acceptance Criteria**:
- `npx tsx src/cli.ts --help` prints help text without errors
- `npx tsc --noEmit` passes with zero errors
- `npm run build` produces `dist/cli.js` with shebang preserved

**Verification**:
```bash
cd /Users/giorgosmarinos/aiwork/coding-platform/gitter
npx tsx src/cli.ts --help
npx tsc --noEmit
npm run build && head -1 dist/cli.js  # should show #!/usr/bin/env node
```

---

### Phase 2: Core Data Layer (Registry + Git Utilities)

**Objective**: Implement the registry data types, file I/O with atomic writes, and git command wrapper functions.

**Dependencies**: Phase 1

**Parallelization**: The registry module (`src/registry.ts`) and git utilities module (`src/git.ts`) can be developed in parallel since they have no mutual dependencies.

**Tasks**:
1. **Create `src/types.ts`** -- Define TypeScript interfaces:
   - `RegistryEntry` (repoName, localPath, remotes[], remoteBranches[], localBranches[], currentBranch, lastUpdated)
   - `Remote` (name, fetchUrl, pushUrl)
   - `Registry` (version: number, repositories: RegistryEntry[])

2. **Create `src/registry.ts`** -- Registry file operations:
   - `getRegistryDir()`: returns `~/.gitter/`, throws if HOME is not set (no fallback)
   - `getRegistryPath()`: returns `~/.gitter/registry.json`
   - `ensureRegistryExists()`: creates `~/.gitter/` directory and empty registry file if missing
   - `loadRegistry()`: reads and parses the JSON file, validates structure, returns `Registry`
   - `saveRegistry(registry)`: atomic write (write-to-temp-then-rename pattern)
   - `findByPath(registry, path)`: find entry by local path
   - `addOrUpdate(registry, entry)`: upsert by localPath
   - `removeByPath(registry, path)`: remove entry by local path
   - `searchEntries(registry, query)`: case-insensitive partial match on repoName, localPath, and remote URLs

3. **Create `src/git.ts`** -- Git command utilities:
   - `git(args, cwd?)`: wrapper around `execFileSync('git', args, ...)` with timeout and error handling
   - `isInsideGitRepo(cwd?)`: boolean check using `git rev-parse --is-inside-work-tree`
   - `getRepoRoot(cwd?)`: returns absolute path via `git rev-parse --show-toplevel`
   - `getRemotes(cwd?)`: parses `git remote -v` output into `Remote[]` (deduplicating fetch/push)
   - `getLocalBranches(cwd?)`: parses `git branch --list` into string[]
   - `getRemoteBranches(cwd?)`: parses `git branch -r` into string[]
   - `getCurrentBranch(cwd?)`: uses `git rev-parse --abbrev-ref HEAD`
   - `collectRepoMetadata(cwd?)`: orchestrates all of the above into a `RegistryEntry`

**Files to Create**:
- `src/types.ts`
- `src/registry.ts`
- `src/git.ts`

**Acceptance Criteria**:
- `loadRegistry()` on a non-existent file creates the directory and returns an empty registry
- `saveRegistry()` writes valid JSON that can be read back identically
- `addOrUpdate()` creates a new entry and updates an existing entry (by localPath) without duplicates
- `searchEntries()` matches case-insensitively on name, path, and remote URLs
- `collectRepoMetadata()` returns correct data when run inside any git repo
- HOME not set causes a thrown error with a clear message
- Atomic write uses temp file + rename pattern

**Verification**:
```bash
# Test git utilities by running inside the gitter project (or any git repo)
cd /Users/giorgosmarinos/aiwork/coding-platform/gitter
npx tsx -e "import { isInsideGitRepo } from './src/git.js'; console.log(isInsideGitRepo())"
# Test registry by creating a temp entry
npx tsx -e "
import { ensureRegistryExists, loadRegistry, saveRegistry, addOrUpdate } from './src/registry.js';
ensureRegistryExists();
const reg = loadRegistry();
console.log('Registry version:', reg.version);
console.log('Entries:', reg.repositories.length);
"
```

---

### Phase 3: CLI Commands Implementation

**Objective**: Wire up all six commands using commander.js, connecting them to the core data layer.

**Dependencies**: Phase 2

**Parallelization**: Commands can be implemented in parallel by different developers, but since this is a single-agent task, implement them sequentially in the order: scan, list, search, go, info, remove. Each command lives in its own file under `src/commands/`.

**Tasks**:

1. **Create `src/commands/scan.ts`** -- `gitter scan` (also the default action when no subcommand and CWD is a git repo):
   - Check if CWD is inside a git repo; if not, print error to stderr and exit with code 1
   - Collect repo metadata via `collectRepoMetadata()`
   - Load registry, upsert entry, save registry
   - Print confirmation with repo name, path, number of remotes, number of branches
   - Check if localPath still exists for existing entries and mark stale ones (warning output)

2. **Create `src/commands/list.ts`** -- `gitter list`:
   - Load registry
   - If empty, print "No repositories registered" message
   - Otherwise, display a cli-table3 table with columns: Repo Name, Local Path, Remotes, Last Updated
   - Mark entries whose localPath no longer exists on disk as "[MISSING]" (per Open Question 3 recommendation)
   - Use picocolors for headers and status coloring

3. **Create `src/commands/search.ts`** -- `gitter search <query>`:
   - Load registry
   - Filter using `searchEntries()`
   - Display matching repos in table format (same as list)
   - If no matches, print "No repositories match query: <query>"

4. **Create `src/commands/go.ts`** -- `gitter go <query>`:
   - Load registry, search for matches
   - If exactly one match: print ONLY the localPath to stdout (nothing else to stdout)
   - If multiple matches: use `@inquirer/prompts` `select` to let user choose (prompts go to stderr), then print selected path to stdout
   - If no match: print error to stderr, exit with code 1
   - If selected path does not exist on disk: print error to stderr, exit with code 1
   - CRITICAL: maintain strict stdout/stderr separation for shell function integration

5. **Create `src/commands/info.ts`** -- `gitter info <query>`:
   - Load registry, search for matches
   - If multiple matches, use interactive select
   - Display full metadata: repo name, local path, all remotes (name, fetch URL, push URL), all local branches, all remote branches, current branch, last updated
   - Use picocolors for section headers and formatting

6. **Create `src/commands/remove.ts`** -- `gitter remove <query>`:
   - Load registry, search for matches
   - If multiple matches, use interactive select to choose which to remove
   - Confirm removal with user (y/n prompt)
   - Remove entry, save registry
   - Print confirmation message

7. **Create `src/commands/init.ts`** -- `gitter init`:
   - Print the shell function wrapper for bash/zsh to stdout
   - Print installation instructions (add to ~/.zshrc or ~/.bashrc)

8. **Update `src/cli.ts`** -- Wire all commands into the commander program:
   - Define `scan`, `list`, `search`, `go`, `info`, `remove`, `init` subcommands
   - Set default action (no subcommand): if inside a git repo, run scan; otherwise, show help
   - Set program version, description

**Files to Create**:
- `src/commands/scan.ts`
- `src/commands/list.ts`
- `src/commands/search.ts`
- `src/commands/go.ts`
- `src/commands/info.ts`
- `src/commands/remove.ts`
- `src/commands/init.ts`

**Files to Modify**:
- `src/cli.ts` (wire up all commands)

**Acceptance Criteria**:
- `gitter scan` inside a git repo creates/updates a registry entry and prints confirmation
- `gitter scan` outside a git repo prints error to stderr and exits with code 1
- `gitter list` shows all registered repos in a formatted table
- `gitter list` marks repos with missing paths as "[MISSING]"
- `gitter search <query>` filters correctly (case-insensitive, partial match on name/path/URL)
- `gitter go <name>` prints exactly one line (the path) to stdout when one match exists
- `gitter go <ambiguous>` shows interactive select via stderr, prints selected path to stdout
- `gitter info <name>` shows full metadata for a repo
- `gitter remove <name>` removes the entry and confirms
- `gitter init` prints the shell function wrapper
- Running with no arguments inside a git repo performs a scan
- Running with no arguments outside a git repo shows help

**Verification**:
```bash
cd /Users/giorgosmarinos/aiwork/coding-platform/gitter

# Test scan
npx tsx src/cli.ts scan
cat ~/.gitter/registry.json | head -20

# Test list
npx tsx src/cli.ts list

# Test search
npx tsx src/cli.ts search gitter

# Test info
npx tsx src/cli.ts info gitter

# Test go (capture stdout)
TARGET=$(npx tsx src/cli.ts go gitter 2>/dev/null)
echo "Target: $TARGET"

# Test remove (will prompt)
# npx tsx src/cli.ts remove gitter

# Test init
npx tsx src/cli.ts init

# Test outside git repo
cd /tmp && npx tsx /Users/giorgosmarinos/aiwork/coding-platform/gitter/src/cli.ts scan 2>&1; echo "Exit code: $?"

# Test missing HOME
# HOME= npx tsx src/cli.ts list 2>&1; echo "Exit code: $?"
```

---

### Phase 4: Build, Link, and Shell Integration

**Objective**: Produce a production build, make the tool globally available via `npm link`, and verify the shell function wrapper works end-to-end.

**Dependencies**: Phase 3

**Tasks**:
1. Run `npm run build` to compile TypeScript to `dist/`
2. Verify the shebang is present in `dist/cli.js`
3. Run `npm link` to make `gitter` globally available
4. Test all commands using the global `gitter` command (not tsx)
5. Test the shell function wrapper by sourcing it and running `gitter go`
6. Verify `gitter init` output is a valid, copy-paste-ready shell function

**Files to Modify**:
- None (build artifacts only)

**Acceptance Criteria**:
- `npm run build` succeeds with zero errors
- `gitter --version` prints the version
- `gitter scan`, `gitter list`, `gitter search`, `gitter go`, `gitter info`, `gitter remove`, `gitter init` all work as the globally linked command
- The shell function from `gitter init`, when sourced, allows `gitter go <name>` to actually change the shell's working directory

**Verification**:
```bash
cd /Users/giorgosmarinos/aiwork/coding-platform/gitter
npm run build
npm link
gitter --version
gitter --help

# Test full flow
cd /some/git/repo
gitter scan
gitter list
gitter search repo-name
gitter info repo-name

# Test shell function
eval "$(gitter init)"
gitter go repo-name
pwd  # should be the repo's path
```

---

### Phase 5: Documentation and Cleanup

**Objective**: Document the tool in the parent project's CLAUDE.md, create the Issues file, and ensure all conventions are followed.

**Dependencies**: Phase 4

**Tasks**:
1. Update `/Users/giorgosmarinos/aiwork/coding-platform/macbook-desktop/CLAUDE.md` with gitter tool documentation in XML format
2. Create `/Users/giorgosmarinos/aiwork/coding-platform/gitter/Issues - Pending Items.md`
3. Create `/Users/giorgosmarinos/aiwork/coding-platform/gitter/docs/design/project-design.md` with architecture overview
4. Verify all test scripts are in `test_scripts/` folder
5. Final typecheck pass: `npx tsc --noEmit`

**Files to Create/Modify**:
- `/Users/giorgosmarinos/aiwork/coding-platform/macbook-desktop/CLAUDE.md` (add gitter tool docs)
- `/Users/giorgosmarinos/aiwork/coding-platform/gitter/Issues - Pending Items.md`
- `/Users/giorgosmarinos/aiwork/coding-platform/gitter/docs/design/project-design.md`

**Acceptance Criteria**:
- CLAUDE.md contains gitter documentation in the XML tool format
- Issues file exists and is properly structured
- project-design.md captures the architecture
- `npx tsc --noEmit` passes

---

## File Manifest

All files relative to `/Users/giorgosmarinos/aiwork/coding-platform/gitter/`:

### New Files to Create

| File | Phase | Purpose |
|------|-------|---------|
| `package.json` | 1 | Project configuration, dependencies, scripts, bin field |
| `tsconfig.json` | 1 | TypeScript compiler configuration |
| `src/cli.ts` | 1, 3 | CLI entry point with commander program definition |
| `src/types.ts` | 2 | TypeScript interfaces (Registry, RegistryEntry, Remote) |
| `src/registry.ts` | 2 | Registry file I/O, search, CRUD operations |
| `src/git.ts` | 2 | Git command wrapper and metadata collection |
| `src/commands/scan.ts` | 3 | Scan/register current repo |
| `src/commands/list.ts` | 3 | List all registered repos |
| `src/commands/search.ts` | 3 | Search/filter repos |
| `src/commands/go.ts` | 3 | Navigate to a repo (output path to stdout) |
| `src/commands/info.ts` | 3 | Show detailed repo info |
| `src/commands/remove.ts` | 3 | Remove a repo from registry |
| `src/commands/init.ts` | 3 | Print shell function wrapper |
| `docs/design/project-design.md` | 5 | Architecture documentation |
| `docs/design/project-functions.md` | Pre-plan | Functional requirements |
| `Issues - Pending Items.md` | 5 | Issue tracking |

### Files to Modify

| File | Phase | Change |
|------|-------|--------|
| `/Users/giorgosmarinos/aiwork/coding-platform/macbook-desktop/CLAUDE.md` | 5 | Add gitter tool documentation in XML format |

### Runtime Artifacts (generated, not committed)

| Path | Purpose |
|------|---------|
| `dist/` | Compiled JavaScript output from tsc |
| `node_modules/` | npm dependencies |
| `~/.gitter/registry.json` | User's registry file |

---

## Risk Assessment

### Risk 1: Shell Function Compatibility
**Risk**: The shell function wrapper may not work correctly across all zsh/bash configurations (e.g., nounset mode, custom PATH).
**Impact**: Medium -- the `go` command is a core feature.
**Mitigation**: Test with both bash and zsh. Use `command gitter` to avoid recursion. Handle edge cases (empty output, non-existent directory). Document known limitations.

### Risk 2: Git Command Output Parsing
**Risk**: Git command output format may vary across git versions (e.g., `git remote -v` output, branch name formatting).
**Impact**: Medium -- incorrect parsing leads to wrong registry data.
**Mitigation**: Test with the git version installed on the target macOS. Use robust parsing (trim whitespace, handle empty output, handle detached HEAD). Pin to well-documented git porcelain commands.

### Risk 3: Concurrent Registry Access
**Risk**: If two gitter instances run simultaneously (unlikely but possible), the registry could become corrupted.
**Impact**: Low -- single-user CLI tool, unlikely scenario.
**Mitigation**: Atomic writes (write-temp-then-rename) prevent partial writes. File locking can be added later if needed.

### Risk 4: Large Registry Performance
**Risk**: If a user registers hundreds of repositories, JSON parsing/writing could become slow.
**Impact**: Low -- even 1000 entries would be under 1MB of JSON.
**Mitigation**: JSON is sufficient for the expected scale. If performance becomes an issue, consider lazy loading or indexing in a future version.

### Risk 5: ESM Module Compatibility
**Risk**: cli-table3 is CJS-only; mixing with ESM project could cause import issues.
**Impact**: Medium -- build or runtime failure.
**Mitigation**: Use `"module": "Node16"` and `"moduleResolution": "Node16"` in tsconfig, which handles CJS/ESM interop. Test the import early in Phase 1. If needed, use dynamic `import()` or the `esModuleInterop` flag (already enabled).

### Risk 6: Missing PATH for Stale Entries
**Risk**: Registered repos may be moved or deleted, making localPath invalid.
**Impact**: Low -- cosmetic issue.
**Mitigation**: Check `existsSync(localPath)` in `list` and `go` commands. Mark missing repos in list output. Prevent `go` from navigating to non-existent paths.

---

## Verification Checklist

After all phases are complete, the following must pass:

1. **Type Safety**: `npx tsc --noEmit` exits with code 0
2. **Build**: `npm run build` produces `dist/cli.js` with shebang
3. **Global Install**: `npm link` makes `gitter` available globally
4. **AC-1 (Registration)**: `gitter scan` inside a multi-remote repo creates correct entry
5. **AC-2 (Update)**: Re-running `gitter scan` after branch changes updates without duplicates
6. **AC-3 (List)**: `gitter list` displays all repos correctly
7. **AC-4 (Search)**: `gitter search <partial>` returns correct filtered results
8. **AC-5 (Navigation)**: Shell function + `gitter go` changes CWD
9. **AC-6 (Removal)**: `gitter remove` removes entry, confirmed by `gitter list`
10. **AC-7 (Non-Git)**: `gitter scan` in non-git dir prints error, exits non-zero
11. **AC-8 (Missing HOME)**: Unsetting HOME causes clear error
12. **Stale Detection**: `gitter list` marks moved/deleted repos as [MISSING]
13. **stdout/stderr Discipline**: `gitter go <name> 2>/dev/null` outputs only the path
