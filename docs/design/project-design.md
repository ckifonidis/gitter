# Gitter CLI Tool - Technical Design

## Document Info

| Field | Value |
|-------|-------|
| Project | gitter |
| Version | 1.0.0 |
| Date | 2026-03-22 |
| Status | Design Complete |
| Based On | plan-001-gitter-cli-tool.md, investigation-gitter-cli-tool.md, refined-request-gitter-repo-registry.md |

---

## 1. System Architecture

### 1.1 Component Diagram

```
+------------------------------------------------------------------+
|                         USER SHELL (zsh/bash)                     |
|                                                                   |
|  gitter() {           <-- shell function (installed via init)     |
|    if "go" -> capture stdout -> cd "$target"                      |
|    else    -> passthrough to binary                               |
|  }                                                                |
+---------|--------------------------------------------------------+
          |
          v
+------------------------------------------------------------------+
|                      CLI ENTRY POINT (src/cli.ts)                 |
|                                                                   |
|  #!/usr/bin/env node                                              |
|  Commander program definition                                     |
|  Default action: is git repo? -> scan : show help                 |
|                                                                   |
|  Subcommands:                                                     |
|    scan | list | search | go | info | remove | init               |
+---------|--------------------------------------------------------+
          |
          v
+------------------------------------------------------------------+
|                   COMMAND HANDLERS (src/commands/*.ts)             |
|                                                                   |
|  scan.ts -----> git.collectRepoMetadata() + registry.addOrUpdate()|
|  list.ts -----> registry.loadRegistry() + cli-table3 formatting   |
|  search.ts ---> registry.searchEntries() + cli-table3 formatting  |
|  go.ts -------> registry.searchEntries() + inquirer select        |
|  info.ts -----> registry.searchEntries() + detailed formatting    |
|  remove.ts ---> registry.removeByPath() + inquirer confirm        |
|  init.ts -----> prints shell function to stdout                   |
+--------|-----------------------------|---------------------------+
         |                             |
         v                             v
+-------------------------+  +---------------------------+
|  GIT MODULE             |  |  REGISTRY MODULE          |
|  (src/git.ts)           |  |  (src/registry.ts)        |
|                         |  |                           |
|  git()                  |  |  getRegistryDir()         |
|  isInsideGitRepo()      |  |  getRegistryPath()        |
|  getRepoRoot()          |  |  ensureRegistryExists()   |
|  getRemotes()           |  |  loadRegistry()           |
|  getLocalBranches()     |  |  saveRegistry()           |
|  getRemoteBranches()    |  |  findByPath()             |
|  getCurrentBranch()     |  |  addOrUpdate()            |
|  collectRepoMetadata()  |  |  removeByPath()           |
|                         |  |  searchEntries()          |
+--------+----------------+  +------------+--------------+
         |                               |
         v                               v
+-------------------------+  +---------------------------+
|  child_process          |  |  fs (Node.js built-in)    |
|  (Node.js built-in)     |  |                           |
|  execFileSync('git'..)  |  |  readFileSync / writeFile |
+-------------------------+  |  renameSync (atomic)      |
                             |  mkdirSync / existsSync   |
                             +---------------------------+
                                         |
                                         v
                             +---------------------------+
                             |  ~/.gitter/registry.json  |
                             +---------------------------+
```

### 1.2 Data Flow: `gitter scan`

```
CWD --> git.isInsideGitRepo()
          |
          |--> false: stderr "Not a git repository", exit(1)
          |
          |--> true: git.getRepoRoot()
                       |
                       v
                git.collectRepoMetadata(repoRoot)
                  |  git remote -v
                  |  git branch --list
                  |  git branch -r
                  |  git rev-parse --abbrev-ref HEAD
                  |
                  v
                RegistryEntry object
                       |
                       v
                registry.loadRegistry()
                       |
                       v
                registry.addOrUpdate(registry, entry)
                       |
                       v
                registry.saveRegistry(registry)  [atomic write]
                       |
                       v
                Print confirmation to stdout
```

### 1.3 Data Flow: `gitter go <query>`

```
query --> registry.loadRegistry()
            |
            v
          registry.searchEntries(registry, query)
            |
            |--> 0 matches: stderr "No match", exit(1)
            |
            |--> 1 match: stdout <- entry.localPath
            |
            |--> N matches: inquirer.select() via stderr
                               |
                               v
                             stdout <- selected.localPath
                               |
                               v
                         Shell function captures stdout
                               |
                               v
                         cd "$target"
```

**Critical**: `gitter go` writes ONLY the path to stdout. All prompts, messages, and errors go to stderr. This separation enables the shell function to work correctly.

---

## 2. Data Models

### 2.1 Type Definitions (`src/types.ts`)

```typescript
/**
 * Represents a single git remote with its fetch and push URLs.
 * A remote may have different fetch and push URLs (e.g., when using
 * different protocols for read vs write).
 */
export interface Remote {
  /** Remote name (e.g., "origin", "upstream") */
  name: string;
  /** URL used for fetching (from `git remote -v` fetch line) */
  fetchUrl: string;
  /** URL used for pushing (from `git remote -v` push line) */
  pushUrl: string;
}

/**
 * Represents a single git repository registered in the gitter registry.
 * The localPath serves as the unique identifier (primary key).
 */
export interface RegistryEntry {
  /** Directory name of the repository root */
  repoName: string;
  /** Absolute filesystem path to the repository root */
  localPath: string;
  /** All configured remotes with their URLs */
  remotes: Remote[];
  /** Remote-tracking branches (e.g., ["origin/main", "origin/develop"]) */
  remoteBranches: string[];
  /** Local branch names (e.g., ["main", "develop", "feature/xyz"]) */
  localBranches: string[];
  /** Currently checked-out branch, or "HEAD" if detached */
  currentBranch: string;
  /** ISO 8601 timestamp of last scan (e.g., "2026-03-22T14:30:00.000Z") */
  lastUpdated: string;
}

/**
 * Top-level registry structure stored in ~/.gitter/registry.json.
 * The version field supports future schema migrations.
 */
export interface Registry {
  /** Schema version number. Current version: 1 */
  version: number;
  /** All registered repositories */
  repositories: RegistryEntry[];
}
```

### 2.2 Registry JSON Example

```json
{
  "version": 1,
  "repositories": [
    {
      "repoName": "gitter",
      "localPath": "/Users/giorgosmarinos/aiwork/coding-platform/gitter",
      "remotes": [
        {
          "name": "origin",
          "fetchUrl": "git@github.com:user/gitter.git",
          "pushUrl": "git@github.com:user/gitter.git"
        }
      ],
      "remoteBranches": ["origin/main", "origin/develop"],
      "localBranches": ["main", "develop"],
      "currentBranch": "main",
      "lastUpdated": "2026-03-22T14:30:00.000Z"
    }
  ]
}
```

### 2.3 Registry File Location

| Item | Path |
|------|------|
| Registry directory | `~/.gitter/` |
| Registry file | `~/.gitter/registry.json` |
| Temp file pattern | `~/.gitter/.tmp-<random-hex>` |

The `~` is resolved from `process.env.HOME`. If `HOME` is not set, the tool throws an error immediately -- no fallback to `os.homedir()` or any default value.

---

## 3. Module Design

### 3.1 `src/types.ts`

Contains all TypeScript interfaces as defined in Section 2.1. No logic, no imports. Pure type declarations exported for use by all other modules.

**Exports**: `Remote`, `RegistryEntry`, `Registry`

---

### 3.2 `src/git.ts` -- Git Command Utilities

This module wraps all git CLI interactions. It uses `execFileSync` (not `execSync`) to avoid shell injection vulnerabilities.

```typescript
import { execFileSync } from 'child_process';
import { basename } from 'path';
import type { Remote, RegistryEntry } from './types.js';

/**
 * Execute a git command and return trimmed stdout.
 * Throws on non-zero exit code.
 *
 * @param args - Git command arguments (e.g., ['rev-parse', '--show-toplevel'])
 * @param cwd  - Working directory for the command (defaults to process.cwd())
 * @returns Trimmed stdout string
 * @throws Error if git command fails (non-zero exit, timeout, git not found)
 */
export function git(args: string[], cwd?: string): string;

/**
 * Check if the given directory is inside a git work tree.
 *
 * @param cwd - Directory to check (defaults to process.cwd())
 * @returns true if inside a git repo, false otherwise
 */
export function isInsideGitRepo(cwd?: string): boolean;

/**
 * Get the absolute path to the repository root.
 *
 * @param cwd - Directory within the repo (defaults to process.cwd())
 * @returns Absolute path to repo root
 * @throws Error if not inside a git repository
 */
export function getRepoRoot(cwd?: string): string;

/**
 * Parse `git remote -v` output into an array of Remote objects.
 * Groups fetch and push URLs by remote name.
 *
 * @param cwd - Repository directory
 * @returns Array of Remote objects (may be empty if no remotes configured)
 */
export function getRemotes(cwd?: string): Remote[];

/**
 * Get all local branch names from `git branch --list`.
 * Strips the leading "* " or "  " prefix from each line.
 *
 * @param cwd - Repository directory
 * @returns Array of local branch name strings
 */
export function getLocalBranches(cwd?: string): string[];

/**
 * Get all remote-tracking branch names from `git branch -r`.
 * Filters out "-> " alias lines (e.g., "origin/HEAD -> origin/main").
 *
 * @param cwd - Repository directory
 * @returns Array of remote branch strings (e.g., ["origin/main", "origin/develop"])
 */
export function getRemoteBranches(cwd?: string): string[];

/**
 * Get the currently checked-out branch name.
 * Returns "HEAD" if in detached HEAD state.
 *
 * @param cwd - Repository directory
 * @returns Branch name string or "HEAD"
 */
export function getCurrentBranch(cwd?: string): string;

/**
 * Collect all repository metadata into a RegistryEntry.
 * Orchestrates all git commands and assembles the result.
 *
 * @param cwd - Directory within the repo (defaults to process.cwd())
 * @returns Complete RegistryEntry with all metadata and current ISO timestamp
 * @throws Error if not inside a git repository
 */
export function collectRepoMetadata(cwd?: string): RegistryEntry;
```

#### Implementation Notes for `git()`

```typescript
export function git(args: string[], cwd?: string): string {
  return execFileSync('git', args, {
    cwd: cwd ?? process.cwd(),
    encoding: 'utf-8',
    timeout: 10_000,       // 10 second timeout
    stdio: ['pipe', 'pipe', 'pipe'],  // capture stderr too
  }).trim();
}
```

#### Implementation Notes for `getRemotes()`

The `git remote -v` output format is:
```
origin  git@github.com:user/repo.git (fetch)
origin  git@github.com:user/repo.git (push)
upstream  https://github.com/other/repo.git (fetch)
upstream  https://github.com/other/repo.git (push)
```

Parsing algorithm:
1. Split output by newlines, filter empty lines
2. For each line: split by whitespace -> `[name, url, type]`
3. `type` is `"(fetch)"` or `"(push)"`
4. Group by remote name using a `Map<string, Partial<Remote>>`
5. Convert map to `Remote[]` array

#### Implementation Notes for `getLocalBranches()`

The `git branch --list` output format is:
```
* main
  develop
  feature/xyz
```

Parsing: split by newlines, trim, strip leading `* ` or `  `, filter empty strings.

#### Implementation Notes for `getRemoteBranches()`

The `git branch -r` output format is:
```
  origin/HEAD -> origin/main
  origin/main
  origin/develop
```

Parsing: split by newlines, trim, filter lines containing ` -> `, filter empty strings.

#### Implementation Notes for `getCurrentBranch()`

```typescript
export function getCurrentBranch(cwd?: string): string {
  const branch = git(['rev-parse', '--abbrev-ref', 'HEAD'], cwd);
  return branch;  // Returns "HEAD" when detached
}
```

#### Implementation Notes for `collectRepoMetadata()`

```typescript
export function collectRepoMetadata(cwd?: string): RegistryEntry {
  const repoRoot = getRepoRoot(cwd);
  return {
    repoName: basename(repoRoot),
    localPath: repoRoot,
    remotes: getRemotes(repoRoot),
    remoteBranches: getRemoteBranches(repoRoot),
    localBranches: getLocalBranches(repoRoot),
    currentBranch: getCurrentBranch(repoRoot),
    lastUpdated: new Date().toISOString(),
  };
}
```

---

### 3.3 `src/registry.ts` -- Registry File I/O and CRUD

```typescript
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from 'fs';
import { dirname, join } from 'path';
import { randomBytes } from 'crypto';
import type { Registry, RegistryEntry } from './types.js';

/** Current registry schema version */
const REGISTRY_VERSION = 1;

/**
 * Get the registry directory path (~/.gitter/).
 * Throws if HOME environment variable is not set.
 *
 * @returns Absolute path to ~/.gitter/
 * @throws Error with clear message if HOME is not set
 */
export function getRegistryDir(): string;

/**
 * Get the registry file path (~/.gitter/registry.json).
 *
 * @returns Absolute path to registry file
 * @throws Error if HOME is not set (via getRegistryDir)
 */
export function getRegistryPath(): string;

/**
 * Ensure the registry directory and file exist.
 * Creates ~/.gitter/ directory if missing.
 * Creates registry.json with empty registry if missing.
 * Does NOT overwrite an existing registry file.
 */
export function ensureRegistryExists(): void;

/**
 * Load and parse the registry from disk.
 * Calls ensureRegistryExists() first.
 * Validates that the parsed JSON conforms to the Registry interface.
 *
 * @returns Parsed Registry object
 * @throws Error if JSON is malformed or schema is invalid
 */
export function loadRegistry(): Registry;

/**
 * Save the registry to disk using atomic write.
 * Writes to a temp file in the same directory, then renames.
 * JSON is formatted with 2-space indentation for readability.
 *
 * @param registry - The Registry object to persist
 */
export function saveRegistry(registry: Registry): void;

/**
 * Find a registry entry by its absolute local path.
 *
 * @param registry - The Registry to search
 * @param localPath - Absolute path to match
 * @returns The matching RegistryEntry or undefined
 */
export function findByPath(registry: Registry, localPath: string): RegistryEntry | undefined;

/**
 * Add a new entry or update an existing one.
 * Uses localPath as the unique key.
 * If an entry with the same localPath exists, it is replaced entirely.
 * If no entry exists, the new entry is appended.
 * Returns the modified registry (mutates in place).
 *
 * @param registry - The Registry to modify
 * @param entry - The RegistryEntry to add or update
 * @returns The modified Registry
 */
export function addOrUpdate(registry: Registry, entry: RegistryEntry): Registry;

/**
 * Remove an entry by its absolute local path.
 * Returns the modified registry (mutates in place).
 * If no entry matches, the registry is unchanged.
 *
 * @param registry - The Registry to modify
 * @param localPath - Absolute path of the entry to remove
 * @returns The modified Registry
 */
export function removeByPath(registry: Registry, localPath: string): Registry;

/**
 * Search registry entries by a query string.
 * Performs case-insensitive partial matching against:
 *   - repoName
 *   - localPath
 *   - All remote fetchUrl and pushUrl values
 *
 * @param registry - The Registry to search
 * @param query - The search string
 * @returns Array of matching RegistryEntry objects (may be empty)
 */
export function searchEntries(registry: Registry, query: string): RegistryEntry[];
```

#### Implementation Notes for `getRegistryDir()`

```typescript
export function getRegistryDir(): string {
  const home = process.env.HOME;
  if (!home) {
    throw new Error(
      'HOME environment variable is not set. Cannot determine registry location. ' +
      'Please set the HOME environment variable and try again.'
    );
  }
  return join(home, '.gitter');
}
```

**No fallback**: Per project rules, there must be no fallback to `os.homedir()`, `process.env.USERPROFILE`, or any default value.

#### Implementation Notes for Atomic Write

```typescript
export function saveRegistry(registry: Registry): void {
  const filePath = getRegistryPath();
  const data = JSON.stringify(registry, null, 2) + '\n';
  const dir = dirname(filePath);
  const tmpFile = join(dir, `.tmp-${randomBytes(6).toString('hex')}`);

  writeFileSync(tmpFile, data, 'utf-8');
  renameSync(tmpFile, filePath);  // atomic on POSIX
}
```

#### Implementation Notes for `ensureRegistryExists()`

```typescript
export function ensureRegistryExists(): void {
  const dir = getRegistryDir();
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  const filePath = getRegistryPath();
  if (!existsSync(filePath)) {
    const empty: Registry = { version: REGISTRY_VERSION, repositories: [] };
    saveRegistry(empty);
  }
}
```

#### Implementation Notes for `searchEntries()`

```typescript
export function searchEntries(registry: Registry, query: string): RegistryEntry[] {
  const q = query.toLowerCase();
  return registry.repositories.filter(entry => {
    // Match against repo name
    if (entry.repoName.toLowerCase().includes(q)) return true;
    // Match against local path
    if (entry.localPath.toLowerCase().includes(q)) return true;
    // Match against all remote URLs
    for (const remote of entry.remotes) {
      if (remote.fetchUrl.toLowerCase().includes(q)) return true;
      if (remote.pushUrl.toLowerCase().includes(q)) return true;
    }
    return false;
  });
}
```

---

### 3.4 Command Handlers (`src/commands/*.ts`)

Each command is a separate module exporting a single `async` handler function. The handler is registered with Commander in `src/cli.ts`.

#### 3.4.1 `src/commands/scan.ts`

```typescript
/**
 * Handler for `gitter scan` command.
 * Also invoked as the default action when no subcommand is given and CWD is a git repo.
 *
 * Behavior:
 * 1. Check if CWD is inside a git repo -> if not, stderr + exit(1)
 * 2. Collect metadata via collectRepoMetadata()
 * 3. Load registry, addOrUpdate, save registry
 * 4. Print confirmation to stdout: repo name, path, remote count, branch count
 *
 * Output (stdout): Confirmation message with scan results
 * Errors (stderr): "Not inside a git repository" + exit code 1
 */
export async function scanCommand(): Promise<void>;
```

#### 3.4.2 `src/commands/list.ts`

