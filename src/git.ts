import { execFileSync } from 'child_process';
import { basename } from 'path';
import type { Remote, RegistryEntry } from './types.js';

/**
 * Execute a git command and return trimmed stdout.
 */
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
      throw new Error(`Git command timed out: git ${args.join(' ')}`);
    }
    throw new Error(
      `Git command failed: git ${args.join(' ')}\n${err.stderr ?? 'Unknown error'}`
    );
  }
}

/**
 * Check if the given directory is inside a git work tree.
 */
export function isInsideGitRepo(cwd?: string): boolean {
  try {
    const result = git(['rev-parse', '--is-inside-work-tree'], cwd);
    return result === 'true';
  } catch {
    return false;
  }
}

/**
 * Get the absolute path to the repository root.
 */
export function getRepoRoot(cwd?: string): string {
  return git(['rev-parse', '--show-toplevel'], cwd);
}

/**
 * Parse `git remote -v` output into an array of Remote objects.
 */
export function getRemotes(cwd?: string): Remote[] {
  let output: string;
  try {
    output = git(['remote', '-v'], cwd);
  } catch {
    return [];
  }

  if (!output) return [];

  const remoteMap = new Map<string, { name: string; fetchUrl: string; pushUrl: string }>();
  const lines = output.split('\n').filter(line => line.trim() !== '');

  for (const line of lines) {
    const parts = line.split(/\s+/);
    if (parts.length < 3) continue;

    const [name, url, type] = parts;

    if (!remoteMap.has(name)) {
      remoteMap.set(name, { name, fetchUrl: '', pushUrl: '' });
    }

    const entry = remoteMap.get(name)!;
    if (type === '(fetch)') {
      entry.fetchUrl = url;
    } else if (type === '(push)') {
      entry.pushUrl = url;
    }
  }

  return Array.from(remoteMap.values());
}

/**
 * Get all local branch names.
 */
export function getLocalBranches(cwd?: string): string[] {
  let output: string;
  try {
    output = git(['branch', '--list'], cwd);
  } catch {
    return [];
  }

  if (!output) return [];

  return output
    .split('\n')
    .map(line => line.replace(/^\*?\s+/, '').trim())
    .filter(name => name !== '');
}

/**
 * Get all remote-tracking branch names.
 */
export function getRemoteBranches(cwd?: string): string[] {
  let output: string;
  try {
    output = git(['branch', '-r'], cwd);
  } catch {
    return [];
  }

  if (!output) return [];

  return output
    .split('\n')
    .map(line => line.trim())
    .filter(line => line !== '' && !line.includes(' -> '));
}

/**
 * Get the currently checked-out branch name.
 * Returns "HEAD" if in detached HEAD state.
 */
export function getCurrentBranch(cwd?: string): string {
  return git(['rev-parse', '--abbrev-ref', 'HEAD'], cwd);
}

/**
 * Parse a git remote URL to extract the host and owner.
 * Works backwards from the repo name: the segment immediately before the repo
 * (skipping connectors like _git) is the owner.
 * Supports HTTPS and SSH formats.
 */
export function parseRemoteUrl(url: string): { host: string; owner: string } | null {
  let host: string;
  let pathStr: string;

  // HTTPS: https://[user@]host/path/to/repo.git
  const httpsMatch = url.match(/^https?:\/\/(?:[^@]+@)?([^/]+)\/(.+?)(?:\.git)?$/);
  if (httpsMatch) {
    host = httpsMatch[1];
    pathStr = httpsMatch[2];
  } else {
    // SSH: git@host:path/to/repo.git
    const sshMatch = url.match(/^[^@]+@([^:]+):(.+?)(?:\.git)?$/);
    if (sshMatch) {
      host = sshMatch[1];
      pathStr = sshMatch[2];
    } else {
      return null;
    }
  }

  const segments = pathStr.split('/').filter(s => s !== '_git');
  if (segments.length < 2) return null;

  // Owner is the segment right before the repo name
  const owner = segments[segments.length - 2];
  return { host, owner };
}

/**
 * Collect all repository metadata into a RegistryEntry.
 */
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
