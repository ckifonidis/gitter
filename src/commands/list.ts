import { existsSync } from 'fs';
import Table from 'cli-table3';
import pc from 'picocolors';
import { loadRegistry } from '../registry.js';
import { parseRemoteUrl } from '../git.js';

/**
 * Handler for `gitter list` command.
 * Displays all registered repositories in a formatted table.
 */
export async function listCommand(): Promise<void> {
  const registry = loadRegistry();

  if (registry.repositories.length === 0) {
    console.log('No repositories registered.');
    return;
  }

  const table = new Table({
    head: [pc.bold('Repo Name'), pc.bold('Host'), pc.bold('Owner'), pc.bold('Local Path'), pc.bold('Last Updated')],
  });

  for (const entry of registry.repositories) {
    const missing = !existsSync(entry.localPath);
    const repoName = missing ? pc.red(`[MISSING] ${entry.repoName}`) : entry.repoName;
    const originRemote = entry.remotes.find(r => r.name === 'origin') ?? entry.remotes[0];
    const parsed = originRemote ? parseRemoteUrl(originRemote.fetchUrl) : null;
    const lastUpdated = new Date(entry.lastUpdated).toLocaleString();

    table.push([repoName, parsed?.host ?? '', parsed?.owner ?? '', entry.localPath, lastUpdated]);
  }

  console.log(table.toString());
}