```typescript
/**
 * Handler for `gitter list` command.
 *
 * Behavior:
 * 1. Load registry
 * 2. If empty -> print "No repositories registered." and return
 * 3. Build cli-table3 table with columns:
 *    | Repo Name | Local Path | Remotes | Last Updated |
 * 4. For each entry, check existsSync(localPath):
 *    - If missing, prepend "[MISSING] " to repo name (in red)
 * 5. Print table to stdout
 *
 * Output (stdout): Formatted table of all registered repos
 */
export async function listCommand(): Promise<void>;
```

#### 3.4.3 `src/commands/search.ts`

```typescript
/**
 * Handler for `gitter search <query>` command.
 *
 * @param query - Search string (required positional argument)
 *
 * Behavior:
 * 1. Load registry
 * 2. Call searchEntries(registry, query)
 * 3. If no matches -> print "No repositories match query: <query>" to stdout
 * 4. If matches -> display in same table format as list
 *
 * Output (stdout): Filtered table or "no matches" message
 */
export async function searchCommand(query: string): Promise<void>;
```

#### 3.4.4 `src/commands/go.ts`

```typescript
/**
 * Handler for `gitter go <query>` command.
 * CRITICAL: This command must maintain strict stdout/stderr discipline.
 *
 * @param query - Search string (required positional argument)
 *
 * Behavior:
 * 1. Load registry
 * 2. Call searchEntries(registry, query)
 * 3. If 0 matches:
 *    - stderr: "No repositories match query: <query>"
 *    - exit(1)
 * 4. If 1 match:
 *    - Verify existsSync(match.localPath)
 *    - If path missing: stderr error + exit(1)
 *    - stdout: match.localPath (ONLY this, nothing else)
 * 5. If N matches:
 *    - Use @inquirer/prompts select() -- prompts render to stderr
 *    - Verify existsSync(selected.localPath)
 *    - If path missing: stderr error + exit(1)
 *    - stdout: selected.localPath (ONLY this, nothing else)
 *
 * Output (stdout): ONLY the absolute path, one line, no trailing content
 * Output (stderr): Interactive prompts, error messages, informational text
 */
export async function goCommand(query: string): Promise<void>;
```

**Inquirer stderr redirection**: `@inquirer/prompts` by default renders to stdout. For the `go` command, the `select` prompt must use `output: process.stderr` in its configuration so that the interactive UI does not pollute the path output on stdout.

```typescript
import { select } from '@inquirer/prompts';
import { createWriteStream } from 'fs';

const selectedPath = await select({
  message: 'Multiple repositories matched. Select one:',
  choices: matches.map(entry => ({
    name: `${entry.repoName} (${entry.localPath})`,
    value: entry.localPath,
    description: `Last updated: ${entry.lastUpdated}`,
  })),
}, {
  output: process.stderr,  // CRITICAL: render prompts to stderr
});

// Only the path goes to stdout
process.stdout.write(selectedPath + '\n');
```

#### 3.4.5 `src/commands/info.ts`

```typescript
/**
 * Handler for `gitter info <query>` command.
 *
 * @param query - Search string (required positional argument)
 *
 * Behavior:
 * 1. Load registry, search for matches
 * 2. If 0 matches -> print "No repositories match" + exit(1)
 * 3. If N matches -> interactive select (prompts to stderr)
 * 4. Display full metadata for the selected entry:
 *    - Repository Name
 *    - Local Path (with [MISSING] warning if path doesn't exist)
 *    - Remotes (name, fetch URL, push URL for each)
 *    - Local Branches (with * marking current branch)
 *    - Remote Branches
 *    - Current Branch
 *    - Last Updated
 * 5. Use picocolors for section headers (bold) and values
 *
 * Output (stdout): Formatted detailed repository information
 */
export async function infoCommand(query: string): Promise<void>;
```

#### 3.4.6 `src/commands/remove.ts`

```typescript
/**
 * Handler for `gitter remove <query>` command.
 *
 * @param query - Search string (required positional argument)
 *
 * Behavior:
 * 1. Load registry, search for matches
 * 2. If 0 matches -> print "No repositories match" + exit(1)
 * 3. If N matches -> interactive select to choose which to remove
 * 4. Confirm removal with user (y/n via @inquirer/prompts confirm)
 * 5. If confirmed: removeByPath(), saveRegistry(), print confirmation
 * 6. If cancelled: print "Removal cancelled"
 *
 * Output (stdout): Confirmation or cancellation message
 */
export async function removeCommand(query: string): Promise<void>;
```

#### 3.4.7 `src/commands/init.ts`

```typescript
/**
 * Handler for `gitter init` command.
 *
 * Behavior:
 * 1. Print the shell function wrapper to stdout
 * 2. Print installation instructions to stderr
 *
 * The shell function is printed to stdout so users can do:
 *   gitter init >> ~/.zshrc
 * or
 *   eval "$(gitter init)"
 *
 * Output (stdout): The shell function code
 * Output (stderr): Installation instructions
 */
export async function initCommand(): Promise<void>;
```

---

### 3.5 `src/cli.ts` -- Commander Program Setup

```typescript
#!/usr/bin/env node

import { program } from 'commander';
import { scanCommand } from './commands/scan.js';
import { listCommand } from './commands/list.js';
import { searchCommand } from './commands/search.js';
import { goCommand } from './commands/go.js';
import { infoCommand } from './commands/info.js';
import { removeCommand } from './commands/remove.js';
import { initCommand } from './commands/init.js';
import { isInsideGitRepo } from './git.js';

program
  .name('gitter')
  .version('1.0.0')
  .description('Git repository registry - track, search, and navigate your local repos');

program
  .command('scan')
  .description('Scan current directory and register/update the git repository')
  .action(scanCommand);

program
  .command('list')
  .description('List all registered repositories')
  .action(listCommand);

program
  .command('search <query>')
  .description('Search repositories by name, path, or remote URL')
  .action(searchCommand);

program
  .command('go <query>')
  .description('Navigate to a matching repository (use with shell function)')
  .action(goCommand);

program
  .command('info <query>')
  .description('Show detailed information about a repository')
  .action(infoCommand);

program
  .command('remove <query>')
  .description('Remove a repository from the registry')
  .action(removeCommand);

program
  .command('init')
  .description('Print shell function for directory navigation integration')
  .action(initCommand);

// Default action: no subcommand provided
program.action(() => {
  if (isInsideGitRepo()) {
    scanCommand();
  } else {
    program.help();
  }
});

program.parse();
```

---

## 4. File Structure

```
gitter/
|-- package.json
|-- tsconfig.json
|-- src/
|   |-- cli.ts                  # Entry point with Commander setup + default action
|   |-- types.ts                # All TypeScript interfaces (Remote, RegistryEntry, Registry)
|   |-- git.ts                  # Git command wrappers and metadata collection
|   |-- registry.ts             # Registry JSON file I/O, CRUD, search
|   |-- commands/
|       |-- scan.ts             # gitter scan
|       |-- list.ts             # gitter list
|       |-- search.ts           # gitter search <query>
|       |-- go.ts               # gitter go <query>
|       |-- info.ts             # gitter info <query>
|       |-- remove.ts           # gitter remove <query>
|       |-- init.ts             # gitter init (print shell function)
|-- dist/                       # Compiled JS output (generated, not committed)
|-- node_modules/               # Dependencies (generated, not committed)
|-- test_scripts/               # Test scripts
|-- docs/
|   |-- design/
|   |   |-- project-design.md          # This document
|   |   |-- plan-001-gitter-cli-tool.md
|   |   |-- configuration-guide.md     # (future)
|   |   |-- project-functions.md       # Functional requirements
|   |-- reference/
|       |-- refined-request-gitter-repo-registry.md
|       |-- investigation-gitter-cli-tool.md
|-- Issues - Pending Items.md
```

Runtime artifacts (not part of project tree):
```
~/.gitter/
|-- registry.json               # The persistent registry
```

---

## 5. Error Handling Strategy

### 5.1 Principles

1. **No fallback values**: Per project rules, missing configuration (HOME, etc.) always throws an exception. Never substitute with defaults.
2. **Clear error messages**: Every thrown error must include what went wrong and what the user can do to fix it.
3. **stderr for errors**: All error messages go to `process.stderr`.
4. **Exit codes**: `0` for success, `1` for all errors.

### 5.2 Error Scenarios

| Scenario | Behavior | Exit Code |
|----------|----------|:---------:|
| HOME not set | Throw: `"HOME environment variable is not set..."` | 1 |
| Not inside a git repo (for scan) | stderr: `"Not inside a git repository"` | 1 |
| Git not installed / not in PATH | Throw from `execFileSync` with `ENOENT` -> stderr: `"git command not found..."` | 1 |
| Git command fails (non-zero exit) | stderr: `"Git command failed: <command> <stderr output>"` | 1 |
| Git command timeout (>10s) | stderr: `"Git command timed out"` | 1 |
| Registry JSON malformed | Throw: `"Registry file is corrupted..."` | 1 |
| No search matches (go, info) | stderr: `"No repositories match query: <query>"` | 1 |
| No search matches (search) | stdout: `"No repositories match query: <query>"` | 0 |
| Selected path does not exist (go) | stderr: `"Repository path no longer exists: <path>"` | 1 |
| Registry file missing | Auto-create empty registry (not an error) | N/A |
| Registry directory missing | Auto-create `~/.gitter/` directory (not an error) | N/A |
| User cancels interactive prompt | stderr: `"Operation cancelled"` | 1 |
| Atomic write fails (disk full, permissions) | Throw from `writeFileSync` / `renameSync` | 1 |

### 5.3 Error Wrapping in `git()`

```typescript
export function git(args: string[], cwd?: string): string {
  try {
    return execFileSync('git', args, {
      cwd: cwd ?? process.cwd(),
      encoding: 'utf-8',
      timeout: 10_000,
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
  } catch (error: unknown) {
    const err = error as { code?: string; stderr?: string; status?: number };
    if (err.code === 'ENOENT') {
      throw new Error(
        'git command not found. Please install git and ensure it is in your PATH.'
      );
    }
    if (err.code === 'ETIMEDOUT') {
      throw new Error(
        `Git command timed out: git ${args.join(' ')}`
      );
    }
    throw new Error(
      `Git command failed: git ${args.join(' ')}\n${err.stderr ?? 'Unknown error'}`
    );
  }
}
```

### 5.4 Top-Level Error Handler in `src/cli.ts`

Each command handler should catch errors and format them for the user. Unhandled exceptions are caught at the top level:

```typescript
process.on('uncaughtException', (error: Error) => {
  process.stderr.write(`Error: ${error.message}\n`);
  process.exit(1);
});
```

---

## 6. Shell Function Integration Design

### 6.1 The Shell Function

Output by `gitter init` to stdout:

```bash
# Gitter shell integration
# Add this to your ~/.zshrc or ~/.bashrc, or run: eval "$(gitter init)"
gitter() {
  if [ "$1" = "go" ]; then
    shift
    local target
    target=$(command gitter go "$@" 2>/dev/null)
    local exit_code=$?
    if [ $exit_code -eq 0 ] && [ -n "$target" ] && [ -d "$target" ]; then
      cd "$target" || return 1
      echo "Changed directory to: $target" >&2
    else
      # Re-run to show interactive prompts and errors (not silenced)
      target=$(command gitter go "$@")
      exit_code=$?
      if [ $exit_code -eq 0 ] && [ -n "$target" ] && [ -d "$target" ]; then
        cd "$target" || return 1
        echo "Changed directory to: $target" >&2
      else
        return $exit_code
      fi
    fi
  else
    command gitter "$@"
  fi
}
```

**Note on the two-pass approach**: The first attempt silences stderr (`2>/dev/null`) to check if there is exactly one match (non-interactive case). If it fails (because interactive selection is needed, or there was an error), the second attempt allows stderr through so the user sees prompts and error messages. This avoids suppressing interactive prompts.

**Alternative simpler shell function** (recommended for v1):

```bash
# Gitter shell integration
# Add this to your ~/.zshrc or ~/.bashrc, or run: eval "$(gitter init)"
gitter() {
  if [ "$1" = "go" ]; then
    shift
    local target
    target=$(command gitter go "$@")
    local exit_code=$?
    if [ $exit_code -eq 0 ] && [ -n "$target" ] && [ -d "$target" ]; then
      cd "$target" || return 1
    else
      return $exit_code
    fi
  else
    command gitter "$@"
  fi
}
```

This simpler version works because `@inquirer/prompts` is configured to render to stderr (via `output: process.stderr`), so interactive prompts are visible even when stdout is captured by the `$(...)` subshell.

### 6.2 stdout vs stderr Discipline

The entire shell integration depends on strict output separation in the `go` command:

| Output Channel | Content |
|----------------|---------|
| **stdout** | ONLY the absolute path to the selected repository (one line, no decoration) |
| **stderr** | Interactive prompts (inquirer select), error messages, informational messages |

This is enforced by:
1. Using `process.stdout.write(path + '\n')` for the path
2. Using `console.error()` or `process.stderr.write()` for everything else
3. Configuring `@inquirer/prompts` with `output: process.stderr`

### 6.3 Installation Instructions

Output by `gitter init` to stderr:

```
# To enable the gitter shell function, add the following to your shell config:
#
#   For zsh:  echo 'eval "$(command gitter init)"' >> ~/.zshrc
#   For bash: echo 'eval "$(command gitter init)"' >> ~/.bashrc
#
# Then restart your shell or run:
#   source ~/.zshrc   (or source ~/.bashrc)
#
# After installation, use `gitter go <name>` to navigate to repositories.
```

---

## 7. Key Algorithms

### 7.1 Registry Search (Case-Insensitive Partial Match)

```
FUNCTION searchEntries(registry, query):
    q = query.toLowerCase()
    results = []

    FOR EACH entry IN registry.repositories:
        matched = FALSE

        // Check repo name
        IF entry.repoName.toLowerCase().includes(q):
            matched = TRUE

        // Check local path
        ELSE IF entry.localPath.toLowerCase().includes(q):
            matched = TRUE

        // Check all remote URLs
        ELSE:
            FOR EACH remote IN entry.remotes:
                IF remote.fetchUrl.toLowerCase().includes(q):
                    matched = TRUE; BREAK
                IF remote.pushUrl.toLowerCase().includes(q):
                    matched = TRUE; BREAK

        IF matched:
            results.push(entry)

    RETURN results
```

**Complexity**: O(N * M) where N = number of registry entries, M = average number of remotes per entry. For expected registry sizes (<1000 entries), this is negligible.

### 7.2 Atomic Write (Write-Temp-Then-Rename)

```
FUNCTION atomicWrite(filePath, data):
    dir = dirname(filePath)
    tmpFile = join(dir, ".tmp-" + randomHex(6))

    TRY:
        writeFileSync(tmpFile, data, 'utf-8')
        renameSync(tmpFile, filePath)     // atomic on POSIX filesystems
    CATCH error:
        // Attempt cleanup of temp file
        TRY: unlinkSync(tmpFile)
        CATCH: // ignore cleanup failure
        THROW error
```

**Why this works**: On POSIX systems (macOS, Linux), `rename()` is an atomic operation. The file at `filePath` is either the old version or the new version -- never a partial write. If the process crashes after `writeFileSync` but before `renameSync`, the temp file is left behind (harmless, cleaned up on next write via the random name).

### 7.3 Git Remote Parsing

```
FUNCTION parseRemotes(gitRemoteOutput):
    IF output is empty:
        RETURN []

    remoteMap = new Map<string, {name, fetchUrl?, pushUrl?}>()
    lines = output.split('\n').filter(non-empty)

    FOR EACH line IN lines:
        // Line format: "origin\tgit@github.com:user/repo.git (fetch)"
        parts = line.split(/\s+/)
        name = parts[0]
        url  = parts[1]
        type = parts[2]    // "(fetch)" or "(push)"

        IF NOT remoteMap.has(name):
            remoteMap.set(name, { name, fetchUrl: '', pushUrl: '' })

        entry = remoteMap.get(name)
        IF type == "(fetch)":
            entry.fetchUrl = url
        ELSE IF type == "(push)":
            entry.pushUrl = url

    RETURN Array.from(remoteMap.values()) as Remote[]
```

### 7.4 Default Action Logic

```
FUNCTION defaultAction():
    IF isInsideGitRepo():
        scanCommand()        // Auto-scan current repo
    ELSE:
        program.help()       // Show help text
```

This makes `gitter` (with no arguments) context-aware: inside a git repo it performs a scan; outside, it shows usage help.

### 7.5 Stale Entry Detection

Used in `list` and `go` commands:

```
FUNCTION isEntryStale(entry):
    RETURN NOT existsSync(entry.localPath)
```

In `list`: stale entries are shown with `[MISSING]` prefix in red.
In `go`: if the selected entry is stale, print error to stderr and exit(1).

---

## 8. Implementation Units for Parallel Coding

The codebase is designed so that multiple agents can work on different units simultaneously after Phase 1 (scaffolding) is complete. Below are the independent units and their interface contracts.

### 8.1 Unit Map

```
+-----------+     +-----------+     +------------------+
| Unit A    |     | Unit B    |     | Unit C           |
| types.ts  |<----| git.ts    |     | registry.ts      |
|           |<----|           |     |                  |
|           |<----|-----------|-----|                  |
+-----------+     +-----------+     +------------------+
      ^                ^                    ^
      |                |                    |
      +--------+-------+----+---------+-----+
               |            |         |
          +----+----+  +----+----+  +-+--------+
          | Unit D  |  | Unit E  |  | Unit F   |
          | scan.ts |  | go.ts   |  | list.ts  |
          | (+ info)|  | init.ts |  | search.ts|
          |         |  |         |  | remove.ts|
          +---------+  +---------+  +----------+
```

### 8.2 Unit Definitions

#### Unit A: Type Definitions (`src/types.ts`)

- **Scope**: `Remote`, `RegistryEntry`, `Registry` interfaces
- **Dependencies**: None
- **Must complete first**: All other units import from this
- **Effort**: Minimal (copy from Section 2.1)
- **Agent instructions**: Create exactly the interfaces specified in Section 2.1. No logic, no imports other than type exports.

#### Unit B: Git Module (`src/git.ts`)

- **Scope**: All git command wrappers and `collectRepoMetadata()`
- **Dependencies**: Unit A (`types.ts` for `Remote`, `RegistryEntry`)
- **Independent of**: Unit C (registry module)
- **Interface contract**: Must export all functions with signatures from Section 3.2
- **Testing**: Can be tested independently by running inside any git repository
- **Agent instructions**: Implement all functions from Section 3.2. Use `execFileSync` from `child_process`. Follow error handling from Section 5.3. Parse git output per Section 7.3.

