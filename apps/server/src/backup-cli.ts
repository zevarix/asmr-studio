import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { BackupError, createBackup, restoreBackup, verifyBackup, type BackupManifest } from './backup.js';
import { studioDataRoot } from './runtime.js';

const usage = `ASMR Studio library backup

  npm run backup -- create <new-backup-folder>
  npm run backup -- verify <backup-folder>
  npm run backup -- restore <backup-folder> <new-data-folder>

Create reads ASMR_DATA_DIR, or the normal local studio data folder.
Save your session first: unsaved browser edits are not in the database.
The destination's parent folder must already exist. Existing destinations
are never replaced. Restore to a new folder, then start the studio with
ASMR_DATA_DIR set to that folder.

Backups contain private recordings and saved mixes. Keep the entire folder
together and store it privately. See docs/backup-and-restore.md.
`;

function describe(manifest: BackupManifest): string {
  const { assets, scenes, capturedMixes, totalBytes } = manifest.summary;
  return `${assets} recordings, ${scenes} saved sessions, ${capturedMixes} captured mixes; ${totalBytes} verified bytes.`;
}

export async function runBackupCommand(args: string[], output: (message: string) => void = console.log): Promise<void> {
  if (args.length === 1 && (args[0] === '--help' || args[0] === '-h')) {
    output(usage);
    return;
  }
  const [command, first, second] = args;
  if (command === 'create' && args.length === 2 && first && !first.startsWith('-')) {
    const destination = resolve(first);
    const manifest = await createBackup({ sourceRoot: studioDataRoot(), destination });
    output(`Backup created: ${destination}\n${describe(manifest)}`);
    return;
  }
  if (command === 'verify' && args.length === 2 && first && !first.startsWith('-')) {
    const directory = resolve(first);
    const manifest = await verifyBackup(directory);
    output(`Backup verified: ${directory}\n${describe(manifest)}`);
    return;
  }
  if (command === 'restore' && args.length === 3 && first && second && !first.startsWith('-') && !second.startsWith('-')) {
    const destination = resolve(second);
    const manifest = await restoreBackup({ backupRoot: resolve(first), destination });
    output(`Library restored: ${destination}\n${describe(manifest)}\nStart the studio with ASMR_DATA_DIR set to this folder.`);
    return;
  }
  throw new BackupError('BACKUP_INVALID', `Choose create, verify, or restore with the required folder paths.\n\n${usage}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    await runBackupCommand(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'The backup operation failed.');
    process.exitCode = 1;
  }
}
