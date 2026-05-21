/**
 * test-cli.ts
 * Integration tests for the gitter CLI (src/cli.ts).
 * Runs the CLI via child_process.execSync and checks stdout, stderr, exit codes.
 *
 * Run: npx tsx test_scripts/test-cli.ts
 */

import { execSync, ExecSyncOptionsWithStringEncoding } from 'child_process';
import { existsSync, readFileSync, mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const PROJECT_ROOT = '/Users/giorgosmarinos/aiwork/coding-platform/gitter';
const CLI = `npx tsx ${PROJECT_ROOT}/src/cli.ts`;

// We use a temp HOME so we never touch the real registry
const tempHome = mkdtempSync(join(tmpdir(), 'gitter-cli-test-'));
const testEnv = { ...process.env, HOME: tempHome };

// Find a real git repo for testing
function findGitRepo(): string {
  const candidates = [
    '/Users/giorgosmarinos/aiwork/ibank/ibankRedesignShellNetCore6',
    '/Users/giorgosmarinos/aiwork/IDP/AzWrap',
    '/Users/giorgosmarinos/aiwork/IDP/teams-tool',
  ];
  for (const path of candidates) {
    if (existsSync(`${path}/.git`)) return path;
  }
  try {
    const result = execSync(
      'find /Users/giorgosmarinos/aiwork -maxdepth 3 -name .git -type d 2>/dev/null | head -1',
      { encoding: 'utf-8' }
    ).trim();
    if (result) return result.replace(/\/\.git$/, '');
  } catch { /* ignore */ }
  throw new Error('No git repository found for testing');
}

const GIT_REPO_PATH = findGitRepo();

// ---------------------------------------------------------------------------
// Test harness
// ---------------------------------------------------------------------------
let passed = 0;
let failed = 0;
const results: { name: string; ok: boolean; error?: string }[] = [];

function test(name: string, fn: () => void): void {
  try {
    fn();
    passed++;
    results.push({ name, ok: true });
    console.log(`  PASS  ${name}`);
  } catch (err: unknown) {
    failed++;
    const msg = err instanceof Error ? err.message : String(err);
    results.push({ name, ok: false, error: msg });
    console.log(`  FAIL  ${name}`);
    console.log(`        ${msg}`);
  }
}

function assertTrue(value: boolean, label = ''): void {
  if (!value) throw new Error(`${label ? label + ': ' : ''}Expected true, got false`);
}

function assertEqual<T>(actual: T, expected: T, label = ''): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(`${label ? label + ': ' : ''}Expected ${e}, got ${a}`);
}

interface RunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/**
 * Run a CLI command and capture stdout, stderr, and exit code.
 */