#### Unit C: Registry Module (`src/registry.ts`)

- **Scope**: All registry file I/O and CRUD operations
- **Dependencies**: Unit A (`types.ts` for `Registry`, `RegistryEntry`)
- **Independent of**: Unit B (git module)
- **Interface contract**: Must export all functions with signatures from Section 3.3
- **Testing**: Can be tested independently with mock RegistryEntry data (no git repo needed)
- **Agent instructions**: Implement all functions from Section 3.3. Use atomic writes per Section 7.2. Search algorithm per Section 7.1. Throw on missing HOME per Section 5.2.

#### Unit D: Scan + Info Commands (`src/commands/scan.ts`, `src/commands/info.ts`)

- **Scope**: The `scan` and `info` command handlers
- **Dependencies**: Units A, B, C
- **Independent of**: Units E, F
- **Interface contract**: Export `scanCommand()` and `infoCommand(query)` as async functions
- **Agent instructions**: Implement per Section 3.4.1 and 3.4.5. Use `picocolors` for colored output. Use `cli-table3` for info display if desired.

#### Unit E: Go + Init Commands (`src/commands/go.ts`, `src/commands/init.ts`)

- **Scope**: The `go` command handler and `init` shell function printer
- **Dependencies**: Units A, C (go needs registry search); no git dependency
- **Independent of**: Units D, F
- **Interface contract**: Export `goCommand(query)` and `initCommand()` as async functions
- **Critical requirement**: stdout/stderr discipline as specified in Section 3.4.4 and Section 6
- **Agent instructions**: Implement per Section 3.4.4 and 3.4.7. Configure `@inquirer/prompts` with `output: process.stderr`. Shell function per Section 6.1 (simpler version). Test that `gitter go <name> 2>/dev/null` outputs ONLY the path.

#### Unit F: List + Search + Remove Commands (`src/commands/list.ts`, `src/commands/search.ts`, `src/commands/remove.ts`)

- **Scope**: The `list`, `search`, and `remove` command handlers
- **Dependencies**: Units A, C (registry operations only; no git dependency)
- **Independent of**: Units D, E
- **Interface contract**: Export `listCommand()`, `searchCommand(query)`, `removeCommand(query)` as async functions
- **Agent instructions**: Implement per Sections 3.4.2, 3.4.3, 3.4.6. Use `cli-table3` for table output. Use `picocolors` for coloring. Stale detection per Section 7.5. Use `@inquirer/prompts` for interactive selection in remove.

#### Unit G: CLI Entry Point (`src/cli.ts`)

- **Scope**: Commander program setup, wiring all commands, default action
- **Dependencies**: All command units (D, E, F) and Unit B (for `isInsideGitRepo`)
- **Must be done last** (or started with stubs and finalized after all commands are ready)
- **Agent instructions**: Implement per Section 3.5. Register all commands with Commander. Implement default action per Section 7.4. Add uncaught exception handler per Section 5.4.

### 8.3 Parallel Execution Plan

```
Phase 1: Project Scaffolding (single agent)
    |
    v
Unit A: types.ts (single agent, fast)
    |
    +---> Unit B: git.ts        (Agent 1) ---|
    |                                        |
    +---> Unit C: registry.ts   (Agent 2) ---|
                                             |
              +------------------------------+
              |
    +--> Unit D: scan + info    (Agent 1) ---|
    |                                        |
    +--> Unit E: go + init      (Agent 2) ---|
    |                                        |
    +--> Unit F: list+search+rm (Agent 3) ---|
                                             |
              +------------------------------+
              |
              v
    Unit G: cli.ts (single agent, wiring)
              |
              v
    Phase 4: Build + Link + Test
```

**Maximum parallelism**: 3 agents (during command implementation phase)
**Minimum agents needed**: 1 (sequential execution through all units)

### 8.4 Interface Contracts Between Units

| Producer | Consumer | Contract |
|----------|----------|----------|
| `types.ts` | All modules | Export `Remote`, `RegistryEntry`, `Registry` interfaces exactly as specified |
| `git.ts` | `scan.ts` | `isInsideGitRepo(cwd?): boolean` and `collectRepoMetadata(cwd?): RegistryEntry` |
| `git.ts` | `cli.ts` | `isInsideGitRepo(cwd?): boolean` (for default action) |
| `registry.ts` | All commands | `loadRegistry(): Registry` and `saveRegistry(registry): void` |
| `registry.ts` | `scan.ts` | `addOrUpdate(registry, entry): Registry` |
| `registry.ts` | `go.ts`, `search.ts`, `info.ts`, `remove.ts` | `searchEntries(registry, query): RegistryEntry[]` |
| `registry.ts` | `remove.ts` | `removeByPath(registry, path): Registry` |
| Each command | `cli.ts` | Export a single async function matching the handler signature |

---

## 9. Technology Stack Summary

| Component | Technology | Version |
|-----------|-----------|---------|
| Language | TypeScript | 5.x |
| Runtime | Node.js | Latest LTS |
| Module System | ESM (`"type": "module"`) | -- |
| CLI Framework | commander.js | 14.x |
| Interactive Prompts | @inquirer/prompts | 8.x |
| Terminal Colors | picocolors | 1.x |
| Table Output | cli-table3 | 0.6.x |
| Git Interaction | child_process (built-in) | -- |
| File I/O | fs (built-in) | -- |
| Dev Runner | tsx | 4.x |
| Compiler | tsc (TypeScript) | 5.x |

**Production dependencies**: 4
**Dev dependencies**: 3

---

## 10. AI-Powered Repository Description Feature

### 10.1 Feature Overview

The `gitter describe` command uses the Anthropic Claude SDK to analyze a registered git repository's contents and generate structured descriptions. Each description consists of two sections -- a business description (for stakeholders) and a technical description (for developers). Descriptions are stored persistently in the registry and can be displayed on demand or as part of `gitter info`.

The feature supports three Claude API providers: Anthropic (direct), Azure AI Foundry, and Google Vertex AI. Configuration follows a priority-based resolution system (environment variables > `.env` file > `~/.gitter/config.json`) with no fallback values permitted.

**Reference Documents**:
- Requirements: `docs/reference/refined-request-ai-repo-descriptions.md`
- Implementation Plan: `docs/design/plan-002-ai-descriptions.md`
- SDK Investigation: `docs/reference/investigation-ai-integration.md`

---

### 10.2 Updated Component Diagram

```
+------------------------------------------------------------------+
|                         USER SHELL (zsh/bash)                     |
|                                                                   |
|  gitter() {           <-- shell function (installed via init)     |
|    if "go" -> capture stdout -> cd "$target"                      |
|    else    -> passthrough to binary                               |
|  }                                                                |
+---------|--------------------------------------------------------+
          |
          v
+------------------------------------------------------------------+
|                      CLI ENTRY POINT (src/cli.ts)                 |
|                                                                   |
|  #!/usr/bin/env node                                              |
|  Commander program definition                                     |
|  Default action: is git repo? -> scan : show help                 |
|                                                                   |
|  Subcommands:                                                     |
|    scan | list | search | go | info | remove | init | describe    |
+---------|--------------------------------------------------------+
          |
          v
+------------------------------------------------------------------+
|                   COMMAND HANDLERS (src/commands/*.ts)             |
|                                                                   |
|  scan.ts -----> git.collectRepoMetadata() + registry.addOrUpdate()|
|  list.ts -----> registry.loadRegistry() + cli-table3 formatting   |
|  search.ts ---> registry.searchEntries() + cli-table3 formatting  |
|  go.ts -------> registry.searchEntries() + inquirer select        |
|  info.ts -----> registry.searchEntries() + detailed formatting    |
|  remove.ts ---> registry.removeByPath() + inquirer confirm        |
|  init.ts -----> prints shell function to stdout                   |
|  describe.ts -> ai-config + ai-client + repo-content + registry   |
+--------|-----------------------------|---------------------------+
         |                             |
         v                             v
+-------------------------+  +---------------------------+
|  GIT MODULE             |  |  REGISTRY MODULE          |
|  (src/git.ts)           |  |  (src/registry.ts)        |
|                         |  |                           |
|  git()                  |  |  getRegistryDir()         |
|  isInsideGitRepo()      |  |  getRegistryPath()        |
|  getRepoRoot()          |  |  ensureRegistryExists()   |
|  getRemotes()           |  |  loadRegistry()           |
|  getLocalBranches()     |  |  saveRegistry()           |
|  getRemoteBranches()    |  |  findByPath()             |
|  getCurrentBranch()     |  |  addOrUpdate()            |
|  collectRepoMetadata()  |  |  removeByPath()           |
|                         |  |  searchEntries()          |
+--------+----------------+  +------------+--------------+
         |                               |
         v                               v
+-------------------------+  +---------------------------+
|  child_process          |  |  fs (Node.js built-in)    |
|  (Node.js built-in)     |  |                           |
|  execFileSync('git'..)  |  |  readFileSync / writeFile |
+-------------------------+  |  renameSync (atomic)      |
                             |  mkdirSync / existsSync   |
                             +---------------------------+
                                         |
                                         v
                             +---------------------------+
                             |  ~/.gitter/registry.json  |
                             |  ~/.gitter/config.json    |
                             +---------------------------+

+------------------------------------------------------------------+
|                   AI MODULES (new for describe feature)           |
|                                                                   |
|  src/ai-config.ts -----> Config loading with priority resolution  |
|  src/ai-client.ts -----> Client factory + messages.create wrapper |
|  src/repo-content.ts --> Repo content collection and formatting   |
+--------|---------------------------------------------------------+
         |
         v
+------------------------------------------------------------------+
|  EXTERNAL SDK PACKAGES                                            |
|                                                                   |
|  @anthropic-ai/sdk -----------> Direct Anthropic API              |
|  @anthropic-ai/foundry-sdk ---> Azure AI Foundry (Claude on Azure)|
|  @anthropic-ai/vertex-sdk -----> Google Vertex AI                 |
+------------------------------------------------------------------+
```

---

### 10.3 Data Flow: `gitter describe myproject`

```
query --> registry.searchEntries()
            |
            |--> 0 matches: stderr "No match", exit(1)
            |--> 1 match: use that entry
            |--> N matches: inquirer.select() via stderr
            |
            v
          resolve to single RegistryEntry
            |
            v
          Validate: existsSync(entry.localPath)?
            |--> no: stderr "Repository path no longer exists", exit(1)
            |
            v
          repo-content.collectRepoContent(entry.localPath)
            |  git ls-tree -r --name-only HEAD (file tree)
            |  Read README.md (first 200 lines)
            |  Read package.json / Cargo.toml / etc. (full)
            |  Read CLAUDE.md, .cursor/rules (first 100 lines each)
            |  Read src/main.*, src/index.* etc. (first 100 lines each)
            |  Read .github/workflows/*.yml (first 50 lines each, max 3)
            |
            v
          repo-content.formatRepoContentForPrompt(content)
            |  Apply token budget (~30K tokens / ~120KB)
            |  Log content size to stderr
            |
            v
          ai-config.loadAIConfig()
            |  Priority: env vars > .env > config.json
            |  Validate required fields per provider
            |  Throw on missing values (no fallbacks)
            |
            v
          ai-client.createAIClient(config)
            |  Factory: Anthropic | AnthropicFoundry | AnthropicVertex
            |
            v
          Build system prompt (with line count targets)
            |
            v
          Build user message
            +--> include existing description if present
            +--> include user --instructions if provided
            +--> include formatted repo content
            |
            v
          ai-client.generateDescription(client, config, system, user)
            |  client.messages.create({ model, max_tokens, system, messages })
            |  Check stop_reason for truncation warning
            |
            v
          Parse response -> split on "## Technical Description"
            |  Extract businessDescription (strip heading)
            |  Extract technicalDescription (strip heading)
            |
            v
          Build RepoDescription object
            |  { businessDescription, technicalDescription,
            |    generatedAt: ISO timestamp, generatedBy: model name,
            |    instructions?: user instructions }
            |
            v
          Update registry entry directly (NOT via addOrUpdate)
            |  registry = loadRegistry()
            |  entry.description = description
            |  saveRegistry(registry)
            |
            v
          Display formatted description to terminal
```

---

### 10.4 New Type Definitions (additions to `src/types.ts`)

The following types are added to the existing `src/types.ts` module. The `RegistryEntry` interface is extended with an optional `description` field. The registry schema version remains `1` since the new field is optional and fully backward-compatible.

```typescript
/**
 * AI-generated description of a repository.
 * Stored as part of a RegistryEntry in the registry.
 */
export interface RepoDescription {
  /** Business-oriented description in markdown format */
  businessDescription: string;
  /** Technical description in markdown format */
  technicalDescription: string;
  /** ISO 8601 timestamp of when this description was generated */
  generatedAt: string;
  /** The AI model identifier used to generate this description */
  generatedBy: string;
  /** Custom user instructions that were used during generation (if any) */
  instructions?: string;
}

/**
 * Identifies which Claude API provider to use.
 * Each provider requires different configuration and uses a different SDK package.
 */
export type AIProvider = 'anthropic' | 'azure' | 'vertex';

/**
 * Configuration for the AI client.
 * Loaded from environment variables, .env file, or ~/.gitter/config.json
 * with priority resolution (env > .env > config file).
 */
export interface AIConfig {
  /** Which Claude provider to use */
  provider: AIProvider;
  /** Claude model identifier (format varies by provider) */
  model: string;
  /** Maximum tokens for the AI response */
  maxTokens: number;
  /** Anthropic direct API configuration */
  anthropic?: {
    apiKey: string;
  };
  /** Azure AI Foundry configuration */
  azure?: {
    apiKey: string;
    /** Azure resource hostname (e.g., "my-resource.azure.anthropic.com") */
    resource: string;
  };
  /** Google Vertex AI configuration */
  vertex?: {
    projectId: string;
    region: string;
  };
}
```

**Extension to existing `RegistryEntry`**:

```typescript
export interface RegistryEntry {
  // ... all existing fields unchanged ...

  /** AI-generated description of the repository (optional, populated by describe command) */
  description?: RepoDescription;
}
```

**Impact on Existing Code**:
- `loadRegistry()` and `saveRegistry()` require no changes -- they serialize/deserialize the full object graph via `JSON.parse`/`JSON.stringify`.
- `addOrUpdate()` replaces the full entry by `localPath`. Since `collectRepoMetadata()` does not produce a `description` field, re-scanning would lose the description. This is mitigated in `scan.ts` (see Section 10.10.3).
- No registry version bump is needed since the field is optional.

---

### 10.5 Module Design: `src/ai-config.ts`

**Purpose**: Load and validate AI configuration with three-tier priority resolution.

#### Configuration Priority (highest to lowest)

1. **Environment variables** -- shell-set vars take highest precedence
2. **`.env` file in `~/.gitter/`** -- loaded via `dotenv.config({ path })` which does NOT override existing env vars
3. **`~/.gitter/config.json`** -- JSON config file, lowest priority

#### Environment Variable Mapping

| Config Field | Environment Variable | Config JSON Path | Required When |
|-------------|---------------------|-----------------|---------------|
| `provider` | `GITTER_AI_PROVIDER` | `ai.provider` | Always |
| `model` | `GITTER_AI_MODEL` | `ai.model` | Always |
| `maxTokens` | `GITTER_AI_MAX_TOKENS` | `ai.maxTokens` | Always |
| `anthropic.apiKey` | `ANTHROPIC_API_KEY` | `ai.anthropic.apiKey` | provider = anthropic |
| `azure.apiKey` | `ANTHROPIC_FOUNDRY_API_KEY` | `ai.azure.apiKey` | provider = azure |
| `azure.resource` | `ANTHROPIC_FOUNDRY_RESOURCE` | `ai.azure.resource` | provider = azure |
| `vertex.projectId` | `ANTHROPIC_VERTEX_PROJECT_ID` | `ai.vertex.projectId` | provider = vertex |
| `vertex.region` | `CLOUD_ML_REGION` | `ai.vertex.region` | provider = vertex |

Note: The Azure and Vertex environment variable names are aligned with the SDK defaults so that users who already have these set for other tools get automatic interoperability.

#### Exported Function: `loadAIConfig(): AIConfig`

