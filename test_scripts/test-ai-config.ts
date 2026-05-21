/**
 * test-ai-config.ts
 * Unit tests for the AI configuration loading (src/ai-config.ts).
 * Each test runs as a subprocess (temp .ts file) for fresh module cache.
 *
 * Run: npx tsx test_scripts/test-ai-config.ts
 */

import { execSync } from 'child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const PROJECT_ROOT = '/Users/giorgosmarinos/aiwork/coding-platform/gitter';

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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create a temp HOME with ~/.gitter/ dir */
function makeTempHome(): string {
  const dir = mkdtempSync(join(tmpdir(), 'gitter-ai-cfg-'));
  mkdirSync(join(dir, '.gitter'), { recursive: true });
  return dir;
}

/** Write a config.json file into the temp HOME's .gitter dir */
function writeConfig(home: string, config: Record<string, unknown>): void {
  writeFileSync(join(home, '.gitter', 'config.json'), JSON.stringify(config, null, 2));
}

/** Write a .env file into the temp HOME's .gitter dir */
function writeDotEnv(home: string, content: string): void {
  writeFileSync(join(home, '.gitter', '.env'), content);
}

interface SubprocessResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/** Strip dotenv debug/info lines from stdout (they pollute JSON output) */
function cleanStdout(raw: string): string {
  return raw
    .split('\n')
    .filter(line => !line.startsWith('[dotenv@'))
    .join('\n');
}

/**
 * Run a TypeScript snippet as a subprocess by writing it to a temp file
 * and executing with npx tsx. This ensures fresh module cache per test.
 */