function run(command: string, options: { cwd?: string; env?: Record<string, string | undefined> } = {}): RunResult {
  const execOpts: ExecSyncOptionsWithStringEncoding = {
    encoding: 'utf-8',
    cwd: options.cwd ?? PROJECT_ROOT,
    env: { ...testEnv, ...options.env } as NodeJS.ProcessEnv,
    timeout: 30_000,
    stdio: ['pipe', 'pipe', 'pipe'],
  };

  try {
    const stdout = execSync(command, execOpts);
    return { stdout: stdout.toString(), stderr: '', exitCode: 0 };
  } catch (err: unknown) {
    const e = err as { stdout?: Buffer | string; stderr?: Buffer | string; status?: number };
    return {
      stdout: (e.stdout ?? '').toString(),
      stderr: (e.stderr ?? '').toString(),
      exitCode: e.status ?? 1,
    };
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
console.log('\n=== CLI Integration Tests ===\n');
console.log(`Test HOME: ${tempHome}`);
console.log(`Test repo: ${GIT_REPO_PATH}\n`);

// --- Test: --help shows help text ---
test('gitter --help shows help text', () => {
  const result = run(`${CLI} --help`);
  assertEqual(result.exitCode, 0, 'exit code');
  assertTrue(result.stdout.includes('gitter'), 'stdout contains "gitter"');
  assertTrue(result.stdout.includes('scan'), 'stdout contains "scan"');
  assertTrue(result.stdout.includes('list'), 'stdout contains "list"');
  assertTrue(result.stdout.includes('search'), 'stdout contains "search"');
  assertTrue(result.stdout.includes('go'), 'stdout contains "go"');
});

// --- Test: --version shows version ---
test('gitter --version shows version', () => {
  const result = run(`${CLI} --version`);
  assertEqual(result.exitCode, 0, 'exit code');
  assertTrue(result.stdout.trim().length > 0, 'version output not empty');
  // Should contain a version number like "1.0.0"
  assertTrue(/\d+\.\d+\.\d+/.test(result.stdout.trim()), 'contains semver');
});

// --- Test: scan outside git repo exits with code 1 ---
test('gitter scan outside git repo exits with code 1', () => {
  const result = run(`${CLI} scan`, { cwd: '/tmp' });
  assertTrue(result.exitCode !== 0, 'exit code non-zero');
  assertTrue(
    result.stderr.includes('Not inside a git repository') || result.stderr.includes('not inside'),
    'stderr mentions not inside git repo'
  );
});

// --- Test: scan inside a git repo exits 0 and creates registry entry ---
test('gitter scan inside a git repo exits 0 and registers', () => {
  const result = run(`${CLI} scan`, { cwd: GIT_REPO_PATH });
  assertEqual(result.exitCode, 0, 'exit code');
  // stdout should mention the repo was registered or updated
  assertTrue(
    result.stdout.includes('Registered') || result.stdout.includes('Updated'),
    'stdout mentions Registered or Updated'
  );

  // Verify registry file was created and contains the entry
  const registryPath = join(tempHome, '.gitter', 'registry.json');
  assertTrue(existsSync(registryPath), 'registry.json exists');
  const registry = JSON.parse(readFileSync(registryPath, 'utf-8'));
  assertTrue(registry.repositories.length > 0, 'at least one entry');
});

// --- Test: list shows registered repos ---
test('gitter list shows registered repos', () => {
  const result = run(`${CLI} list`);
  assertEqual(result.exitCode, 0, 'exit code');
  // The previously scanned repo should appear
  const repoName = GIT_REPO_PATH.split('/').pop()!;
  assertTrue(
    result.stdout.includes(repoName) || result.stdout.includes(GIT_REPO_PATH),
    'list output contains repo name or path'
  );
});

// --- Test: search finds the registered repo ---
test('gitter search <name> finds the registered repo', () => {
  const repoName = GIT_REPO_PATH.split('/').pop()!;
  const result = run(`${CLI} search ${repoName}`);
  assertEqual(result.exitCode, 0, 'exit code');
  assertTrue(
    result.stdout.includes(repoName),
    'search output contains repo name'
  );
});

// --- Test: search nonexistent shows no match ---
test('gitter search nonexistent shows "no match" message', () => {
  const result = run(`${CLI} search zzz_nonexistent_zzz_12345`);
  assertEqual(result.exitCode, 0, 'exit code');
  assertTrue(
    result.stdout.toLowerCase().includes('no repositor') || result.stdout.toLowerCase().includes('no match'),
    'output indicates no match'
  );
});

// --- Test: go outputs only the path on stdout ---
test('gitter go <name> outputs only the path on stdout', () => {
  const repoName = GIT_REPO_PATH.split('/').pop()!;
  const result = run(`${CLI} go ${repoName}`);
  assertEqual(result.exitCode, 0, 'exit code');

  // stdout should contain just the path (possibly with trailing newline)
  const stdoutTrimmed = result.stdout.trim();
  assertTrue(stdoutTrimmed.length > 0, 'stdout not empty');
  // The path should be an absolute path
  assertTrue(stdoutTrimmed.startsWith('/'), 'output starts with /');
  // The path should exist on disk
  assertTrue(existsSync(stdoutTrimmed), 'output path exists on disk');
  // stdout should contain only the path (single line)
  const lines = stdoutTrimmed.split('\n').filter(l => l.trim().length > 0);
  assertEqual(lines.length, 1, 'stdout is a single line (just the path)');
});

// --- Test: go with no match exits non-zero ---
test('gitter go nonexistent exits non-zero', () => {
  const result = run(`${CLI} go zzz_nonexistent_zzz_12345`);
  assertTrue(result.exitCode !== 0, 'exit code non-zero');
});

// --- Test: info shows detailed info ---
test('gitter info <name> shows detailed info', () => {
  const repoName = GIT_REPO_PATH.split('/').pop()!;
  const result = run(`${CLI} info ${repoName}`);
  assertEqual(result.exitCode, 0, 'exit code');

  const output = result.stdout;
  // Should contain key sections
  assertTrue(output.includes(repoName), 'contains repo name');
  assertTrue(
    output.includes('Path') || output.includes('Local Path') || output.includes(GIT_REPO_PATH),
    'contains path info'
  );
  assertTrue(
    output.includes('Remotes') || output.includes('Remote'),
    'contains remotes section'
  );
  assertTrue(
    output.includes('Branch') || output.includes('branch'),
    'contains branch info'
  );
  assertTrue(
    output.includes('Last Updated') || output.includes('lastUpdated'),
    'contains last updated'
  );
});

// --- Test: info with no match exits non-zero ---
test('gitter info nonexistent exits non-zero', () => {
  const result = run(`${CLI} info zzz_nonexistent_zzz_12345`);
  assertTrue(result.exitCode !== 0, 'exit code non-zero');
});

// --- Test: init outputs shell function ---
test('gitter init outputs shell function', () => {
  const result = run(`${CLI} init`);
  assertEqual(result.exitCode, 0, 'exit code');

  const output = result.stdout;
  // Should contain the shell function definition
  assertTrue(output.includes('gitter()'), 'contains gitter() function definition');
  assertTrue(output.includes('cd'), 'contains cd command');
  assertTrue(output.includes('go'), 'contains go reference');
});

// --- Test: re-scan updates (no duplicate) ---
test('gitter scan twice does not create duplicate entry', () => {
  // Run scan again in the same repo
  run(`${CLI} scan`, { cwd: GIT_REPO_PATH });

  const registryPath = join(tempHome, '.gitter', 'registry.json');
  const registry = JSON.parse(readFileSync(registryPath, 'utf-8'));

  // Count entries with the same path
  const matches = registry.repositories.filter(
    (e: { localPath: string }) => e.localPath === GIT_REPO_PATH
  );
  assertEqual(matches.length, 1, 'exactly one entry for the repo (no duplicate)');
});

// --- Test: default action (no subcommand) inside a git repo runs scan ---
test('gitter (no subcommand) inside a git repo runs scan', () => {
  const result = run(CLI, { cwd: GIT_REPO_PATH });
  assertEqual(result.exitCode, 0, 'exit code');
  assertTrue(
    result.stdout.includes('Registered') || result.stdout.includes('Updated'),
    'stdout mentions Registered or Updated'
  );
});

// --- Cleanup ---
try {
  rmSync(tempHome, { recursive: true, force: true });
} catch {
  console.log(`Warning: could not clean up temp directory: ${tempHome}`);
}

// --- Summary ---
console.log(`\n--- CLI Integration Tests Summary ---`);
console.log(`  Total: ${passed + failed}  Passed: ${passed}  Failed: ${failed}`);
if (failed > 0) {
  console.log('\nFailed tests:');
  for (const r of results) {
    if (!r.ok) console.log(`  - ${r.name}: ${r.error}`);
  }
}
console.log('');

process.exit(failed > 0 ? 1 : 0);