```typescript
import dotenv from 'dotenv';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { getRegistryDir } from './registry.js';
import type { AIConfig, AIProvider } from './types.js';

let configFileCache: Record<string, unknown> | null | undefined = undefined;

/**
 * Load .env file from ~/.gitter/ directory.
 * Called once; dotenv does NOT override existing env vars.
 */
function loadDotEnv(): void {
  const envPath = join(getRegistryDir(), '.env');
  dotenv.config({ path: envPath });
}

/**
 * Load and cache the config file from ~/.gitter/config.json.
 * Returns null if the file does not exist.
 * Throws if the file is malformed JSON.
 */
function loadConfigFile(): Record<string, unknown> | null {
  if (configFileCache !== undefined) return configFileCache;

  const configPath = join(getRegistryDir(), 'config.json');
  if (!existsSync(configPath)) {
    configFileCache = null;
    return null;
  }

  try {
    const raw = readFileSync(configPath, 'utf-8');
    configFileCache = JSON.parse(raw) as Record<string, unknown>;
    return configFileCache;
  } catch {
    throw new Error(`Config file is corrupted: ${configPath}`);
  }
}

/**
 * Resolve a configuration value from the priority chain.
 * Priority: env var (includes .env) > config.json
 */
function resolve(envVar: string, configPath: string[]): string | undefined {
  // Priority 1: Environment variable (already includes .env values via dotenv)
  const envValue = process.env[envVar];
  if (envValue !== undefined && envValue !== '') return envValue;

  // Priority 2: Config file
  const config = loadConfigFile();
  if (config) {
    let value: unknown = config;
    for (const key of configPath) {
      value = (value as Record<string, unknown>)?.[key];
    }
    if (typeof value === 'string') return value;
    if (typeof value === 'number') return String(value);
  }

  return undefined;
}

/**
 * Throw a standardized error for missing configuration.
 */
function throwMissing(envVar: string, configPath: string, description: string): never {
  throw new Error(
    `${envVar} is not set. Configure via:\n` +
    `  - Environment variable: export ${envVar}=<value>\n` +
    `  - Config file: set "${configPath}" in ~/.gitter/config.json\n` +
    `  - .env file: add ${envVar}=<value> to ~/.gitter/.env`
  );
}

/**
 * Load and validate AI configuration from environment variables,
 * .env file (in ~/.gitter/), and ~/.gitter/config.json.
 *
 * Throws on any missing required configuration. No fallback values.
 */
export function loadAIConfig(): AIConfig {
  loadDotEnv();

  const provider = resolve('GITTER_AI_PROVIDER', ['ai', 'provider']);
  if (!provider) {
    throwMissing('GITTER_AI_PROVIDER', 'ai.provider', 'AI provider');
  }

  const validProviders: AIProvider[] = ['anthropic', 'azure', 'vertex'];
  if (!validProviders.includes(provider as AIProvider)) {
    throw new Error(
      `Unknown AI provider: '${provider}'. Must be one of: anthropic, azure, vertex`
    );
  }

  const model = resolve('GITTER_AI_MODEL', ['ai', 'model']);
  if (!model) {
    throwMissing('GITTER_AI_MODEL', 'ai.model', 'AI model');
  }

  const maxTokensStr = resolve('GITTER_AI_MAX_TOKENS', ['ai', 'maxTokens']);
  if (!maxTokensStr) {
    throwMissing('GITTER_AI_MAX_TOKENS', 'ai.maxTokens', 'Max tokens');
  }
  const maxTokens = parseInt(maxTokensStr, 10);
  if (isNaN(maxTokens) || maxTokens <= 0) {
    throw new Error(
      `Invalid GITTER_AI_MAX_TOKENS value: '${maxTokensStr}'. Must be a positive integer.`
    );
  }

  const config: AIConfig = {
    provider: provider as AIProvider,
    model,
    maxTokens,
  };

  // Validate and attach provider-specific config
  switch (config.provider) {
    case 'anthropic': {
      const apiKey = resolve('ANTHROPIC_API_KEY', ['ai', 'anthropic', 'apiKey']);
      if (!apiKey) {
        throwMissing('ANTHROPIC_API_KEY', 'ai.anthropic.apiKey', 'Anthropic API key');
      }
      config.anthropic = { apiKey };
      break;
    }

    case 'azure': {
      const apiKey = resolve('ANTHROPIC_FOUNDRY_API_KEY', ['ai', 'azure', 'apiKey']);
      if (!apiKey) {
        throwMissing('ANTHROPIC_FOUNDRY_API_KEY', 'ai.azure.apiKey',
          'Azure Foundry API key');
      }
      const resource = resolve('ANTHROPIC_FOUNDRY_RESOURCE', ['ai', 'azure', 'resource']);
      if (!resource) {
        throwMissing('ANTHROPIC_FOUNDRY_RESOURCE', 'ai.azure.resource',
          'Azure Foundry resource hostname');
      }
      config.azure = { apiKey, resource };
      break;
    }

    case 'vertex': {
      const projectId = resolve('ANTHROPIC_VERTEX_PROJECT_ID',
        ['ai', 'vertex', 'projectId']);
      if (!projectId) {
        throwMissing('ANTHROPIC_VERTEX_PROJECT_ID', 'ai.vertex.projectId',
          'GCP project ID');
      }
      const region = resolve('CLOUD_ML_REGION', ['ai', 'vertex', 'region']);
      if (!region) {
        throwMissing('CLOUD_ML_REGION', 'ai.vertex.region', 'GCP region');
      }
      config.vertex = { projectId, region };
      break;
    }
  }

  return config;
}
```

**Key Design Decisions**:
- The `.env` file is loaded from `~/.gitter/.env`, NOT from CWD. This keeps all gitter configuration in one location.
- Config file is cached for the duration of the process (read once via `loadConfigFile()`).
- The `resolve()` helper abstracts the two-tier lookup so each field follows the same pattern.
- Provider validation happens before provider-specific field resolution, so the error message is clear.

---

### 10.6 Module Design: `src/ai-client.ts`

**Purpose**: Factory function creating the appropriate Claude SDK client based on provider config, plus a wrapper for `messages.create()` with error handling.

#### Imports and Type Definitions

```typescript
import Anthropic from '@anthropic-ai/sdk';
import { AnthropicFoundry } from '@anthropic-ai/foundry-sdk';
import { AnthropicVertex } from '@anthropic-ai/vertex-sdk';
import type { AIConfig } from './types.js';

/**
 * Union type of all supported Claude client instances.
 * All share the identical messages.create() API surface.
 */
type AIClient = Anthropic | AnthropicFoundry | AnthropicVertex;
```

#### Exported Function: `createAIClient(config: AIConfig): AIClient`

```typescript
/**
 * Factory function that creates the appropriate Claude SDK client
 * based on the provider specified in the AI configuration.
 *
 * @param config - Validated AI configuration (from loadAIConfig)
 * @returns A client instance with the messages.create() API
 * @throws Error if provider is unknown
 */
export function createAIClient(config: AIConfig): AIClient {
  switch (config.provider) {
    case 'anthropic':
      return new Anthropic({
        apiKey: config.anthropic!.apiKey,
      });

    case 'azure':
      return new AnthropicFoundry({
        apiKey: config.azure!.apiKey,
        resource: config.azure!.resource,
      });

    case 'vertex':
      return new AnthropicVertex({
        projectId: config.vertex!.projectId,
        region: config.vertex!.region,
      });

    default:
      throw new Error(`Unknown AI provider: ${config.provider}`);
  }
}
```

The non-null assertions (`!`) are safe because `loadAIConfig()` validates that provider-specific fields are present and throws on missing values before returning.

#### Exported Function: `generateDescription(client, config, systemPrompt, userMessage): Promise<string>`

```typescript
/**
 * Call the Claude API to generate a description and return the raw text response.
 *
 * @param client - The AI client instance (from createAIClient)
 * @param config - The AI configuration (for model and maxTokens)
 * @param systemPrompt - The system prompt instructing the AI
 * @param userMessage - The user message containing repo content
 * @returns The raw text response from Claude
 * @throws Error with user-friendly message on API failures
 */
export async function generateDescription(
  client: AIClient,
  config: AIConfig,
  systemPrompt: string,
  userMessage: string,
): Promise<string> {
  try {
    const response = await client.messages.create({
      model: config.model,
      max_tokens: config.maxTokens,
      system: systemPrompt,
      messages: [{ role: 'user', content: userMessage }],
    });

    // Extract text content from response blocks
    const textContent = response.content
      .filter((block: { type: string }) => block.type === 'text')
      .map((block: { type: string; text: string }) => block.text)
      .join('\n');

    if (!textContent) {
      throw new Error('Failed to parse AI response. Please try again.');
    }

    // Warn if response was truncated
    if (response.stop_reason === 'max_tokens') {
      process.stderr.write(
        'Warning: AI response was truncated due to max_tokens limit. ' +
        'Consider increasing GITTER_AI_MAX_TOKENS.\n'
      );
    }

    return textContent;
  } catch (error: unknown) {
    // Re-throw our own errors (e.g., empty response)
    if (error instanceof Error && error.message.startsWith('Failed to parse')) {
      throw error;
    }

    const err = error as { status?: number; message?: string; code?: string };

    if (err.status === 401 || err.status === 403) {
      throw new Error(
        'Authentication failed for Claude API. Check your API key/credentials.'
      );
    }
    if (err.status === 429) {
      throw new Error('Rate limited by Claude API. Please try again later.');
    }
    if (err.status === 500 || err.status === 503) {
      throw new Error('Claude API is temporarily unavailable. Please try again later.');
    }
    if (err.code === 'ECONNREFUSED' || err.code === 'ETIMEDOUT') {
      throw new Error(`Failed to connect to Claude API: ${err.message}`);
    }

    throw new Error(`Claude API error: ${err.message ?? 'Unknown error'}`);
  }
}
```

#### System Prompt Design

The system prompt is constructed in the `describe` command handler (Section 10.9) with interpolated line count targets:

```
You are a technical writer analyzing a software repository. Your task is to produce
two descriptions of the repository:

1. BUSINESS DESCRIPTION (~{businessLines} lines): Explain the purpose, use cases,
   target audience, and value proposition of the project. Write for a non-technical
   stakeholder or decision-maker. Focus on what problem the project solves and why
   it matters.

2. TECHNICAL DESCRIPTION (~{technicalLines} lines): Explain the architecture,
   technology stack, design patterns, and technical approach. Write for a developer
   or technical lead evaluating the project. Focus on how the project works and what
   makes it technically interesting or sound.

Output format: Use markdown. Start the business description with "## Business Description"
and the technical description with "## Technical Description". Do not include any other
top-level headings or preamble.
```

#### Refinement Prompt Design

When an existing description is present, the user message includes it in a delimited block:

```
=== EXISTING DESCRIPTION (use as starting point, refine as instructed) ===
## Business Description
{existingBusinessDescription}

## Technical Description
{existingTechnicalDescription}
=== END EXISTING DESCRIPTION ===
```

Combined with the `--instructions` option:

```
=== ADDITIONAL INSTRUCTIONS ===
{userInstructions}
=== END ADDITIONAL INSTRUCTIONS ===
```

This enables iterative refinement: the AI reads both the existing description and the user's instructions, producing an updated version each time.

---

### 10.7 Module Design: `src/repo-content.ts`

**Purpose**: Collect repository content for Claude analysis with token budget management.

#### Exported Interface: `RepoContent`

```typescript
export interface RepoContent {
  /** git ls-tree output (truncated at 500 lines) */
  fileTree: string;
  /** README content (first 200 lines) or null if no README found */
  readme: string | null;
  /** Project manifest (package.json, Cargo.toml, etc.) or null */
  manifest: string | null;
  /** Project documentation files (CLAUDE.md, .cursor/rules) -- first 100 lines each */
  projectDocs: string[];
  /** Key source file excerpts (src/main.*, src/index.*, etc.) -- first 100 lines each */
  sourceSnippets: string[];
  /** CI/CD config excerpts (.github/workflows/*.yml) -- first 50 lines each, max 3 */
  ciConfigs: string[];
}
```

#### Exported Function: `collectRepoContent(repoPath: string): RepoContent`

**Implementation Steps**:

1. **File Tree** (Priority 1 -- Required):
   - Call `git(['ls-tree', '-r', '--name-only', 'HEAD'], repoPath)` using the existing `git()` function from `src/git.ts`.
   - Truncate to first 500 lines. If truncated, append: `\n... ({remaining} more files)`.
   - If the git command fails (e.g., empty repo with no commits), set to `"(no commits yet)"`.

2. **README** (Priority 1 -- Required if exists):
   - Search for files in order: `README.md`, `README`, `README.rst`, `readme.md`.
   - Read first 200 lines of the first match found.
   - If none found, set to `null`.

3. **Manifest** (Priority 1 -- Required if exists):
   - Search for files in order: `package.json`, `Cargo.toml`, `pyproject.toml`, `go.mod`, `pom.xml`, `build.gradle`, `build.gradle.kts`, `composer.json`, `Gemfile`.
   - Read the full content of the first match found.
   - If none found, set to `null`.

4. **Project Docs** (Priority 2 -- Optional):
   - Check for: `CLAUDE.md`, `.cursor/rules`.
   - Read first 100 lines of each that exists.
   - Collect into `projectDocs` array (may be empty).

5. **Source Snippets** (Priority 2 -- Optional):
   - Use the file tree output to find entry point files matching patterns: `src/main.*`, `src/index.*`, `src/app.*`, `src/lib.*`, `main.*`, `index.*`, `app.*`.
   - Read first 100 lines of each match.
   - Collect into `sourceSnippets` array (may be empty).

6. **CI Configs** (Priority 3 -- Optional):
   - Check for `.github/workflows/` directory.
   - If it exists, list YAML files and read first 50 lines of up to 3 files.
   - Collect into `ciConfigs` array (may be empty).

#### Internal Helper: `readFileHead()`

```typescript
import { existsSync, readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { git } from './git.js';

function readFileHead(repoPath: string, relativePath: string, maxLines: number): string | null {
  const fullPath = join(repoPath, relativePath);
  if (!existsSync(fullPath)) return null;
  try {
    const content = readFileSync(fullPath, 'utf-8');
    const lines = content.split('\n');
    if (lines.length > maxLines) {
      return lines.slice(0, maxLines).join('\n') + `\n... (truncated at ${maxLines} lines)`;
    }
    return content;
  } catch {
    return null; // Silently skip unreadable files (binary, permissions, etc.)
  }
}
```

#### Exported Function: `formatRepoContentForPrompt(content: RepoContent): string`

```typescript
/**
 * Format collected repo content into a single string for the Claude user message.
 * Each section is delimited with labeled separators.
 */
export function formatRepoContentForPrompt(content: RepoContent): string {
  const sections: string[] = [];

  sections.push('--- FILE TREE ---');
  sections.push(content.fileTree);

  if (content.readme) {
    sections.push('\n--- README ---');
    sections.push(content.readme);
  }

  if (content.manifest) {
    sections.push('\n--- PROJECT MANIFEST ---');
    sections.push(content.manifest);
  }

  for (const doc of content.projectDocs) {
    sections.push('\n--- PROJECT DOCUMENTATION ---');
    sections.push(doc);
  }

  for (const snippet of content.sourceSnippets) {
    sections.push('\n--- SOURCE FILE ---');
    sections.push(snippet);
  }

  for (const ci of content.ciConfigs) {
    sections.push('\n--- CI/CD CONFIG ---');
    sections.push(ci);
  }

  return sections.join('\n');
}
```

#### Token Budget Management

**Target**: Total prompt content under ~30,000 tokens (~120KB of text, using the 4 chars/token approximation).

After collecting all content, calculate total byte size of the formatted output. If it exceeds 120,000 bytes, apply progressive truncation:

1. Remove CI configs (Priority 3) until under budget.
2. Remove source snippets (Priority 2) until under budget.
3. Remove project docs (Priority 2) until under budget.
4. Truncate README to 100 lines (instead of 200).
5. Truncate file tree to 250 lines (instead of 500).

Log to stderr: `"Content size: ~{sizeKB}KB (~{estimatedTokens} tokens)"`.

If content was truncated to fit budget, log warning to stderr: `"Warning: Repository content was truncated to fit within the token budget."`.

```typescript
const TOKEN_BUDGET_BYTES = 120_000;

/**
 * Apply progressive truncation to fit content within the token budget.
 * Modifies the content object in place and reformats.
 * Returns the formatted string.
 */
export function applyTokenBudget(content: RepoContent): string {
  let formatted = formatRepoContentForPrompt(content);
  let truncated = false;

  // Step 1: Remove CI configs
  if (Buffer.byteLength(formatted, 'utf-8') > TOKEN_BUDGET_BYTES && content.ciConfigs.length > 0) {
    content.ciConfigs = [];
    formatted = formatRepoContentForPrompt(content);
    truncated = true;
  }

  // Step 2: Remove source snippets
  if (Buffer.byteLength(formatted, 'utf-8') > TOKEN_BUDGET_BYTES && content.sourceSnippets.length > 0) {
    content.sourceSnippets = [];
    formatted = formatRepoContentForPrompt(content);
    truncated = true;
  }

  // Step 3: Remove project docs
  if (Buffer.byteLength(formatted, 'utf-8') > TOKEN_BUDGET_BYTES && content.projectDocs.length > 0) {
    content.projectDocs = [];
    formatted = formatRepoContentForPrompt(content);
    truncated = true;
  }

  // Step 4 & 5: Further truncation of README and file tree if still over budget
  // (re-read with smaller limits and re-format)

  const sizeKB = Math.round(Buffer.byteLength(formatted, 'utf-8') / 1024);
  const estimatedTokens = Math.round(Buffer.byteLength(formatted, 'utf-8') / 4);
  process.stderr.write(`Content size: ~${sizeKB}KB (~${estimatedTokens} tokens)\n`);

  if (truncated) {
    process.stderr.write('Warning: Repository content was truncated to fit within the token budget.\n');
  }

  return formatted;
}
```

---

### 10.8 Response Parsing

The Claude response is expected to contain two markdown sections. Parsing splits on the `## Technical Description` heading:

```typescript
/**
 * Parse the Claude response into business and technical description sections.
 * Expects the response to contain "## Business Description" and "## Technical Description" headings.
 *
 * @param responseText - Raw text response from Claude
 * @returns Parsed business and technical descriptions (headings stripped)
 * @throws Error if the "## Technical Description" heading is not found
 */
function parseDescription(responseText: string): { business: string; technical: string } {
  const techIndex = responseText.indexOf('## Technical Description');
  if (techIndex === -1) {
    throw new Error(
      'Failed to parse AI response: missing "## Technical Description" heading'
    );
  }

  const businessSection = responseText.substring(0, techIndex).trim();
  const technicalSection = responseText.substring(techIndex).trim();

  const business = businessSection.replace(/^## Business Description\s*/i, '').trim();
  const technical = technicalSection.replace(/^## Technical Description\s*/i, '').trim();

  return { business, technical };
}
```

---

### 10.9 Module Design: `src/commands/describe.ts`

**Purpose**: The main `gitter describe` command handler.

#### Options Interface

```typescript
interface DescribeOptions {
  show?: boolean;
  instructions?: string;
  businessLines?: string;   // Commander passes as string
  technicalLines?: string;  // Commander passes as string
}
```

#### Exported Function: `describeCommand(query: string | undefined, options: DescribeOptions): Promise<void>`

**`--show` Path**:

1. Resolve the target repository entry (see "Query Resolution" below).
2. If entry has `description` field:
   - Print formatted output with bold headers using `picocolors`:
     - `"Business Description:"` + content
     - `"Technical Description:"` + content
     - `"Description Generated:"` + timestamp
     - `"Generated By:"` + model name
     - `"Instructions Used:"` + instructions (if any)
3. If entry has NO `description` field:
   - Print: `"No description available for {repoName}. Run 'gitter describe' to generate one."`
   - Exit(0) -- informational, not an error.

**Generation Path**:

1. Resolve target repository entry.
2. Validate `existsSync(entry.localPath)`. If not, throw: `"Repository path no longer exists: {localPath}"`.
3. Call `loadAIConfig()` from `ai-config.ts`.
4. Call `createAIClient(config)` from `ai-client.ts`.
5. Call `collectRepoContent(entry.localPath)` from `repo-content.ts`.
6. Call `applyTokenBudget(content)` to get the formatted, budget-constrained string.
7. Build system prompt with interpolated `businessLines` and `technicalLines` values.
8. Build user message containing:
   - Repository name and path
   - Existing description (if present in registry)
   - User instructions (if `--instructions` provided)
   - Formatted repo content
9. Print progress to stderr: `"Generating description for {repoName}..."`.
10. Call `generateDescription(client, config, systemPrompt, userMessage)`.
11. Parse response via `parseDescription(responseText)`.
12. Build `RepoDescription` object with parsed content, timestamp, model name, and instructions.
13. **Store in registry** -- Critical: do NOT use `addOrUpdate()` which would replace the entire entry and lose branch metadata. Instead:
    ```typescript
    const registry = loadRegistry();
    const registryEntry = findByPath(registry, entry.localPath);
    if (registryEntry) {
      registryEntry.description = description;
      saveRegistry(registry);
    }
    ```
14. Display the generated description (same format as `--show` path).

#### Query Resolution Logic

**Mode A: Query provided** (`gitter describe myproject`):
1. Load registry.
2. Call `searchEntries(registry, query)`.
3. 0 matches: stderr `"No repositories match query: {query}"` + `process.exit(1)`.
4. 1 match: use that entry.
5. N matches: interactive select via stderr using `@inquirer/prompts` (same pattern as `info`, `go`).

**Mode B: No query** (`gitter describe` from within a registered repo):
1. Check `isInsideGitRepo()`. If false: stderr error + exit(1).
2. Get `getRepoRoot()` to get the repo root path.
3. Load registry.
4. Call `findByPath(registry, repoRoot)`.
5. If no match: stderr `"Current repository is not registered. Run 'gitter scan' first."` + exit(1).
6. Use the found entry.

---

### 10.10 Modifications to Existing Files

#### 10.10.1 `src/types.ts`

Add the `RepoDescription`, `AIProvider`, and `AIConfig` interfaces as specified in Section 10.4. Extend `RegistryEntry` with the optional `description?: RepoDescription` field.

**Lines changed**: ~45 new lines added after the existing `Registry` interface.

#### 10.10.2 `src/commands/info.ts`

Add a description display section at the end of the info output, after the `Last Updated` line (currently line 90).

**Code to add** (after `console.log(pc.bold('Last Updated:')...)`):

```typescript
// Description section
console.log();
if (entry.description) {
  console.log(pc.bold('--- Description ---'));
  console.log(`${pc.bold('Business Description:')}`);
  console.log(entry.description.businessDescription);
  console.log();
  console.log(`${pc.bold('Technical Description:')}`);
  console.log(entry.description.technicalDescription);
  console.log(`${pc.bold('Description Generated:')} ${entry.description.generatedAt}`);
  console.log(`${pc.bold('Generated By:')} ${entry.description.generatedBy}`);
  if (entry.description.instructions) {
    console.log(`${pc.bold('Instructions Used:')} ${entry.description.instructions}`);
  }
} else {
  console.log(`${pc.bold('Description:')} (none -- run 'gitter describe' to generate)`);
}
```

**Lines changed**: ~15 new lines inserted before the function's closing brace.

#### 10.10.3 `src/commands/scan.ts`

Preserve the `description` field across re-scans. After calling `collectRepoMetadata()` and before calling `addOrUpdate()`, carry over the existing description.

**Current code** (lines 22-29):
```typescript
const metadata = collectRepoMetadata();
const registry = loadRegistry();

const existing = findByPath(registry, metadata.localPath);
const isUpdate = existing !== undefined;

addOrUpdate(registry, metadata);
saveRegistry(registry);
```

**Modified code**:
```typescript
const metadata = collectRepoMetadata();
const registry = loadRegistry();

const existing = findByPath(registry, metadata.localPath);
const isUpdate = existing !== undefined;

// Preserve existing description across re-scans
if (existing?.description) {
  metadata.description = existing.description;
}

addOrUpdate(registry, metadata);
saveRegistry(registry);
```

**Lines changed**: +4 lines (the `if` block).

Note: `findByPath` is already imported in `scan.ts` (line 3 of the current file).

#### 10.10.4 `src/cli.ts`

Import and register the describe command.

**Import to add** (after line 7):
```typescript
import { describeCommand } from './commands/describe.js';
```

**Command registration** (add after the `init` command registration, before the default action):
```typescript
program
  .command('describe [query]')
  .description('Generate or show AI-powered repository description')
  .option('--instructions <text>', 'Additional instructions for the AI')
  .option('--show', 'Show stored description without regenerating')
  .option('--business-lines <n>', 'Target line count for business description', '20')
  .option('--technical-lines <n>', 'Target line count for technical description', '20')
  .action(describeCommand);
```

**Lines changed**: +8 lines.

Note: Commander passes options as the last argument when positional args are optional (`[query]`). The `describeCommand` function signature `(query: string | undefined, options: DescribeOptions)` handles this correctly.

---

### 10.11 Error Handling Summary

| Scenario | Message | Exit Code |
|----------|---------|:---------:|
| No AI provider configured | `"GITTER_AI_PROVIDER is not set. Configure via: ..."` | 1 |
| Missing API key for provider | `"ANTHROPIC_API_KEY is not set. Configure via: ..."` | 1 |
| AI model not configured | `"GITTER_AI_MODEL is not set. Configure via: ..."` | 1 |
| Max tokens not configured | `"GITTER_AI_MAX_TOKENS is not set. Configure via: ..."` | 1 |
| Unknown provider value | `"Unknown AI provider: '<value>'. Must be one of: anthropic, azure, vertex"` | 1 |
| Config file malformed JSON | `"Config file is corrupted: ~/.gitter/config.json"` | 1 |
| Invalid maxTokens value | `"Invalid GITTER_AI_MAX_TOKENS value: '<value>'. Must be a positive integer."` | 1 |
| Claude API auth failure (401/403) | `"Authentication failed for Claude API. Check your API key/credentials."` | 1 |
| Claude API rate limit (429) | `"Rate limited by Claude API. Please try again later."` | 1 |
| Claude API unavailable (500/503) | `"Claude API is temporarily unavailable. Please try again later."` | 1 |
| Claude API network error | `"Failed to connect to Claude API: <details>"` | 1 |
| Empty AI response | `"Failed to parse AI response. Please try again."` | 1 |
| Response missing heading | `"Failed to parse AI response: missing '## Technical Description' heading"` | 1 |
| Repo path does not exist | `"Repository path no longer exists: <path>"` | 1 |
| Not inside git repo (no query) | `"Not inside a git repository. Provide a repo name or run from within a registered git repository."` | 1 |
| Repo not registered (no query) | `"Current repository is not registered. Run 'gitter scan' first."` | 1 |
| No search matches | `"No repositories match query: <query>"` | 1 |
| `--show` with no description | `"No description available for <name>. Run 'gitter describe' to generate one."` | 0 |
| Truncated response (max_tokens) | Warning to stderr (not an error, continues) | N/A |

---

### 10.12 Implementation Units for Parallel Coding

The AI description feature can be broken into independent implementation units that can be built by separate agents without file conflicts.

#### 10.12.1 Unit Map

```
+-----------+
| Unit H    |     (prerequisite: extend types.ts with RepoDescription, AIConfig)
| types.ts  |
| extension |
+-----------+
      |
      +---> Unit I: ai-config.ts       (Agent 1) --- independent
      |
      +---> Unit J: repo-content.ts    (Agent 2) --- independent (uses git.ts)
      |
      +---> Unit K: ai-client.ts       (Agent 3) --- independent
      |
      +---------------------------------------------+
                                                     |
                                               Unit L: describe.ts
                                               (depends on I, J, K)
                                                     |
                                               Unit M: integrations
                                               (info.ts, scan.ts, cli.ts)
```

#### 10.12.2 Unit Definitions

**Unit H: Type Extensions** (`src/types.ts`)
- **Scope**: Add `RepoDescription`, `AIProvider`, `AIConfig` interfaces; extend `RegistryEntry`
- **Dependencies**: None
- **Must complete first**: All AI-related units import these types
- **Effort**: Minimal (~45 lines)
- **File conflicts**: Modifies `src/types.ts` -- must be done before other units start

**Unit I: AI Configuration** (`src/ai-config.ts`)
- **Scope**: `loadAIConfig()`, priority resolution, validation
- **Dependencies**: Unit H (for `AIConfig`, `AIProvider` types), `registry.ts` (for `getRegistryDir()`)
- **Independent of**: Units J, K
- **File**: New file `src/ai-config.ts` -- no conflicts with other agents
- **Testable independently**: Set env vars and call `loadAIConfig()`, verify returned config object

**Unit J: Repository Content Collector** (`src/repo-content.ts`)
- **Scope**: `collectRepoContent()`, `formatRepoContentForPrompt()`, `applyTokenBudget()`
- **Dependencies**: `git.ts` (for `git()` function) -- already exists, no modifications needed
- **Independent of**: Units I, K (no AI config or client dependency)
- **File**: New file `src/repo-content.ts` -- no conflicts with other agents
- **Testable independently**: Point at any git repository and verify collected content

**Unit K: AI Client Factory** (`src/ai-client.ts`)
- **Scope**: `createAIClient()`, `generateDescription()`
- **Dependencies**: Unit H (for `AIConfig` type), npm packages (`@anthropic-ai/sdk`, `@anthropic-ai/foundry-sdk`, `@anthropic-ai/vertex-sdk`)
- **Independent of**: Units I, J
- **File**: New file `src/ai-client.ts` -- no conflicts with other agents
- **Testable independently**: Create client with valid config, make a simple test API call

**Unit L: Describe Command** (`src/commands/describe.ts`)
- **Scope**: `describeCommand()` handler, `parseDescription()` helper
- **Dependencies**: Units H, I, J, K -- all must be complete
- **File**: New file `src/commands/describe.ts` -- no conflicts with other agents
- **Cannot start until**: Units I, J, K are complete (or interfaces are agreed and stubbed)

**Unit M: Existing File Integrations** (`src/commands/info.ts`, `src/commands/scan.ts`, `src/cli.ts`)
- **Scope**: Add description display to info, preserve description in scan, register describe command in CLI
- **Dependencies**: Units H (types), L (describe command export)
- **Files modified**: Three existing files -- low risk of conflict if done as a single unit
- **Can run in parallel with Unit L**: The info.ts and scan.ts changes depend only on Unit H (types), not on Unit L

#### 10.12.3 Parallel Execution Plan

```
Phase 1: Prerequisites (single agent)
  npm install @anthropic-ai/sdk @anthropic-ai/foundry-sdk @anthropic-ai/vertex-sdk dotenv
  Unit H: extend types.ts
    |
    +---> Unit I: ai-config.ts         (Agent 1)
    |
    +---> Unit J: repo-content.ts      (Agent 2)
    |
    +---> Unit K: ai-client.ts         (Agent 3)
    |
    +---> Unit M-partial: info.ts +    (Agent 4) -- only needs types
    |     scan.ts changes
    |
    +------ wait for I, J, K ----------+
                                       |
                                 Unit L: describe.ts  (single agent)
                                       |
                                 Unit M-final: cli.ts wiring
                                       |
                                 Build + Test
```

**Maximum parallelism**: 4 agents (Units I, J, K, and M-partial can all run simultaneously)
**Minimum agents needed**: 1 (sequential execution)

#### 10.12.4 Interface Contracts Between New Units

| Producer | Consumer | Contract |
|----------|----------|----------|
| `types.ts` | All AI modules | Export `RepoDescription`, `AIProvider`, `AIConfig` interfaces |
| `ai-config.ts` | `describe.ts` | `loadAIConfig(): AIConfig` -- throws on missing config |
| `ai-client.ts` | `describe.ts` | `createAIClient(config: AIConfig): AIClient` |
| `ai-client.ts` | `describe.ts` | `generateDescription(client, config, system, user): Promise<string>` |
| `repo-content.ts` | `describe.ts` | `collectRepoContent(repoPath: string): RepoContent` |
| `repo-content.ts` | `describe.ts` | `applyTokenBudget(content: RepoContent): string` |
| `describe.ts` | `cli.ts` | `describeCommand(query?: string, options?: DescribeOptions): Promise<void>` |

---

### 10.13 Configuration Guide Summary

#### Config File Schema: `~/.gitter/config.json`

This file is NOT auto-created. Users create it manually if they prefer file-based configuration over environment variables.

```json
{
  "ai": {
    "provider": "anthropic",
    "model": "claude-sonnet-4-20250514",
    "maxTokens": 4096,
    "anthropic": {
      "apiKey": "sk-ant-..."
    },
    "azure": {
      "apiKey": "...",
      "resource": "my-resource.azure.anthropic.com"
    },
    "vertex": {
      "projectId": "my-gcp-project",
      "region": "us-east5"
    }
  }
}
```

#### Configuration Options and Priority

| Priority | Source | Description |
|:--------:|--------|-------------|
| 1 (highest) | Environment variables | Shell-set vars, always take precedence |
| 2 | `.env` file in `~/.gitter/` | Loaded via dotenv; does NOT override shell env vars |
| 3 (lowest) | `~/.gitter/config.json` | JSON config file |

If a required configuration value is not found in any source, the tool throws a clear error listing all three configuration methods. No fallback or default values are permitted for any configuration setting.

#### Provider-Specific Configuration

| Provider | Required Config | Auth Method | Model Name Format |
|----------|----------------|-------------|-------------------|
| `anthropic` | `provider`, `model`, `maxTokens`, `anthropic.apiKey` | API key | `claude-sonnet-4-20250514` (dash format) |
| `azure` | `provider`, `model`, `maxTokens`, `azure.apiKey`, `azure.resource` | API key | `claude-sonnet-4-20250514` (dash format) |
| `vertex` | `provider`, `model`, `maxTokens`, `vertex.projectId`, `vertex.region` | Google ADC (no API key) | `claude-sonnet-4@20250514` (@ format) |

**Vertex AI Model Name Format**: Vertex uses `@` separator (e.g., `claude-sonnet-4@20250514`), while Anthropic and Azure use `-` (e.g., `claude-sonnet-4-20250514`). Users must configure the correct format for their provider.

**Vertex AI Authentication**: Uses Google Application Default Credentials (ADC). Requires one of:
- `gcloud auth application-default login` run locally
- `GOOGLE_APPLICATION_CREDENTIALS` env var pointing to a service account key file
- Running on GCP with an attached service account

#### API Key Expiration Tracking (Optional Enhancement)

An optional `GITTER_AI_KEY_EXPIRY` parameter (or `ai.keyExpiry` in config.json) can capture the API key expiration date in ISO 8601 format. When set, the tool logs a warning to stderr if the key expires within 7 days:
```
Warning: Your AI API key expires on 2026-04-15. Please renew it before expiration.
```

This is deferred to a future version but the config schema accommodates it.

#### Minimal `.env` Examples

**Anthropic Direct**:
```env
GITTER_AI_PROVIDER=anthropic
GITTER_AI_MODEL=claude-sonnet-4-20250514
GITTER_AI_MAX_TOKENS=4096
ANTHROPIC_API_KEY=sk-ant-...
```

**Azure AI Foundry**:
```env
GITTER_AI_PROVIDER=azure
GITTER_AI_MODEL=claude-sonnet-4-20250514
GITTER_AI_MAX_TOKENS=4096
ANTHROPIC_FOUNDRY_API_KEY=your-azure-key
ANTHROPIC_FOUNDRY_RESOURCE=my-resource.azure.anthropic.com
```

**Google Vertex AI**:
```env
GITTER_AI_PROVIDER=vertex
GITTER_AI_MODEL=claude-sonnet-4@20250514
GITTER_AI_MAX_TOKENS=4096
ANTHROPIC_VERTEX_PROJECT_ID=my-gcp-project
CLOUD_ML_REGION=us-east5
```

---

### 10.14 New Dependencies

| Package | Purpose | Type |
|---------|---------|------|
| `@anthropic-ai/sdk` | Direct Anthropic Claude API client | Production |
| `@anthropic-ai/foundry-sdk` | Azure AI Foundry (Claude on Azure) client | Production |
| `@anthropic-ai/vertex-sdk` | Google Vertex AI client | Production |
| `dotenv` | Load `.env` files for configuration resolution | Production |

**Install command**:
```bash
npm install @anthropic-ai/sdk @anthropic-ai/foundry-sdk @anthropic-ai/vertex-sdk dotenv
```

---

### 10.15 Updated File Structure

```
gitter/
|-- package.json
|-- tsconfig.json
|-- src/
|   |-- cli.ts                  # Entry point -- add describe command registration
|   |-- types.ts                # Add RepoDescription, AIProvider, AIConfig interfaces
|   |-- git.ts                  # Unchanged (reused by repo-content.ts)
|   |-- registry.ts             # Unchanged (handles arbitrary JSON transparently)
|   |-- ai-config.ts            # NEW: Config loading with priority resolution
|   |-- ai-client.ts            # NEW: Client factory + messages.create wrapper
|   |-- repo-content.ts         # NEW: Repo content collection and formatting
|   |-- commands/
|       |-- scan.ts             # Modified: preserve description across re-scans
|       |-- list.ts             # Unchanged
|       |-- search.ts           # Unchanged
|       |-- go.ts               # Unchanged
|       |-- info.ts             # Modified: add description display section
|       |-- remove.ts           # Unchanged (removing entry removes description)
|       |-- init.ts             # Unchanged
|       |-- describe.ts         # NEW: gitter describe command handler
|-- dist/
|-- node_modules/
|-- test_scripts/
|-- docs/
|   |-- design/
|   |   |-- project-design.md
|   |   |-- plan-002-ai-descriptions.md
|   |   |-- configuration-guide.md
|   |   |-- project-functions.md
|   |-- reference/
|       |-- refined-request-ai-repo-descriptions.md
|       |-- investigation-ai-integration.md
|-- Issues - Pending Items.md
```