function runConfigTest(
  home: string,
  script: string,
  extraEnv: Record<string, string> = {}
): SubprocessResult {
  // Write the script to a temp file inside the project so relative imports work
  const tmpScript = join(PROJECT_ROOT, `_test_tmp_${Date.now()}_${Math.random().toString(36).slice(2)}.ts`);
  writeFileSync(tmpScript, script);

  // Build a clean env: copy current env, remove all AI-related vars, then apply overrides
  const AI_VARS = [
    'GITTER_AI_PROVIDER', 'GITTER_AI_MODEL', 'GITTER_AI_MAX_TOKENS',
    'ANTHROPIC_API_KEY', 'ANTHROPIC_FOUNDRY_API_KEY', 'ANTHROPIC_FOUNDRY_RESOURCE',
    'ANTHROPIC_VERTEX_PROJECT_ID', 'CLOUD_ML_REGION',
  ];
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined && !AI_VARS.includes(k)) {
      env[k] = v;
    }
  }
  env.HOME = home;
  // Apply any extra env vars (test-specific overrides)
  for (const [k, v] of Object.entries(extraEnv)) {
    env[k] = v;
  }

  try {
    const stdout = execSync(`npx tsx ${tmpScript}`, {
      encoding: 'utf-8',
      cwd: PROJECT_ROOT,
      env: env as NodeJS.ProcessEnv,
      timeout: 15_000,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return { stdout: cleanStdout(stdout.toString()), stderr: '', exitCode: 0 };
  } catch (err: unknown) {
    const e = err as { stdout?: Buffer | string; stderr?: Buffer | string; status?: number };
    return {
      stdout: cleanStdout((e.stdout ?? '').toString()),
      stderr: (e.stderr ?? '').toString(),
      exitCode: e.status ?? 1,
    };
  } finally {
    try { rmSync(tmpScript); } catch { /* ignore */ }
  }
}

const LOAD_SCRIPT = `
import { loadAIConfig } from './src/ai-config.js';
try {
  const cfg = loadAIConfig();
  console.log(JSON.stringify(cfg));
} catch (err: unknown) {
  console.log('ERROR:' + (err instanceof Error ? err.message : String(err)));
  process.exit(1);
}
`;

// ---------------------------------------------------------------------------
// Temp directories to clean up
// ---------------------------------------------------------------------------
const tempDirs: string[] = [];
function createHome(): string {
  const h = makeTempHome();
  tempDirs.push(h);
  return h;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
console.log('\n=== AI Config Tests ===\n');

// --- Test: config loaded from config.json file works ---
test('config loaded from config.json file works', () => {
  const home = createHome();
  writeConfig(home, {
    ai: {
      provider: 'anthropic',
      model: 'claude-sonnet-4-20250514',
      anthropic: { apiKey: 'test-key-from-config' },
    },
  });
  const result = runConfigTest(home, LOAD_SCRIPT);
  assertEqual(result.exitCode, 0, 'exit code');
  const cfg = JSON.parse(result.stdout.trim());
  assertEqual(cfg.provider, 'anthropic', 'provider');
  assertEqual(cfg.model, 'claude-sonnet-4-20250514', 'model');
  assertEqual(cfg.anthropic.apiKey, 'test-key-from-config', 'apiKey');
});

// --- Test: config loaded from .env file works ---
test('config loaded from .env file works', () => {
  const home = createHome();
  writeDotEnv(home, [
    'GITTER_AI_PROVIDER=anthropic',
    'GITTER_AI_MODEL=claude-sonnet-4-20250514',
    'ANTHROPIC_API_KEY=test-key-from-dotenv',
  ].join('\n'));
  const result = runConfigTest(home, LOAD_SCRIPT);
  assertEqual(result.exitCode, 0, 'exit code');
  const cfg = JSON.parse(result.stdout.trim());
  assertEqual(cfg.provider, 'anthropic', 'provider');
  assertEqual(cfg.anthropic.apiKey, 'test-key-from-dotenv', 'apiKey');
});

// --- Test: env vars override config file values ---
test('env vars override config file values', () => {
  const home = createHome();
  writeConfig(home, {
    ai: {
      provider: 'anthropic',
      model: 'model-from-config',
      anthropic: { apiKey: 'key-from-config' },
    },
  });
  const result = runConfigTest(home, LOAD_SCRIPT, {
    GITTER_AI_MODEL: 'model-from-env',
    ANTHROPIC_API_KEY: 'key-from-env',
  });
  assertEqual(result.exitCode, 0, 'exit code');
  const cfg = JSON.parse(result.stdout.trim());
  assertEqual(cfg.model, 'model-from-env', 'model overridden by env');
  assertEqual(cfg.anthropic.apiKey, 'key-from-env', 'apiKey overridden by env');
});

// --- Test: missing provider throws clear error ---
test('missing provider throws clear error', () => {
  const home = createHome();
  writeConfig(home, {
    ai: {
      model: 'some-model',
      anthropic: { apiKey: 'key' },
    },
  });
  const result = runConfigTest(home, LOAD_SCRIPT);
  assertTrue(result.exitCode !== 0, 'should exit non-zero');
  assertTrue(result.stdout.includes('AI provider'), 'error mentions AI provider');
  assertTrue(result.stdout.includes('GITTER_AI_PROVIDER'), 'error mentions env var');
});

// --- Test: missing model throws clear error ---
test('missing model throws clear error', () => {
  const home = createHome();
  writeConfig(home, {
    ai: {
      provider: 'anthropic',
      anthropic: { apiKey: 'key' },
    },
  });
  const result = runConfigTest(home, LOAD_SCRIPT);
  assertTrue(result.exitCode !== 0, 'should exit non-zero');
  assertTrue(result.stdout.includes('AI model'), 'error mentions AI model');
  assertTrue(result.stdout.includes('GITTER_AI_MODEL'), 'error mentions env var');
});

// --- Test: invalid provider value throws error ---
test('invalid provider value throws error', () => {
  const home = createHome();
  writeConfig(home, {
    ai: {
      provider: 'openai',
      model: 'gpt-4',
    },
  });
  const result = runConfigTest(home, LOAD_SCRIPT);
  assertTrue(result.exitCode !== 0, 'should exit non-zero');
  assertTrue(result.stdout.includes('Unknown AI provider'), 'error mentions unknown provider');
  assertTrue(result.stdout.includes('openai'), 'error mentions the invalid value');
});

// --- Test: anthropic provider missing apiKey throws ---
test('anthropic provider missing apiKey throws', () => {
  const home = createHome();
  writeConfig(home, {
    ai: {
      provider: 'anthropic',
      model: 'claude-sonnet-4-20250514',
    },
  });
  const result = runConfigTest(home, LOAD_SCRIPT);
  assertTrue(result.exitCode !== 0, 'should exit non-zero');
  assertTrue(result.stdout.includes('Anthropic API key'), 'error mentions Anthropic API key');
  assertTrue(result.stdout.includes('ANTHROPIC_API_KEY'), 'error mentions env var');
});

// --- Test: azure provider missing resource throws ---
test('azure provider missing resource throws', () => {
  const home = createHome();
  writeConfig(home, {
    ai: {
      provider: 'azure',
      model: 'claude-sonnet-4-20250514',
      azure: { apiKey: 'az-key' },
    },
  });
  const result = runConfigTest(home, LOAD_SCRIPT);
  assertTrue(result.exitCode !== 0, 'should exit non-zero');
  assertTrue(result.stdout.includes('Azure Foundry resource'), 'error mentions resource');
  assertTrue(result.stdout.includes('ANTHROPIC_FOUNDRY_RESOURCE'), 'error mentions env var');
});

// --- Test: vertex provider missing projectId throws ---
test('vertex provider missing projectId throws', () => {
  const home = createHome();
  writeConfig(home, {
    ai: {
      provider: 'vertex',
      model: 'claude-sonnet-4-20250514',
    },
  });
  const result = runConfigTest(home, LOAD_SCRIPT);
  assertTrue(result.exitCode !== 0, 'should exit non-zero');
  assertTrue(result.stdout.includes('GCP project ID'), 'error mentions GCP project ID');
  assertTrue(result.stdout.includes('ANTHROPIC_VERTEX_PROJECT_ID'), 'error mentions env var');
});

// --- Test: maxTokens defaults to 4096 when not set ---
test('maxTokens defaults to 4096 when not set', () => {
  const home = createHome();
  writeConfig(home, {
    ai: {
      provider: 'anthropic',
      model: 'claude-sonnet-4-20250514',
      anthropic: { apiKey: 'test-key' },
    },
  });
  const result = runConfigTest(home, LOAD_SCRIPT);
  assertEqual(result.exitCode, 0, 'exit code');
  const cfg = JSON.parse(result.stdout.trim());
  assertEqual(cfg.maxTokens, 4096, 'maxTokens default');
});

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------
for (const dir of tempDirs) {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    console.log(`Warning: could not clean up temp directory: ${dir}`);
  }
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------
console.log(`\n--- AI Config Tests Summary ---`);
console.log(`  Total: ${passed + failed}  Passed: ${passed}  Failed: ${failed}`);
if (failed > 0) {
  console.log('\nFailed tests:');
  for (const r of results) {
    if (!r.ok) console.log(`  - ${r.name}: ${r.error}`);
  }
}
console.log('');

process.exit(failed > 0 ? 1 : 0);
