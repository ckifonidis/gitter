/**
 * test-describe-cli.ts
 * Integration tests for the `gitter describe` CLI command.
 * Tests help output, --show flag, and error handling.
 * Does NOT test actual AI generation (requires API key).
 *
 * Run: npx tsx test_scripts/test-describe-cli.ts
 */

import { execSync, ExecSyncOptionsWithStringEncoding } from 'child_process';
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const PROJECT_ROOT = '/Users/giorgosmarinos/aiwork/coding-platform/gitter';
const CLI = `npx tsx ${PROJECT_ROOT}/src/cli.ts`;

// We use a temp HOME so we never touch the real registry
const tempHome = mkdtempSync(join(tmpdir(), 'gitter-describe-test-'));
const testEnv: Record<string, string> = {
  ...Object.fromEntries(
    Object.entries(process.env).filter(([, v]) => v !== undefined) as [string, string][]
  ),
  HOME: tempHome,
};

// ---------------------------------------------------------------------------
// Find a real git repo and pre-register it
// ---------------------------------------------------------------------------
function findGitRepo(): string {
  const candidates = [
    '/Users/giorgosmarinos/aiwork/IDP/AzWrap',
    '/Users/giorgosmarinos/aiwork/IDP/teams-tool',
    '/Users/giorgosmarinos/aiwork/ibank/ibankRedesignShellNetCore6',
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
const REPO_NAME = GIT_REPO_PATH.split('/').pop()!;

// Pre-register the repo by running gitter scan
function preRegisterRepo(): void {
  try {
    execSync(`${CLI} scan`, {
      encoding: 'utf-8',
      cwd: GIT_REPO_PATH,
      env: testEnv as NodeJS.ProcessEnv,
      timeout: 15_000,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch {
    throw new Error(`Failed to pre-register repo at ${GIT_REPO_PATH}`);
  }
}

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

function run(command: string, options: { cwd?: string; env?: Record<string, string> } = {}): RunResult {
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
console.log('\n=== Describe CLI Integration Tests ===\n');
console.log(`Test HOME: ${tempHome}`);
console.log(`Test repo: ${GIT_REPO_PATH} (${REPO_NAME})\n`);

// Pre-register the repo so --show tests work
preRegisterRepo();
console.log(`Pre-registered ${REPO_NAME}\n`);

// --- Test: gitter describe --help shows options ---
test('gitter describe --help shows describe options', () => {
  const result = run(`${CLI} describe --help`);
  assertEqual(result.exitCode, 0, 'exit code');
  const output = result.stdout;
  assertTrue(output.includes('--show'), 'help shows --show option');
  assertTrue(output.includes('--instructions'), 'help shows --instructions option');
  assertTrue(output.includes('--business-lines'), 'help shows --business-lines option');
  assertTrue(output.includes('--technical-lines'), 'help shows --technical-lines option');
});

// --- Test: gitter describe --show <registered-repo> shows "No description available" ---
test('gitter describe --show <registered-repo> shows "No description available"', () => {
  const result = run(`${CLI} describe --show ${REPO_NAME}`);
  assertEqual(result.exitCode, 0, 'exit code');
  assertTrue(
    result.stdout.includes('No description available'),
    'output indicates no description stored'
  );
});

// --- Test: gitter describe --show nonexistent exits with code 1 ---
test('gitter describe --show nonexistent exits with code 1', () => {
  const result = run(`${CLI} describe --show zzz_nonexistent_zzz_99999`);
  assertTrue(result.exitCode !== 0, 'exit code non-zero');
  const combined = result.stdout + result.stderr;
  assertTrue(
    combined.includes('No repositor') || combined.includes('no match') || combined.includes('No repositories'),
    'output indicates no match'
  );
});

// --- Test: gitter describe outside git repo with no query shows error ---
test('gitter describe outside git repo with no query shows error', () => {
  const result = run(`${CLI} describe`, { cwd: '/tmp' });
  assertTrue(result.exitCode !== 0, 'exit code non-zero');
  const combined = result.stdout + result.stderr;
  assertTrue(
    combined.includes('Not inside a git repository') || combined.includes('not inside'),
    'output mentions not inside a git repo'
  );
});

// --- Test: gitter describe --show without query inside non-registered repo shows error ---
test('gitter describe --show inside unregistered repo directory shows error', () => {
  // Create a temp git repo that is NOT registered
  const tmpRepo = mkdtempSync(join(tmpdir(), 'gitter-fake-repo-'));
  try {
    execSync('git init', { cwd: tmpRepo, stdio: 'pipe' });
    const result = run(`${CLI} describe --show`, { cwd: tmpRepo });
    assertTrue(result.exitCode !== 0, 'exit code non-zero');
    const combined = result.stdout + result.stderr;
    assertTrue(
      combined.includes('not registered') || combined.includes('scan'),
      'output mentions repo is not registered or suggests scanning'
    );
  } finally {
    rmSync(tmpRepo, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------
try {
  rmSync(tempHome, { recursive: true, force: true });
} catch {
  console.log(`Warning: could not clean up temp directory: ${tempHome}`);
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------
console.log(`\n--- Describe CLI Tests Summary ---`);
console.log(`  Total: ${passed + failed}  Passed: ${passed}  Failed: ${failed}`);
if (failed > 0) {
  console.log('\nFailed tests:');
  for (const r of results) {
    if (!r.ok) console.log(`  - ${r.name}: ${r.error}`);
  }
}
console.log('');

process.exit(failed > 0 ? 1 : 0);