Runtime artifacts:
```
~/.gitter/
|-- registry.json               # Persistent registry (now with optional description fields)
|-- config.json                 # Optional AI configuration file (user-created)
|-- .env                        # Optional environment variable file (user-created)
```

---

### 10.16 Updated Technology Stack

| Component | Technology | Version | Status |
|-----------|-----------|---------|--------|
| Language | TypeScript | 5.x | Existing |
| Runtime | Node.js | Latest LTS | Existing |
| Module System | ESM (`"type": "module"`) | -- | Existing |
| CLI Framework | commander.js | 14.x | Existing |
| Interactive Prompts | @inquirer/prompts | 8.x | Existing |
| Terminal Colors | picocolors | 1.x | Existing |
| Table Output | cli-table3 | 0.6.x | Existing |
| Git Interaction | child_process (built-in) | -- | Existing |
| File I/O | fs (built-in) | -- | Existing |
| Dev Runner | tsx | 4.x | Existing |
| Compiler | tsc (TypeScript) | 5.x | Existing |
| AI Client (Direct) | @anthropic-ai/sdk | latest | **New** |
| AI Client (Azure) | @anthropic-ai/foundry-sdk | latest | **New** |
| AI Client (Vertex) | @anthropic-ai/vertex-sdk | latest | **New** |
| Env File Loading | dotenv | latest | **New** |

**Production dependencies**: 8 (4 existing + 4 new)
**Dev dependencies**: 3 (unchanged)

---

### 10.17 Files Changed Summary

#### New Files

| File | Purpose | Est. Lines |
|------|---------|-----------|
| `src/ai-config.ts` | Configuration loading with three-tier priority resolution | ~120 |
| `src/ai-client.ts` | Client factory + `messages.create()` wrapper with error handling | ~90 |
| `src/repo-content.ts` | Repository content collection, formatting, and budget management | ~150 |
| `src/commands/describe.ts` | `gitter describe` command handler | ~180 |

#### Modified Files

| File | Change | Est. Lines Changed |
|------|--------|-------------------|
| `src/types.ts` | Add `RepoDescription`, `AIProvider`, `AIConfig` interfaces; extend `RegistryEntry` | +45 |
| `src/commands/info.ts` | Add description display section at end of output | +15 |
| `src/commands/scan.ts` | Preserve `description` field across re-scans | +4 |
| `src/cli.ts` | Import + register `describe` command | +8 |
| `package.json` | New dependencies (auto-updated by npm install) | auto |

#### Unchanged Files

| File | Reason |
|------|--------|
| `src/registry.ts` | Handles arbitrary JSON transparently; `description` field serializes/deserializes without changes |
| `src/git.ts` | Reused as-is; `git()` function called from `repo-content.ts` |
| `src/commands/go.ts` | No description interaction |
| `src/commands/search.ts` | No description interaction |
| `src/commands/list.ts` | No description interaction |
| `src/commands/remove.ts` | Removing an entry removes its description automatically |
| `src/commands/init.ts` | Shell function unchanged |

---

## 11. Repository Tagging Feature

### 11.1 Feature Overview

The `gitter tag` command adds a tagging system that allows users to attach arbitrary text tags to registered repositories, enabling categorization, filtering, and discovery. Tags are manageable through both the CLI and the web UI, including the ability to globally purge a tag from all repositories at once.

**Reference Documents**:
- Requirements: `docs/reference/refined-request-tag-feature.md`
- Implementation Plan: `docs/design/plan-004-tag-feature.md`
- Codebase Analysis: `docs/reference/codebase-scan-tag-feature.md`

---

### 11.2 Data Model

#### 11.2.1 RegistryEntry Extension

The `RegistryEntry` interface in `src/types.ts` is extended with an optional `tags` field. The registry schema version remains `1` since the new field is optional and fully backward-compatible.

```typescript
export interface RegistryEntry {
  // ... all existing fields unchanged ...

  /** Saved Claude Code session IDs for this repository */
  claudeSessions?: ClaudeSession[];
  /** User-assigned tags for categorization */
  tags?: string[];
}
```

The `tags` field is placed after `claudeSessions`, following the chronological order in which optional fields were added to the interface.

**Impact on Existing Code**:
- `loadRegistry()` and `saveRegistry()` require no changes -- they serialize/deserialize the full object graph via `JSON.parse`/`JSON.stringify`.
- `addOrUpdate()` replaces the full entry by `localPath`. Since `collectRepoMetadata()` does not produce a `tags` field, re-scanning would lose the tags. This is mitigated in `scan.ts` (see Section 11.5.2).
- No registry version bump is needed since the field is optional.

#### 11.2.2 Tag Validation Rules

All tag validation is enforced by a `validateTag()` function (defined in `src/commands/tag.ts` and reused by `src/ui/server.ts`).

| Rule | Description | Error Message |
|------|-------------|---------------|
| Non-empty | Tag must contain at least one non-whitespace character after trimming | `"Tag cannot be empty"` |
| Max length | Tag must not exceed 50 characters (after trimming) | `"Tag '...' exceeds maximum length of 50 characters"` |
| No commas | Tag must not contain commas (reserved for future delimiter use) | `"Tag '...' must not contain commas"` |
| Whitespace trimming | Leading and trailing whitespace is silently trimmed | N/A (not an error) |

Tags are stored in the casing provided by the user. Matching and deduplication are performed case-insensitively using `.toLowerCase()`.

```typescript
/**
 * Validate and normalize a tag string.
 * Trims whitespace, rejects empty/whitespace-only, rejects commas, enforces 50-char max.
 *
 * @param tag - Raw tag string from user input
 * @returns Trimmed tag string
 * @throws Error if tag is invalid
 */
export function validateTag(tag: string): string {
  const trimmed = tag.trim();
  if (trimmed.length === 0) {
    throw new Error('Tag cannot be empty');
  }
  if (trimmed.includes(',')) {
    throw new Error(`Tag '${trimmed}' must not contain commas`);
  }
  if (trimmed.length > 50) {
    throw new Error(`Tag '${trimmed}' exceeds maximum length of 50 characters`);
  }
  return trimmed;
}
```

#### 11.2.3 Case-Insensitive Deduplication

When adding tags, new tags are compared against existing tags using `.toLowerCase()`. If a match exists, the new tag is silently skipped (preserving the original casing of the existing tag). When removing tags, the comparison is also case-insensitive.

```typescript
/**
 * Check if a tag already exists in the array (case-insensitive).
 */
function hasTagCaseInsensitive(tags: string[], tag: string): boolean {
  return tags.some(t => t.toLowerCase() === tag.toLowerCase());
}

/**
 * Add tags to an entry with case-insensitive deduplication.
 * Modifies the entry's tags array in place.
 */
function addTagsToEntry(entry: RegistryEntry, newTags: string[]): void {
  if (!entry.tags) entry.tags = [];
  for (const tag of newTags) {
    const validated = validateTag(tag);
    if (!hasTagCaseInsensitive(entry.tags, validated)) {
      entry.tags.push(validated);
    }
  }
}

/**
 * Remove tags from an entry with case-insensitive matching.
 * Modifies the entry's tags array in place.
 */
function removeTagsFromEntry(entry: RegistryEntry, tagsToRemove: string[]): void {
  if (!entry.tags) return;
  const lowered = tagsToRemove.map(t => t.toLowerCase());
  entry.tags = entry.tags.filter(t => !lowered.includes(t.toLowerCase()));
  if (entry.tags.length === 0) delete entry.tags;
}
```

#### 11.2.4 Registry JSON Example (with Tags)

```json
{
  "version": 1,
  "repositories": [
    {
      "repoName": "gitter",
      "localPath": "/Users/giorgosmarinos/aiwork/coding-platform/gitter",
      "remotes": [
        {
          "name": "origin",
          "fetchUrl": "git@github.com:user/gitter.git",
          "pushUrl": "git@github.com:user/gitter.git"
        }
      ],
      "remoteBranches": ["origin/main"],
      "localBranches": ["main"],
      "currentBranch": "main",
      "lastUpdated": "2026-03-24T10:00:00.000Z",
      "tags": ["cli-tool", "typescript", "developer-tools"]
    }
  ]
}
```

---

### 11.3 CLI Interface: `gitter tag`

#### 11.3.1 Command Registration in `src/cli.ts`

```typescript
import { tagCommand } from './commands/tag.js';

program
  .command('tag [query]')
  .description('Add, remove, or list tags on a repository')
  .option('--add <tags...>', 'Add one or more tags')
  .option('--remove <tags...>', 'Remove one or more tags')
  .option('--list', 'List all tags across all repositories')
  .option('--eliminate <tag>', 'Remove a tag from all repositories')
  .action(tagCommand);
```

The command is registered after the `notes` command block and before the `ui` command, maintaining the logical grouping of metadata-manipulation commands.

**Note on Commander variadic options**: Commander supports `<tags...>` syntax, which collects multiple values into an array. When the user invokes `gitter tag my-repo --add backend typescript`, Commander passes `options.add` as `['backend', 'typescript']`.

#### 11.3.2 Command Options Interface

```typescript
interface TagCmdOptions {
  add?: string[];
  remove?: string[];
  list?: boolean;
  eliminate?: string;
}
```

#### 11.3.3 Subcommand Behavior Matrix

| Invocation | Behavior | Requires Query |
|-----------|----------|:--------------:|
| `gitter tag <query>` | List tags for matched repo | Yes |
| `gitter tag <query> --add <tags...>` | Add tags to matched repo | Yes |
| `gitter tag <query> --remove <tags...>` | Remove tags from matched repo | Yes |
| `gitter tag --list` | List all distinct tags globally with repo counts | No |
| `gitter tag --eliminate <tag>` | Remove tag from all repos (with confirmation) | No |

#### 11.3.4 Handler: `tagCommand(query, options)`

```typescript
/**
 * Handler for `gitter tag [query]` command.
 * Routes to the appropriate sub-operation based on options.
 *
 * @param query - Optional repo search string
 * @param options - Command options (add, remove, list, eliminate)
 */
export async function tagCommand(
  query: string | undefined,
  options: TagCmdOptions
): Promise<void>;
```

**Routing Logic**:

```
IF options.list:
    globalListTags()
ELSE IF options.eliminate:
    globalEliminateTag(options.eliminate)
ELSE IF options.add:
    entry = resolveEntry(query)
    addTagsToEntry(entry, options.add)
    save registry
    display updated tags
ELSE IF options.remove:
    entry = resolveEntry(query)
    removeTagsFromEntry(entry, options.remove)
    save registry
    display updated tags
ELSE:
    entry = resolveEntry(query)
    display entry's tags (or "no tags" message)
```

#### 11.3.5 Global List Tags (`--list`)

Iterates all registry entries, collects tags into a `Map<string, { display: string, count: number }>` keyed by lowercase tag name, then displays using `cli-table3`.

```typescript
function globalListTags(): void {
  const registry = loadRegistry();
  const tagMap = new Map<string, { display: string; count: number }>();

  for (const entry of registry.repositories) {
    if (!entry.tags) continue;
    for (const tag of entry.tags) {
      const key = tag.toLowerCase();
      const existing = tagMap.get(key);
      if (existing) {
        existing.count++;
      } else {
        tagMap.set(key, { display: tag, count: 1 });
      }
    }
  }

  if (tagMap.size === 0) {
    console.log('No tags found in any repository.');
    return;
  }

  // Sort alphabetically by tag name
  const sorted = [...tagMap.values()].sort((a, b) =>
    a.display.toLowerCase().localeCompare(b.display.toLowerCase())
  );

  // Display in a cli-table3 table with columns: Tag, Repos
  const table = new Table({ head: ['Tag', 'Repos'] });
  for (const { display, count } of sorted) {
    table.push([display, count]);
  }
  console.log(table.toString());
}
```

**Output**: Goes to stdout (consistent with `list` and `search` commands).

#### 11.3.6 Global Eliminate Tag (`--eliminate`)

```typescript
async function globalEliminateTag(tag: string): Promise<void> {
  const registry = loadRegistry();
  const target = tag.toLowerCase();

  // Find all entries with this tag
  const affected = registry.repositories.filter(
    e => e.tags?.some(t => t.toLowerCase() === target)
  );

  if (affected.length === 0) {
    process.stderr.write(`Tag '${tag}' not found in any repository.\n`);
    return;
  }

  // Prompt for confirmation
  const yes = await confirm({
    message: `Remove tag '${tag}' from ${affected.length} repositor${affected.length === 1 ? 'y' : 'ies'}?`,
  }, { output: process.stderr });

  if (!yes) {
    console.log('Cancelled.');
    return;
  }

  // Remove from all affected entries
  for (const entry of affected) {
    entry.tags = entry.tags!.filter(t => t.toLowerCase() !== target);
    if (entry.tags.length === 0) delete entry.tags;
  }

  saveRegistry(registry);
  console.log(`Tag '${tag}' removed from ${affected.length} repositor${affected.length === 1 ? 'y' : 'ies'}.`);
}
```

#### 11.3.7 Entry Resolution Pattern

The `resolveEntry` function follows the exact same pattern as `notes.ts`:

1. If `query` is provided: search registry, handle 0/1/N matches (interactive select on N).
2. If no `query`: detect CWD git repo, look up in registry.
3. `@inquirer/prompts` configured with `{ output: process.stderr }` for shell compatibility.

```typescript
async function resolveEntry(query: string | undefined): Promise<RegistryEntry> {
  const registry = loadRegistry();

  if (query) {
    const matches = searchEntries(registry, query);
    if (matches.length === 0) {
      process.stderr.write(`No repositories match query: ${query}\n`);
      process.exit(1);
    }
    if (matches.length === 1) return matches[0];
    const selectedPath = await select({
      message: 'Multiple repositories matched. Select one:',
      choices: matches.map(e => ({
        name: `${e.repoName} (${e.localPath})`,
        value: e.localPath,
      })),
    }, { output: process.stderr });
    return matches.find(e => e.localPath === selectedPath)!;
  }

  if (!isInsideGitRepo()) {
    process.stderr.write(
      'Not inside a git repository. Provide a query or run from within a registered repo.\n'
    );
    process.exit(1);
  }

  const repoRoot = getRepoRoot();
  const entry = findByPath(registry, repoRoot);
  if (!entry) {
    process.stderr.write("Current repository is not registered. Run 'gitter scan' first.\n");
    process.exit(1);
  }
  return entry;
}
```

#### 11.3.8 stdout/stderr Discipline

| Output Channel | Content |
|----------------|---------|
| **stdout** | Tag list output (single repo or global `--list`), confirmation messages |
| **stderr** | Interactive prompts (inquirer select, confirm), error messages, informational messages |

---

### 11.4 API Endpoints (for UI Mutations)

Four new endpoints are added to the `if/else if` chain in `src/ui/server.ts`.

#### 11.4.1 Endpoint Specifications

| Endpoint | Method | Request Body | Success Response | Error Responses |
|---------|--------|-------------|-----------------|-----------------|
| `GET /api/tags` | GET | -- | `{ tags: [{ name: string, count: number }] }` | 500: registry load failure |
| `POST /api/tags/add` | POST | `{ localPath: string, tags: string[] }` | `{ success: true, tags: string[] }` | 400: invalid input; 404: entry not found |
| `POST /api/tags/remove` | POST | `{ localPath: string, tags: string[] }` | `{ success: true, tags: string[] }` | 400: invalid input; 404: entry not found |
| `POST /api/tags/eliminate` | POST | `{ tag: string }` | `{ success: true, affected: number }` | 400: invalid input |

#### 11.4.2 POST Body Parsing Pattern

Since the server uses Node.js built-in `http` module (no Express), POST request bodies are parsed from the stream:

```typescript
async function parseJsonBody(req: IncomingMessage): Promise<unknown> {
  return new Promise<unknown>((resolve, reject) => {
    let data = '';
    req.on('data', (chunk: Buffer) => { data += chunk.toString(); });
    req.on('end', () => {
      try {
        resolve(JSON.parse(data));
      } catch {
        reject(new Error('Invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}
```

This helper is defined locally in `server.ts` and used by all three POST endpoints.

#### 11.4.3 `GET /api/tags` Implementation

```typescript
// Route: GET /api/tags
if (req.url === '/api/tags' && req.method === 'GET') {
  try {
    const registry = loadRegistry();
    const tagMap = new Map<string, { name: string; count: number }>();

    for (const entry of registry.repositories) {
      if (!entry.tags) continue;
      for (const tag of entry.tags) {
        const key = tag.toLowerCase();
        const existing = tagMap.get(key);
        if (existing) {
          existing.count++;
        } else {
          tagMap.set(key, { name: tag, count: 1 });
        }
      }
    }

    const tags = [...tagMap.values()].sort((a, b) =>
      a.name.toLowerCase().localeCompare(b.name.toLowerCase())
    );

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ tags }));
  } catch {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Failed to load registry' }));
  }
}
```

#### 11.4.4 `POST /api/tags/add` Implementation

```typescript
// Route: POST /api/tags/add
if (req.url === '/api/tags/add' && req.method === 'POST') {
  try {
    const body = await parseJsonBody(req) as { localPath?: string; tags?: string[] };

    if (!body.localPath || !Array.isArray(body.tags) || body.tags.length === 0) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Missing localPath or tags array' }));
      return;
    }

    // Validate each tag
    const validatedTags: string[] = [];
    for (const tag of body.tags) {
      try {
        validatedTags.push(validateTag(tag));
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: (err as Error).message }));
        return;
      }
    }

    const registry = loadRegistry();
    const entry = findByPath(registry, body.localPath);
    if (!entry) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Repository not found' }));
      return;
    }

    // Add tags with case-insensitive deduplication
    if (!entry.tags) entry.tags = [];
    for (const tag of validatedTags) {
      if (!entry.tags.some(t => t.toLowerCase() === tag.toLowerCase())) {
        entry.tags.push(tag);
      }
    }

    saveRegistry(registry);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: true, tags: entry.tags }));
  } catch {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Invalid request body' }));
  }
}
```

#### 11.4.5 `POST /api/tags/remove` Implementation

