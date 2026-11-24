# Local installation and maintenance

ASMR Studio's supported distribution is a source checkout with pinned dependencies
and a built web interface. `npm start` runs both the interface and API in one local
Node process. Vite remains a build and development tool; it is not needed as a
running development server for ordinary listening.

## Install and start

Install the prerequisites listed in the [README](../README.md#run-locally), then:

```sh
git clone https://github.com/zevarix/asmr-studio.git
cd asmr-studio
npm ci
npm run build
npm start
```

Open the URL printed by the process, normally `http://127.0.0.1:4318`.
Keep the terminal open while listening; Ctrl+C stops that process. Choose a data
directory outside the checkout with `ASMR_DATA_DIR` when you need a custom
location. `PORT` changes the single local port.

Leave `ASMR_ALLOWED_ORIGIN` unset for this single-process launch; it follows
`PORT` automatically. If you previously set it for a separate Vite development
server, clear it or set it to the exact printed studio URL. `.env.example` is
a reference and is not loaded automatically.

The server loads only the built interface and its public assets. A missing build
produces an instruction to run `npm run build`. The listener remains on loopback
and retains exact Host/Origin checks. It does not provide network sharing,
phone access, an authentication service, or a background system service.

The current source package supports this local workflow. A signed native
installer, automatic updates, operating-system service installation, and public
hosting remain separate distribution decisions. They are not prerequisites for
using the studio or recovering its library.

## API-only development

`npm start --workspace=@asmr-studio/server` retains the API-only process, which
defaults to port 4317 and does not serve the built interface. To use the existing
Vite development server, run the API on port 4319 with
`ASMR_ALLOWED_ORIGIN=http://127.0.0.1:4318`, then run `npm run dev:local` in another
terminal. See [development notes](development.md#local-service-configuration).

## Update an existing installation

1. Save browser edits and create a [verified backup](backup-and-restore.md).
2. Preserve local source changes. Use a separate clean checkout if you have edited
   the application; never reset or overwrite an unfamiliar working tree.
3. In a clean checkout, update the source with `git pull --ff-only`, then run
   `npm ci` and `npm run build`. A fast-forward refusal requires resolving the
   source history deliberately.
4. Stop the old studio normally, then run `npm start` from the updated checkout
   with the same `ASMR_DATA_DIR`.
5. Run `npm run sounds:install` with that same data directory when you want newly
   added starter sounds. Existing recordings and saved sessions are retained.

Keep the source revision and its matching dependencies together. The running
process holds its built interface in memory, so building a new version in another
checkout does not mix new interface files into an older server process.

## Recovery and rollback

A failed build does not require changing your data directory. Keep using the
previous working checkout until the build is fixed. Backups restore into a new
data directory; selecting it at startup leaves the original library available.

Do not assume older application code can open a database after a future schema
upgrade. Restore a backup using its matching application version when rolling
back across an incompatible migration. Current backup verification explicitly
rejects unsupported schema and format versions.

## Distribution boundaries

Application source and built code use the MIT license with their third-party
notices. Audio and any future model or voice inputs retain their own terms.
Starter sounds are fetched separately with declared provenance and integrity
checks; personal recordings, databases, scripts, browser preferences, and
assistant credentials are never example package content.

Desktop listening acceptance is complete. This distribution work does not assert
physical iPhone background, screen-lock, interruption, or audio-route behavior.
Those cases remain tracked in [issue #5](https://github.com/zevarix/asmr-studio/issues/5).
