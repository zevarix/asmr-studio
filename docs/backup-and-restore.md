# Back up and restore your library

A backup preserves your imported recordings, saved sessions, captured mixes used
by transitions, source permissions, and retained starter-source files. It is a
private folder with an integrity manifest. Keep that folder together when copying
it to another disk or computer.

Build the application first with `npm ci` and `npm run build`. Run these commands
from the source checkout using the pinned Node version.

## Create a backup

Press **Save session** for edits you want to keep. The backup reads saved data;
an unsaved browser draft has not reached the database.

Choose a new folder in an existing private backup location:

```sh
npm run backup -- create /path/to/backups/my-studio-backup
```

The source is `ASMR_DATA_DIR`, or the application's normal data folder when that
variable is unset. For a custom source on macOS or Linux:

```sh
ASMR_DATA_DIR=/path/to/studio-data npm run backup -- create /path/to/backups/my-studio-backup
```

In PowerShell:

```powershell
$env:ASMR_DATA_DIR = 'C:\private\studio-data'
npm run backup -- create 'D:\private-backups\my-studio-backup'
```

The studio can remain open. SQLite supplies a consistent snapshot, and the backup
copies the immutable audio files referenced by that snapshot. Saves completed
after the snapshot belong to a later backup. Let starter installation finish
before backing up if you want all its source caches and credits included.

Every copied file has its size and SHA-256 checked. A completion manifest is
published after the staged data verifies. The command refuses an existing
destination, including an empty folder, and does not modify your source library.
An interrupted operation may leave an incomplete destination; verification must
succeed before treating a folder as a usable backup. Choose a new destination for
a retry rather than overwriting an earlier result.

## Verify a copied backup

```sh
npm run backup -- verify /path/to/backups/my-studio-backup
```

Verification checks every listed file, the supported database schema, and the
saved asset and scene relationships. Missing or changed audio, invalid paths,
symbolic links, unsupported versions, and incomplete folders are rejected.
The hashes detect corruption; they do not authenticate the person who supplied a
backup. Restore only a backup you trust.

## Restore into a new data folder

```sh
npm run backup -- restore /path/to/backups/my-studio-backup /path/to/restored-studio
```

The destination must not exist, and its parent folder must already exist.
Restore verifies the backup and its staged copy before publishing the new
library. It keeps asset IDs, saved revisions, capture identities, and original
audio bytes. It does not merge libraries or replace the currently running one.

To use it, save any current browser edits and stop the existing studio normally.
Then start with the restored directory on macOS or Linux:

```sh
ASMR_DATA_DIR=/path/to/restored-studio npm start
```

In PowerShell:

```powershell
$env:ASMR_DATA_DIR = 'C:\private\restored-studio'
npm start
```

Open the printed local URL. Keep the original data folder until you are satisfied
with the restored library. Returning to it only requires starting the app with
its original `ASMR_DATA_DIR`; restore never changes that folder.

## Included and excluded data

| Included | Not included |
| --- | --- |
| Consistent SQLite database, saved sessions and captured transition mixes | Unsaved browser drafts |
| Every registered original audio blob and its metadata | Rendered WAV downloads and export-job history |
| Retained starter originals and attribution records | Temporary uploads and unregistered orphan files |
| Asset provenance and usage declarations | Browser appearance preferences and assistant connections |

Rendered exports can be created again from saved sessions; separately keep any
finished WAVs and recipes you want to archive. The backup is not an application
installer and does not include Node, FFmpeg, source code, or dependencies.

Version 1 of the backup format supports database schema version 2. A newer format
or schema is rejected rather than silently downgraded. Use the same application
revision for an initial restore, then update normally.

Backups may contain personal recordings and private text. They are not public
sound packs, and the application's MIT license does not change the recordings'
permissions. Backup folders are not encrypted by the app; choose private storage
and your preferred disk or backup encryption.