```typescript
// Route: POST /api/tags/remove
if (req.url === '/api/tags/remove' && req.method === 'POST') {
  try {
    const body = await parseJsonBody(req) as { localPath?: string; tags?: string[] };

    if (!body.localPath || !Array.isArray(body.tags) || body.tags.length === 0) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Missing localPath or tags array' }));
      return;
    }

    const registry = loadRegistry();
    const entry = findByPath(registry, body.localPath);
    if (!entry) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Repository not found' }));
      return;
    }

    // Remove tags with case-insensitive matching
    if (entry.tags) {
      const lowered = body.tags.map(t => t.toLowerCase());
      entry.tags = entry.tags.filter(t => !lowered.includes(t.toLowerCase()));
      if (entry.tags.length === 0) delete entry.tags;
    }

    saveRegistry(registry);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: true, tags: entry.tags ?? [] }));
  } catch {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Invalid request body' }));
  }
}
```

#### 11.4.6 `POST /api/tags/eliminate` Implementation

```typescript
// Route: POST /api/tags/eliminate
if (req.url === '/api/tags/eliminate' && req.method === 'POST') {
  try {
    const body = await parseJsonBody(req) as { tag?: string };

    if (!body.tag || typeof body.tag !== 'string') {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Missing tag field' }));
      return;
    }

    const registry = loadRegistry();
    const target = body.tag.toLowerCase();
    let affected = 0;

    for (const entry of registry.repositories) {
      if (!entry.tags) continue;
      const before = entry.tags.length;
      entry.tags = entry.tags.filter(t => t.toLowerCase() !== target);
      if (entry.tags.length < before) affected++;
      if (entry.tags.length === 0) delete entry.tags;
    }

    saveRegistry(registry);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: true, affected }));
  } catch {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Invalid request body' }));
  }
}
```

#### 11.4.7 Tag Validation in Server

The `validateTag()` function from `src/commands/tag.ts` is imported into `src/ui/server.ts` for consistent validation across CLI and API. The import is:

```typescript
import { validateTag } from '../commands/tag.js';
```

This avoids duplicating the validation logic while keeping it trivial to maintain.

#### 11.4.8 CORS

Not needed. The UI is served from the same origin (same HTTP server), so same-origin policy applies and no CORS headers are required.

---

### 11.5 Modifications to Existing Commands

#### 11.5.1 `src/commands/info.ts` -- Display Tags

A tags section is added to the info output, placed between the "Last Updated" line and the "Description" section. This placement groups all user-managed metadata (notes, tags) together.

```typescript
// Tags section (after Last Updated, before Description)
if (entry.tags && entry.tags.length > 0) {
  console.log(`${pc.bold('Tags:')}            ${entry.tags.map(t => pc.cyan(t)).join(', ')}`);
} else {
  console.log(`${pc.bold('Tags:')}            (none -- run 'gitter tag' to add)`);
}
```

Tags are displayed in cyan and comma-separated. When no tags exist, a hint message directs the user to the `tag` command.

#### 11.5.2 `src/commands/scan.ts` -- Preserve Tags

One line is added to the existing field preservation block, following the exact pattern used for `description`, `notes`, and `claudeSessions`:

```typescript
// Existing preservation block:
if (existing?.description) metadata.description = existing.description;
if (existing?.notes) metadata.notes = existing.notes;
if (existing?.claudeSessions) metadata.claudeSessions = existing.claudeSessions;
// NEW: Preserve tags
if (existing?.tags) metadata.tags = existing.tags;
```

This ensures that running `gitter scan` inside a tagged repo does not lose its tags.

---

### 11.6 UI Changes (`src/ui/html.ts`)

The web UI is a single-page HTML app served as a template literal from `src/ui/html.ts`. All UI changes are made within this file's template literal.

#### 11.6.1 State Object Extension

The state object (currently at line 244 of `html.ts`) is extended with tag-related state:

```javascript
const state = {
  repos: [],
  filtered: [],
  selected: null,
  searchQuery: '',
  sortField: 'repoName',
  sortDir: 'asc',
  filters: { hasDesc: false, noDesc: false, hasNotes: false, noNotes: false },
  // NEW: Tag filtering state
  selectedTags: [],     // Array of lowercase tag strings currently selected for filtering
  availableTags: [],    // Array of { name: string, count: number } for the filter UI
};
```

#### 11.6.2 Tag Badges in Repo Cards (renderList)

In the `renderList()` function, after existing repo-meta indicators (description, notes badges), tags are rendered as inline badges:

```html
<!-- Inside each repo card's .repo-meta div -->
${repo.tags ? repo.tags.map(t =>
  `<span class="tag-badge" data-tag="${t.toLowerCase()}"
         onclick="event.stopPropagation(); toggleTagFilter('${t.toLowerCase()}')"
   >${t}</span>`
).join('') : ''}
```

Clicking a tag badge on a repo card toggles the tag filter (same behavior as clicking in the filter bar).

#### 11.6.3 CSS for Tag Badges

The existing CSS already defines `--tag-bg` and `--tag-text` CSS variables (lines 30-31 of `html.ts`). The tag badge styles use these:

```css
.tag-badge {
  display: inline-block;
  padding: 2px 8px;
  margin: 1px 3px;
  border-radius: 12px;
  font-size: 0.75rem;
  background: var(--tag-bg);
  color: var(--tag-text);
  cursor: pointer;
  transition: opacity 0.15s;
}

.tag-badge:hover {
  opacity: 0.8;
}

.tag-filter-bar {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  padding: 8px 0;
}

.tag-chip {
  display: inline-flex;
  align-items: center;
  padding: 4px 10px;
  border-radius: 14px;
  font-size: 0.8rem;
  background: var(--tag-bg);
  color: var(--tag-text);
  cursor: pointer;
  transition: all 0.15s;
  border: 1px solid transparent;
}

.tag-chip.active {
  border-color: var(--accent);
  background: var(--accent);
  color: #fff;
}

.tag-chip .tag-count {
  margin-left: 4px;
  opacity: 0.7;
  font-size: 0.7rem;
}

.tag-chip .tag-eliminate {
  margin-left: 6px;
  font-size: 0.65rem;
  opacity: 0.5;
  cursor: pointer;
}

.tag-chip .tag-eliminate:hover {
  opacity: 1;
  color: #e74c3c;
}

.tag-input-group {
  display: flex;
  gap: 6px;
  margin-top: 6px;
  align-items: center;
}

.tag-input-group input {
  padding: 4px 8px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--surface);
  color: var(--text);
  font-size: 0.85rem;
  flex: 1;
}

.tag-input-group button {
  padding: 4px 12px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--accent);
  color: #fff;
  font-size: 0.85rem;
  cursor: pointer;
}

.detail-tag-badge {
  display: inline-flex;
  align-items: center;
  padding: 3px 10px;
  margin: 2px 4px;
  border-radius: 12px;
  font-size: 0.8rem;
  background: var(--tag-bg);
  color: var(--tag-text);
}

.detail-tag-badge .remove-tag {
  margin-left: 6px;
  cursor: pointer;
  font-weight: bold;
  opacity: 0.6;
}

.detail-tag-badge .remove-tag:hover {
  opacity: 1;
  color: #e74c3c;
}
```

#### 11.6.4 Tag Filter Bar in Header

A collapsible tag filter section is added below the existing filter buttons in the header/toolbar area. This avoids overcrowding the existing button row.

```html
<!-- Tag filter bar (below existing filter buttons) -->
<div class="tag-filter-bar" id="tagFilterBar">
  <!-- Populated dynamically by renderTagFilters() -->
</div>
```

**`renderTagFilters()` function**:

```javascript
function renderTagFilters() {
  const bar = document.getElementById('tagFilterBar');
  if (state.availableTags.length === 0) {
    bar.innerHTML = '';
    return;
  }

  bar.innerHTML = state.availableTags.map(tag =>
    `<span class="tag-chip ${state.selectedTags.includes(tag.name.toLowerCase()) ? 'active' : ''}"
           onclick="toggleTagFilter('${tag.name.toLowerCase()}')"
     >${tag.name}<span class="tag-count">(${tag.count})</span>` +
     `<span class="tag-eliminate" onclick="event.stopPropagation(); eliminateTag('${tag.name}')"
            title="Remove from all repos">x</span>` +
     `</span>`
  ).join('') +
  (state.selectedTags.length > 0
    ? '<span class="tag-chip" onclick="clearTagFilters()" style="opacity:0.7">Clear</span>'
    : '');
}
```

#### 11.6.5 Tag Filtering Logic (applyFilters)

Tag filtering is added as an additional filter stage in the existing `applyFilters()` function, after the existing text search and toggle filter stages. Tag filtering uses OR logic: a repo is shown if it has at least one of the selected tags.

```javascript
// Inside applyFilters(), after existing filter stages:

// Tag filter (OR logic: show repos matching ANY selected tag)
if (state.selectedTags.length > 0) {
  filtered = filtered.filter(repo => {
    if (!repo.tags || repo.tags.length === 0) return false;
    return repo.tags.some(t => state.selectedTags.includes(t.toLowerCase()));
  });
}
```

Tag filter composes as AND with other filters: the result set from text search and toggle filters is further narrowed by the tag filter. This is consistent with how existing filters compose.

**`toggleTagFilter()` function**:

```javascript
function toggleTagFilter(tag) {
  const index = state.selectedTags.indexOf(tag);
  if (index === -1) {
    state.selectedTags.push(tag);
  } else {
    state.selectedTags.splice(index, 1);
  }
  applyFilters();
  renderTagFilters();
}

function clearTagFilters() {
  state.selectedTags = [];
  applyFilters();
  renderTagFilters();
}
```

#### 11.6.6 Available Tags Computation

After `fetchRegistry()` completes and populates `state.repos`, the available tags are computed client-side from the loaded data (no separate API call needed, since the data is already present):

```javascript
function computeAvailableTags() {
  const tagMap = new Map();
  for (const repo of state.repos) {
    if (!repo.tags) continue;
    for (const tag of repo.tags) {
      const key = tag.toLowerCase();
      const existing = tagMap.get(key);
      if (existing) {
        existing.count++;
      } else {
        tagMap.set(key, { name: tag, count: 1 });
      }
    }
  }
  state.availableTags = [...tagMap.values()].sort((a, b) =>
    a.name.toLowerCase().localeCompare(b.name.toLowerCase())
  );
}
```

This function is called immediately after `state.repos` is updated in `fetchRegistry()`:

```javascript
async function fetchRegistry() {
  const res = await fetch('/api/registry');
  const data = await res.json();
  state.repos = data.repositories;
  computeAvailableTags();   // <-- NEW
  applyFilters();
  renderTagFilters();       // <-- NEW
}
```

#### 11.6.7 Tag Management in Detail View (renderDetail)

In the `renderDetail()` function, a "Tags" section is added showing all tags as removable badges with an add-tag input:

```html
<!-- Tags section in detail view -->
<div class="detail-section">
  <h3>Tags</h3>
  <div id="detailTags">
    ${(repo.tags || []).map(t =>
      `<span class="detail-tag-badge">${t}
         <span class="remove-tag" onclick="removeTagFromRepo('${repo.localPath}', '${t}')"
               title="Remove tag">x</span>
       </span>`
    ).join('') || '<span style="opacity:0.5">No tags</span>'}
  </div>
  <div class="tag-input-group">
    <input type="text" id="newTagInput" placeholder="Add a tag..."
           onkeydown="if(event.key==='Enter') addTagToRepo('${repo.localPath}')">
    <button onclick="addTagToRepo('${repo.localPath}')">Add</button>
  </div>
</div>
```

**JavaScript functions for tag mutations**:

```javascript
async function addTagToRepo(localPath) {
  const input = document.getElementById('newTagInput');
  const tag = input.value.trim();
  if (!tag) return;

  const res = await fetch('/api/tags/add', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ localPath, tags: [tag] }),
  });

  if (!res.ok) {
    const err = await res.json();
    alert(err.error || 'Failed to add tag');
    return;
  }

  input.value = '';
  await fetchRegistry();
  // Re-render detail view for the same repo
  const updated = state.repos.find(r => r.localPath === localPath);
  if (updated) renderDetail(updated);
}

async function removeTagFromRepo(localPath, tag) {
  const res = await fetch('/api/tags/remove', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ localPath, tags: [tag] }),
  });

  if (!res.ok) {
    const err = await res.json();
    alert(err.error || 'Failed to remove tag');
    return;
  }

  await fetchRegistry();
  const updated = state.repos.find(r => r.localPath === localPath);
  if (updated) renderDetail(updated);
}
```

#### 11.6.8 Tag Elimination from UI

Tag elimination is triggered by clicking the "x" on a tag chip in the filter bar. A confirmation dialog is shown before proceeding:

```javascript
async function eliminateTag(tagName) {
  if (!confirm(`Remove tag "${tagName}" from ALL repositories?`)) return;

  const res = await fetch('/api/tags/eliminate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tag: tagName }),
  });

  if (!res.ok) {
    const err = await res.json();
    alert(err.error || 'Failed to eliminate tag');
    return;
  }

  const result = await res.json();
  // Remove from selectedTags if it was selected
  state.selectedTags = state.selectedTags.filter(t => t !== tagName.toLowerCase());

  await fetchRegistry();
  // If detail view is showing, refresh it
  if (state.selected) {
    const updated = state.repos.find(r => r.localPath === state.selected.localPath);
    if (updated) renderDetail(updated);
  }
}
```

The browser's native `confirm()` dialog is used (consistent with the lightweight, no-external-dependencies approach of the UI).

---

### 11.7 Data Flow: `gitter tag my-repo --add backend typescript`

```
query "my-repo" --> registry.searchEntries()
                       |
                       |--> 0 matches: stderr "No match", exit(1)
                       |--> 1 match: use that entry
                       |--> N matches: inquirer.select() via stderr
                       |
                       v
                     resolve to single RegistryEntry
                       |
                       v
                     validateTag("backend") --> "backend"
                     validateTag("typescript") --> "typescript"
                       |
                       v
                     Check case-insensitive duplicates
                       |
                       |--> "backend" not in entry.tags --> append
                       |--> "typescript" not in entry.tags --> append
                       |
                       v
                     loadRegistry() (re-load for atomic mutation)
                       |
                       v
                     findByPath(registry, entry.localPath)
                       |
                       v
                     Mutate entry.tags in place
                       |
                       v
                     saveRegistry(registry) [atomic write]
                       |
                       v
                     Print: "Tags for my-repo: backend, typescript"
```

### 11.8 Data Flow: UI Tag Add via API

```
User types "frontend" in detail view input --> clicks "Add"
       |
       v
fetch('/api/tags/add', { localPath, tags: ['frontend'] })
       |
       v
Server: parseJsonBody(req)
       |
       v
Server: validateTag('frontend') --> 'frontend'
       |
       v
Server: loadRegistry() --> findByPath(localPath)
       |
       |--> 404 if not found
       |
       v
Server: case-insensitive dedup check --> append if new
       |
       v
Server: saveRegistry(registry) [atomic write]
       |
       v
Server: respond { success: true, tags: [...] }
       |
       v
Client: fetchRegistry() --> re-renders list + detail view
```

---

### 11.9 Error Handling Summary

| Scenario | Message | Exit Code / HTTP Status |
|----------|---------|:-----------------------:|
| Empty tag string | `"Tag cannot be empty"` | 1 / 400 |
| Tag exceeds 50 characters | `"Tag '...' exceeds maximum length of 50 characters"` | 1 / 400 |
| Tag contains comma | `"Tag '...' must not contain commas"` | 1 / 400 |
| No search matches (CLI) | `"No repositories match query: <query>"` | 1 |
| Tag not found in any repo (`--eliminate`) | `"Tag '<tag>' not found in any repository."` | 0 (informational) |
| User cancels elimination | `"Cancelled."` | 0 |
| Missing localPath or tags in API request | `"Missing localPath or tags array"` | 400 |
| Repository not found (API) | `"Repository not found"` | 404 |
| Invalid JSON body (API) | `"Invalid request body"` | 400 |
| Missing tag field in eliminate request (API) | `"Missing tag field"` | 400 |
| Registry load failure (API) | `"Failed to load registry"` | 500 |
| Not inside git repo (no query, CLI) | `"Not inside a git repository..."` | 1 |
| Repo not registered (no query, CLI) | `"Current repository is not registered..."` | 1 |

---

### 11.10 Module Design: `src/commands/tag.ts`

**Purpose**: CLI tag command handler providing add, remove, list, and eliminate operations.

#### Imports

```typescript
import { select, confirm } from '@inquirer/prompts';
import pc from 'picocolors';
import Table from 'cli-table3';
import { loadRegistry, saveRegistry, findByPath, searchEntries } from '../registry.js';
import { isInsideGitRepo, getRepoRoot } from '../git.js';
import type { RegistryEntry } from '../types.js';
```

#### Exported Functions

```typescript
/**
 * Validate and normalize a tag string.
 * Exported for reuse by server.ts.
 */
export function validateTag(tag: string): string;

/**
 * Handler for `gitter tag [query]` command.
 */
export async function tagCommand(
  query: string | undefined,
  options: TagCmdOptions
): Promise<void>;
```

#### Internal Functions

```typescript
function hasTagCaseInsensitive(tags: string[], tag: string): boolean;
function addTagsToEntry(entry: RegistryEntry, newTags: string[]): void;
function removeTagsFromEntry(entry: RegistryEntry, tagsToRemove: string[]): void;
async function resolveEntry(query: string | undefined): Promise<RegistryEntry>;
function globalListTags(): void;
async function globalEliminateTag(tag: string): Promise<void>;
```

All functions are specified in detail in Sections 11.2.3, 11.3.4 through 11.3.7.

---

### 11.11 Implementation Units for Parallel Coding

#### 11.11.1 Unit Map

```
Phase 1.1 (types.ts -- add tags field)
    |
    +--------+------------------+
    |        |                  |
    v        v                  v
Phase 1.2  Phase 1.3          Phase 2.1 (server.ts -- API endpoints)
(scan.ts)  (tag.ts)            |
    |        |                  v
    v        v             Phase 2.2 (html.ts -- tag display)
Phase 1.4  Phase 1.5           |
(cli.ts)   (info.ts)           v
    |        |             Phase 2.3 (html.ts -- tag filtering)
    +--------+                  |
    |                           v
    |                      Phase 2.4 (html.ts -- tag elimination)
    |                           |
    +---------------------------+
    |
    v
Phase 3.1 (test_scripts/test-tags.ts)
```

#### 11.11.2 Unit Definitions

