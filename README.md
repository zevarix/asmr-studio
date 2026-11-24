# ASMR Studio

A local web app for mixing ambience, tactile sounds, and recorded narration.
Each layer has its own volume, stereo position, mute, and solo controls.

**Early alpha:** run the studio locally from source. A packaged installer,
remote access, and multi-user authentication are not available. Phone background
and screen-off playback still need device validation.

## What works

Start with nineteen sounds: sixteen openly licensed recordings and three
prepared Earshot ambiences. You can also import your own audio. Search the sound
library, preview a sound, and toggle sounds into a layered mix.
Each layer supports volume, stereo position, mute, solo, and adjustable looping.
Adding and removing sounds while listening preserves the other layers and the
playback clock. Name, save, copy, and reopen sessions from the app.

Open **Appearance** beside the studio heading to choose Sage, Ocean, Amethyst,
Ember, Rose, or Graphite, then select **Light**, **Dark**, or **System**. Each color
coordinates the panels, knobs, and faders in either mode. System follows your
device's appearance; both choices are remembered in this browser.
See [studio appearance](docs/interface.md#appearance).

Shape the whole mix with the Bass, Mid, and Treble knobs in **Master equalizer**,
or open **Equalizer** on a single layer. Tone settings stay with the saved session
and carry through to exported WAVs. See [using the equalizer](docs/equalizer.md).

Watch the final left/right meters in **Output**, reset held peaks, and optionally
enable the stereo-linked **Peak limiter**. Its ceiling is saved with the session
and applied to WAV exports. See [output levels](docs/output-levels.md).

Open **Movement** on a layer to add a gentle side-to-side sway. Choose its width
and cycle time around the saved stereo position; the settings also carry through
to WAV exports. See [stereo movement](docs/stereo-movement.md).

Use **Listening timer** to end a session after a chosen listening duration, with
optional gradual fade-in and fade-out. Pause holds the timer, and saved fades
also apply to a WAV's chosen length. See [listening timer](docs/listening-timer.md).

Open **Loop details** to choose a repeated section on its waveform, adjust exact
times, and **Preview join** before applying it. See [editing a loop](docs/loop-editor.md).

Choose **Occasionally** as a layer's playback mode to leave pauses between whole
recordings, shuffle selected alternatives, and add gentle level or position
variation. The saved sequence repeats in playback and WAV exports. See
[occasional sounds](docs/occasional-sounds.md).

Choose **New transition** to capture two saved mixes and blend between them with
an A/B crossfader or a timed move to B. Save the arrangement independently and
export its captured mixes together. See [mix transitions](docs/mix-transitions.md).

Recorded narration stays on its own adjustable track. Saved-session revisions
prevent one editor from silently overwriting another editor's changes.

Export a saved mix as a finite stereo WAV, with progress, cancellation, and
downloadable recipe and sound credits. Exports retain the selected saved revision
while you continue listening and editing. See [finished mixes](docs/exports.md).

Optionally connect a local assistant to one explicitly enabled browser tab.
The MCP controls share the mixer's validated edits, report draft, saved, and
playback state separately, and preserve newer local changes. See
[assistant controls and setup](docs/assistant-controls.md) and the portable
[composition skill](skills/asmr-composition/SKILL.md).

Whisper generation is not implemented; it remains deferred. Import recorded
narration through the web interface.

## Run locally

Prerequisites: Git, Node.js 22.23.3, npm 10.9.9, `ffprobe`, `ffmpeg`, and `unzip` on
your PATH. `ffprobe` validates imports; `ffmpeg` renders exports and prepares
starter playback copies. The installer uses `unzip` to read
one exact keyboard recording.

Clone the repository and install its pinned dependencies:

```sh
git clone https://github.com/zevarix/asmr-studio.git
cd asmr-studio
npm ci
npm run build
```

Start the built studio, choosing a data directory outside the repository.
On macOS or Linux:

```sh
ASMR_DATA_DIR="$HOME/.local/share/asmr-studio" \
PORT=4318 \
npm start
```

On Windows PowerShell:

```powershell
$env:ASMR_DATA_DIR = Join-Path $env:LOCALAPPDATA 'asmr-studio'
$env:PORT = '4318'
npm start
```

Open **http://127.0.0.1:4318** on the same computer. One process serves the built
interface and API on loopback. Keep the terminal open while listening; Ctrl+C
stops the studio. Remote access and multi-user authentication are not implemented.
Configuration options are in [.env.example](.env.example). See
[local installation and maintenance](docs/local-installation.md) for updates and
recovery, or [development notes](docs/development.md) for the Vite development setup.

Choose **Add starter sounds**, select a few sounds, and press **Start listening**.
The starter collection contains rain, fireplace, wind, waves, birds, a stream,
crickets, mic foam brushing, cardboard and glass tapping, book pages, keyboard
typing, windscreen rubbing, makeup brushing, slow fabric petting, and hand rubbing.
It also includes **Window rain**, **Rain on wood**, and **Small brook**, with
prepared loop settings that apply when you add them to a mix. These three sounds
download as ready-to-use WAVs; Python and Earshot are not required.
Downloads are verified and cached locally; installed sounds play offline.
The first installation needs an internet connection. You can also prepare the
same library before starting the server (macOS/Linux syntax):

```sh
ASMR_DATA_DIR="$HOME/.local/share/asmr-studio" npm run sounds:install
```

In PowerShell, set `$env:ASMR_DATA_DIR` as above and run `npm run sounds:install`.

See [sound credits and preparation details](docs/sound-library.md) for every
sound's source and permission. The original downloaded bytes are preserved;
the app uses short playback excerpts or prepared WAVs with editable loop settings.
Run the installer again after updating the app to add new starter sounds.
Existing recordings, saved sessions, and earlier credits are preserved.

Use **Import your audio** for additional recordings. Keep recordings and
databases out of Git.

## Back up your library

Save your session, then create a verified backup in a new folder:

```sh
npm run backup -- create /path/to/backups/my-studio-backup
npm run backup -- verify /path/to/backups/my-studio-backup
```

Set `ASMR_DATA_DIR` to the same directory used by the running studio when it is
customized. The backup includes saved sessions, captured transition mixes,
recordings, and source metadata. Restore always uses a new data folder and
preserves your existing library. See [backup and restore](docs/backup-and-restore.md)
for restore commands, exclusions, and private-storage guidance.

## Tests

```sh
npm test
npm run typecheck
npm run test:browser:install
npm run test:e2e
npm run test:built
npm run test:restart
```

`npm test` builds the app before running unit and integration tests.
Browser tests use Chromium and generated audio fixtures. The restart test
checks that a new server process reopens saved sessions and the original audio
bytes. Automated checks establish technical behavior rather than subjective
sound quality. Desktop listening acceptance is complete for the three Earshot
water sounds; iPhone/Safari background and screen-off playback remain a separate
device-validation task.

## Code

- `apps/web`: React interface and session editing.
- `apps/server`: Fastify API, SQLite persistence, and managed audio storage.
- `apps/mcp`: optional local stdio adapter for a paired browser's assistant controls.
- `packages/audio-engine`: framework-independent Web Audio mixer.
- `packages/contracts`: shared scene validation and editing commands.
- `skills/asmr-composition`: portable instructions for composing with the MCP tools.
- `tests`: browser tests, generated fixtures, and restart checks.

See [development notes](docs/development.md) for configuration, API behavior,
and audio-engine details. The [studio interface guide](docs/interface.md) covers
control styling, responsive layouts, and accessibility.

## License and sound credits

ASMR Studio's original code is licensed under the [MIT License](LICENSE).
Third-party software and audio retain their own permissions; the code license
does not relicense audio. See [third-party notices](THIRD_PARTY_NOTICES.md) and
[the sound credits](docs/sound-library.md).

If you share a rendered mix, download **Recipe & credits** and include the
attribution, license links, and change notices required by its recordings.
The starter rain and ocean recordings use CC BY 4.0. For imported recordings,
check that your permission covers the intended use; being able to export a WAV
does not establish redistribution rights.