**Unit N: Type Extension** (`src/types.ts`)
- **Scope**: Add `tags?: string[]` to `RegistryEntry` interface
- **Dependencies**: None
- **Must complete first**: All tag-related units reference the `tags` field
- **Effort**: Minimal (1 line + 1 JSDoc line)
- **File conflicts**: Modifies `src/types.ts` -- must be done before other units start

**Unit O: Tag Command Handler** (`src/commands/tag.ts`)
- **Scope**: New file with `validateTag()`, `tagCommand()`, and all helper functions
- **Dependencies**: Unit N (for `tags` field on `RegistryEntry`)
- **Independent of**: Units P, Q (UI units)
- **File**: New file `src/commands/tag.ts` -- no conflicts with other agents
- **Testable independently**: Can be tested via CLI invocations once registered

**Unit P: Scan + Info Modifications** (`src/commands/scan.ts`, `src/commands/info.ts`)
- **Scope**: Add tag preservation in scan, add tag display in info
- **Dependencies**: Unit N (for `tags` field)
- **Independent of**: Units O, Q
- **File conflicts**: Modifies two existing files -- low risk, small changes (1 line in scan, 5 lines in info)

**Unit Q: CLI Registration** (`src/cli.ts`)
- **Scope**: Import and register `tag` command
- **Dependencies**: Unit O (for `tagCommand` export)
- **File conflicts**: Modifies `src/cli.ts` -- small change (import + registration block)

**Unit R: API Endpoints** (`src/ui/server.ts`)
- **Scope**: Add 4 API endpoints + `parseJsonBody` helper + import `validateTag`
- **Dependencies**: Units N and O (for types and `validateTag`)
- **Independent of**: Unit S (UI display can proceed in parallel)
- **File conflicts**: Modifies `src/ui/server.ts` -- extends the if/else chain

**Unit S: UI Implementation** (`src/ui/html.ts`)
- **Scope**: Tag badges, filter bar, detail view tag management, elimination dialog
- **Dependencies**: Unit R (needs API endpoints to be available for fetch calls)
- **File conflicts**: Modifies `src/ui/html.ts` -- significant additions to CSS, state, and render functions

**Unit T: Tests** (`test_scripts/test-tags.ts`)
- **Scope**: 21 test cases covering validation, add, remove, list, eliminate, scan preservation, info display
- **Dependencies**: All other units must be complete
- **File**: New file -- no conflicts

#### 11.11.3 Parallel Execution Plan

```
Unit N: types.ts extension (single agent, fast)
    |
    +---> Unit O: tag.ts           (Agent 1) ---|
    |                                          |
    +---> Unit P: scan.ts + info.ts (Agent 2) -|--- wait for O --->  Unit Q: cli.ts
    |                                          |
    +---> Unit R: server.ts        (Agent 3) --|--- wait for R --->  Unit S: html.ts
                                               |
                                               +--- wait for all --> Unit T: tests
```

**Maximum parallelism**: 3 agents (Units O, P, R can run simultaneously after Unit N)
**Minimum agents needed**: 1 (sequential execution through all units)

#### 11.11.4 Interface Contracts Between Units

| Producer | Consumer | Contract |
|----------|----------|----------|
| `types.ts` | All tag modules | `RegistryEntry` has `tags?: string[]` |
| `tag.ts` | `cli.ts` | `tagCommand(query?: string, options?: TagCmdOptions): Promise<void>` |
| `tag.ts` | `server.ts` | `validateTag(tag: string): string` (exported for import) |
| `server.ts` | `html.ts` | `POST /api/tags/add`, `POST /api/tags/remove`, `POST /api/tags/eliminate`, `GET /api/tags` |
| `registry.ts` | `tag.ts`, `server.ts` | `loadRegistry()`, `saveRegistry()`, `findByPath()`, `searchEntries()` (existing, unchanged) |

---

### 11.12 Files Changed Summary

#### New Files

| File | Unit | Purpose | Est. Lines |
|------|------|---------|-----------|
| `src/commands/tag.ts` | O | CLI tag command handler with validation, add, remove, list, eliminate | ~160 |
| `test_scripts/test-tags.ts` | T | Tag feature test suite (21 tests) | ~300 |

#### Modified Files

| File | Unit | Change | Est. Lines Changed |
|------|------|--------|-------------------|
| `src/types.ts` | N | Add `tags?: string[]` to `RegistryEntry` | +2 |
| `src/commands/scan.ts` | P | Add tag preservation line | +1 |
| `src/commands/info.ts` | P | Add tags display section | +5 |
| `src/cli.ts` | Q | Import + register `tag` command | +8 |
| `src/ui/server.ts` | R | Add 4 API endpoints, `parseJsonBody` helper, import `validateTag` | +100 |
| `src/ui/html.ts` | S | CSS for tag badges/chips, state extension, filter bar, detail view tags, JS functions | +200 |

#### Unchanged Files

| File | Reason |
|------|--------|
| `src/registry.ts` | Handles arbitrary JSON transparently; `tags` field serializes/deserializes without changes |
| `src/git.ts` | No tag interaction |
| `src/ai-config.ts` | No tag interaction |
| `src/ai-client.ts` | No tag interaction |
| `src/repo-content.ts` | No tag interaction |
| `src/commands/go.ts` | No tag interaction |
| `src/commands/search.ts` | No tag interaction (future enhancement) |
| `src/commands/list.ts` | No tag interaction (could show tag count later) |
| `src/commands/remove.ts` | Removing an entry removes its tags automatically |
| `src/commands/init.ts` | Shell function unchanged |
| `src/commands/describe.ts` | No tag interaction |
| `src/commands/rename.ts` | No tag interaction |
| `src/commands/notes.ts` | No tag interaction |
| `src/commands/remember-claude.ts` | No tag interaction |

---

### 11.13 Verification Criteria

#### After Unit O + P + Q completion (CLI):

1. `npx tsc --noEmit` compiles without errors
2. `gitter tag my-repo --add backend typescript` adds both tags to the matched repo
3. `gitter tag my-repo` lists "backend" and "typescript"
4. `gitter tag my-repo --remove backend` removes only "backend"
5. `gitter tag --list` shows "typescript" with count 1
6. `gitter tag --eliminate typescript` (after confirmation) removes from all repos
7. `gitter info my-repo` shows a Tags line with the remaining tags
8. Running `gitter scan` inside a tagged repo preserves tags
9. All 6 existing test suites pass (62+ tests total)

#### After Unit R + S completion (UI):

10. `gitter ui` serves the web page with tag badges on repo cards
11. Clicking a tag badge in a repo card or filter bar narrows the list to matching repos
12. Multiple tags can be selected (OR logic: repos matching ANY selected tag are shown)
13. "Clear" button deselects all tag filters
14. In the detail view, adding a tag via the input field persists (verified by page reload)
15. In the detail view, clicking "x" on a tag badge removes it and persists
16. Clicking "x" on a tag chip in the filter bar triggers elimination with confirmation
17. After elimination, the tag disappears from all repo cards and the filter bar
18. API endpoints respond correctly: `GET /api/tags`, `POST /api/tags/add`, `POST /api/tags/remove`, `POST /api/tags/eliminate`

#### After Unit T completion (Tests):

19. `npx tsx test_scripts/test-tags.ts` passes all 21 tests
20. All 6 existing test suites continue to pass

---

### 11.14 Open Decisions

| # | Decision | Recommendation |
|---|----------|---------------|
| 1 | Tag filter logic: OR vs AND when multiple tags selected | Use OR logic (match ANY selected tag) as specified in requirements. AND filtering can be added later via a toggle. |
| 2 | Show tags in `gitter list` table output | Show tag count in list table (e.g., "3 tags") to avoid width issues. Full tag display in `info` only. Deferred to future enhancement. |
| 3 | Tag validation utility location | Export `validateTag()` from `src/commands/tag.ts` and import in `server.ts`. Avoids a separate utility file for a trivial function. |
| 4 | UI tag filter placement | Place tag chips in a collapsible row below the existing filter buttons, to avoid overcrowding the header. |
| 5 | Tag rename globally | Not included in this feature. Can be added later as `gitter tag --rename old new`. |

---

### 11.15 Risk Assessment

| Risk | Mitigation |
|------|-----------|
| Commander variadic option parsing edge cases | Test `--add` with single and multiple tags; verify Commander handles `<tags...>` correctly |
| Case-insensitive tag matching inconsistency between CLI and UI | Use the same `.toLowerCase()` comparison in both `tag.ts` and server API endpoints |
| HTML template literal size growth (`html.ts` is already large) | Keep additions modular; use helper functions within the template's JavaScript section |
| Tag filter interaction with existing filters (search, toggles) | Tag filter composes as AND with other filters (same as existing filter composition pattern) |
| POST body parsing reliability in Node.js HTTP server | Handle JSON parse errors with try/catch and return 400; `parseJsonBody` helper centralizes parsing |
| Concurrent registry writes from UI (rapid tag clicks) | Each API endpoint does load-mutate-save atomically; race conditions are unlikely for single-user usage but could theoretically lose writes if two requests overlap. Acceptable for the single-user scenario. |

---

## 12. User Description Feature

### 12.1 Feature Overview

The `gitter user-desc` command allows users to attach a free-text description to any registered repository. Unlike the AI-generated `description` (business + technical, populated by the `describe` command), the user description is authored entirely by the user. Its purpose is to help users quickly recognize repositories and improve searchability across the registry.

The feature follows the same patterns established by the `notes` command: editor-based input, `--show` and `--clear` options, scan preservation, and direct registry mutation.

**Reference Documents**:
- Requirements: `docs/reference/refined-request-user-description.md`
- Implementation Plan: `docs/design/plan-005-user-description.md`

---

### 12.2 Data Model

#### 12.2.1 RegistryEntry Extension

The `RegistryEntry` interface in `src/types.ts` is extended with an optional `userDescription` field. The registry schema version remains `1` since the new field is optional and fully backward-compatible.

```typescript
export interface RegistryEntry {
  // ... all existing fields unchanged ...

  /** User-authored description for recognition and search */
  userDescription?: string;
}
```

**Field Placement**: Top-level on `RegistryEntry`, NOT nested inside `RepoDescription`. The AI-generated `RepoDescription` carries provenance metadata (`generatedAt`, `generatedBy`). The user description is user-authored and does not need such metadata.

**Impact on Existing Code**:
- `loadRegistry()` and `saveRegistry()` require no changes -- they serialize/deserialize the full object graph via `JSON.parse`/`JSON.stringify`.
- `addOrUpdate()` replaces the full entry by `localPath`. Since `collectRepoMetadata()` does not produce a `userDescription` field, re-scanning would lose it. This is mitigated in `scan.ts` (see Section 12.5).
- No registry version bump is needed since the field is optional.

---

### 12.3 Module Design: `src/commands/user-desc.ts`

**Purpose**: Command handler for `gitter user-desc [query]` -- add, edit, view, or remove a user-authored description on a repository.

**Pattern**: Follows `src/commands/notes.ts` exactly.

#### Interface and Options

```typescript
interface UserDescCmdOptions {
  show?: boolean;
  clear?: boolean;
}

export async function userDescCommand(
  query: string | undefined,
  options: UserDescCmdOptions
): Promise<void>;
```

#### resolveEntry Helper

Copied from `notes.ts` (same logic):
1. If `query` provided: search registry, handle 0/1/N matches (interactive select on N).
2. If no query: check if CWD is inside a registered git repo, return that entry.
3. Errors: no match -> stderr + exit(1), not in repo -> stderr + exit(1), not registered -> stderr + exit(1).

#### Command Logic

```
userDescCommand(query, options):
    entry = resolveEntry(query)

    if options.show:
        if entry.userDescription:
            console.log(entry.userDescription)
        else:
            console.log("No user description set for <repoName>. Run 'gitter user-desc' to add one.")
        return

    if options.clear:
        if !entry.userDescription:
            console.log("No user description to clear for <repoName>.")
            return
        confirmed = await confirm("Clear user description for <repoName>?", { output: stderr })
        if !confirmed:
            console.log("Cancelled.")
            return
        registry = loadRegistry()
        registryEntry = findByPath(registry, entry.localPath)
        delete registryEntry.userDescription
        saveRegistry(registry)
        console.log("User description cleared for <repoName>.")
        return

    // Default: open editor
    updatedDesc = await editor({
        message: "Edit user description for <repoName> (save and close editor when done):",
        default: entry.userDescription ?? '',
        postfix: '.md',
    })

    trimmed = updatedDesc.trim()
    registry = loadRegistry()
    registryEntry = findByPath(registry, entry.localPath)
    if trimmed:
        registryEntry.userDescription = trimmed
    else:
        delete registryEntry.userDescription
    saveRegistry(registry)

    if trimmed:
        console.log("User description saved for <repoName>.")
    else:
        console.log("User description cleared for <repoName>.")
```

---

### 12.4 CLI Registration (`src/cli.ts`)

```typescript
import { userDescCommand } from './commands/user-desc.js';

program
  .command('user-desc [query]')
  .description('Add, edit, or view user description for a repository')
  .option('--show', 'Display stored user description without opening editor')
  .option('--clear', 'Remove user description')
  .action(userDescCommand);
```

---

### 12.5 Scan Preservation (`src/commands/scan.ts`)

In the scan command, preserve `userDescription` from the existing entry when re-scanning:

```typescript
if (existing?.userDescription) {
  metadata.userDescription = existing.userDescription;
}
```

This follows the identical pattern used for `description`, `notes`, `claudeSessions`, and `tags`.

---

### 12.6 Info Display (`src/commands/info.ts`)

A new "User Description" section is inserted **above** the existing "Description" section. The full display order becomes:

1. Repository metadata (name, path, remotes, branches, current branch, last updated)
2. **User Description** (new)
3. Description (business + technical)
4. Tags
5. Claude Sessions
6. Notes

```typescript
// User Description section (inserted before existing Description section)
console.log();
if (entry.userDescription) {
  console.log(pc.bold('--- User Description ---'));
  console.log(entry.userDescription);
} else {
  console.log(`${pc.bold('User Description:')} (none -- run 'gitter user-desc' to add)`);
}
```

---

### 12.7 Search Extension (`src/registry.ts`)

Extend `searchEntries()` to include `userDescription` in the case-insensitive partial match:

```typescript
export function searchEntries(registry: Registry, query: string): RegistryEntry[] {
  const q = query.toLowerCase();
  return registry.repositories.filter(entry => {
    if (entry.repoName.toLowerCase().includes(q)) return true;
    if (entry.localPath.toLowerCase().includes(q)) return true;
    // NEW: match against user description
    if (entry.userDescription?.toLowerCase().includes(q)) return true;
    for (const remote of entry.remotes) {
      if (remote.fetchUrl.toLowerCase().includes(q)) return true;
      if (remote.pushUrl.toLowerCase().includes(q)) return true;
    }
    return false;
  });
}
```

---

### 12.8 Web UI

#### 12.8.1 API Endpoints (`src/ui/server.ts`)

Two new endpoints following the existing pattern:

| Endpoint | Method | Request Body | Response |
|---------|--------|-------------|----------|
| `POST /api/user-desc` | POST | `{ localPath: string, userDescription: string }` | `{ success: true }` |
| `DELETE /api/user-desc` | DELETE | `{ localPath: string }` | `{ success: true }` |

Implementation:

```typescript
// POST /api/user-desc
if (req.method === 'POST' && url === '/api/user-desc') {
  const body = await parseJsonBody(req);
  const { localPath, userDescription } = body;
  if (!localPath) return sendJson(res, 400, { error: 'localPath is required' });

  const registry = loadRegistry();
  const entry = findByPath(registry, localPath);
  if (!entry) return sendJson(res, 404, { error: 'Repository not found' });

  if (userDescription && userDescription.trim()) {
    entry.userDescription = userDescription.trim();
  } else {
    delete entry.userDescription;
  }
  saveRegistry(registry);
  return sendJson(res, 200, { success: true });
}

// DELETE /api/user-desc
if (req.method === 'DELETE' && url === '/api/user-desc') {
  const body = await parseJsonBody(req);
  const { localPath } = body;
  if (!localPath) return sendJson(res, 400, { error: 'localPath is required' });

  const registry = loadRegistry();
  const entry = findByPath(registry, localPath);
  if (!entry) return sendJson(res, 404, { error: 'Repository not found' });

  delete entry.userDescription;
  saveRegistry(registry);
  return sendJson(res, 200, { success: true });
}
```

#### 12.8.2 Detail View (`src/ui/html.ts`)

In the detail panel rendering, the user description is displayed **above** the business description:

1. **Display**: When `userDescription` is present, render it under a "User Description" heading. When absent, show no placeholder.
2. **Edit**: Textarea pre-populated with current value. "Save" button sends POST, "Clear" button sends DELETE. After mutation, refresh the detail view.

The user description section is placed in the HTML between the repository metadata and the AI-generated description, matching the CLI display order.

---

### 12.9 Updated File Structure

```
src/
|-- commands/
|   |-- user-desc.ts           # gitter user-desc [query] (new)
|   |-- ... (existing files)
```

No new modules are needed. The feature adds one new command handler file and modifies five existing files.

---

### 12.10 Relationship to Existing Features

| Feature | Field | Purpose | Author |
|---------|-------|---------|--------|
| `user-desc` | `userDescription` | Concise recognition text, searchable | User |
| `notes` | `notes` | Private working notes, not searchable | User |
| `describe` | `description` | Structured business + technical analysis | AI |

The three text fields serve distinct purposes:
- **User Description**: A brief, user-written summary for quick identification and search. Displayed prominently in info and UI.
- **Notes**: Extended working notes for the user's own reference. Not included in search results.
- **Description**: AI-generated structured analysis with provenance metadata. Populated by the `describe` command.

---

### 12.11 Implementation Units

| Unit | Files | Dependencies | Effort |
|------|-------|-------------|--------|
| A: Data Model + CLI | `types.ts`, `user-desc.ts` (new), `cli.ts`, `scan.ts`, `info.ts`, `registry.ts` | None (foundation) | ~150 lines new + ~30 lines modified |
| B: Web UI | `html.ts`, `server.ts` | Unit A | ~80 lines modified |
| C: Tests | `test_scripts/test-user-desc.ts` (new) | Units A, B | ~120 lines new |
