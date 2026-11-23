# Development notes

## Setup and commands

Use the Node version in `.nvmrc` and the npm version in `package.json`.
Dependencies are pinned in `package-lock.json`. Audio import requires an
installed `ffprobe`. Starter sound preparation also requires `ffmpeg` and `unzip`.

```sh
npm ci
npm test
npm run typecheck
npm run test:browser:install
npm run test:e2e
npm run test:restart
```

`npm test` builds all packages in dependency order before running the unit and
integration suites. Tests use generated PCM fixtures and temporary storage.
SQLite tests use a real database, and import tests invoke ffprobe.

Browser installation and tests use the Playwright CLI directly. Browser binaries
use its standard user cache; `PLAYWRIGHT_BROWSERS_PATH` can select a different
cache for both installation and testing. The install command downloads the pinned
Chromium headless shell without installing OS packages. See
[Playwright's browser documentation](https://playwright.dev/docs/browsers).

End-to-end tests start temporary API and Vite processes on loopback ports 4319
and 4318. Existing listeners are not reused. The test stack stops its own
processes and removes its temporary data when it exits.

## Local service configuration

The [README](../README.md#run-locally) starts the API on port 4319 and Vite on
4318. Vite proxies `/api` requests to the API while preserving the browser's
Host header. For API-only development, the server defaults to port 4317.

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT` | `4317` | API port; the listener binds to `127.0.0.1`. |
| `ASMR_DATA_DIR` | `~/.local/share/asmr-studio` | SQLite database and managed media. |
| `ASMR_ALLOWED_ORIGIN` | `http://127.0.0.1:<PORT>` | Exact allowed Host/Origin; use `http://127.0.0.1:4318` with Vite. |
| `ASMR_MAX_UPLOAD_BYTES` | `268435456` | Maximum bytes per upload. |
| `ASMR_DECODED_BUDGET_BYTES` | `536870912` | Server-side estimated decoded-audio budget per import. |
| `ASMR_ACCEPTED_FORMATS` | `wav,flac,mp3,ogg,m4a` | Accepted container formats. |

`.env.example` documents these settings; it is not loaded automatically.
Host/Origin checks protect local requests but are not multi-user authentication.
Do not expose this development server to a network without an authentication and
hosting design. Keep the data directory private and outside the source tree.

## Media and saved sessions

The API provides health, asset import/list/content, and scene list/create/get/update
routes under `/api`. The web client's `apps/web/src/api.ts` defines their request
format, including Unicode-safe import metadata.

`GET /api/library` describes the fixed starter catalog and installed asset IDs.
`POST /api/library/install` accepts only an empty body or object; callers cannot
supply download URLs. The same installer is available through `npm run sounds:install`.
It verifies source bytes, retains originals, prepares the declared excerpts, and
passes them through the ordinary import validation. Concurrent calls on one
server share a request; completed entries survive an interrupted installation.
See [the sound library](sound-library.md) for credits and storage details.

Audio uploads are streamed to temporary files, probed, hashed, and stored by
content digest. Filenames are display text, not storage paths. Import metadata
records the sound role, provenance, private-use permission, and redistribution
rights separately. Only import recordings you have permission to use.

Byte-identical imports can share stored bytes without replacing each other's
metadata. Failed imports remove temporary files. A crash after storing a blob
but before registration can leave an unregistered blob; re-import checks its
bytes before registering it. There is no automatic media-deletion sweep.

Scenes use schema version 1. A new scene has revision 0 and is stored as revision
1. Updates send `{expectedRevision, scene}`. A stale update returns HTTP 409 with
the current revision and leaves the stored scene unchanged. Missing asset
references and loop endpoints past the asset duration are rejected.

Content lookup uses opaque asset IDs with single-byte-range support. Error
responses do not disclose storage paths. Browser decoding support is separate
from ffprobe recognition; a recognized file can still be unsupported by a browser.

Finished WAV exports run through a persistent, sequential job queue in the local
server. Requests snapshot an exact saved revision and its assets. Progress,
cancellation, restart behavior, download routes, and rendering semantics are
documented in [finished mixes](exports.md).

## Optional assistant controls

The local stdio adapter in `apps/mcp` calls the existing loopback API. It accepts
`ASMR_STUDIO_URL` and `ASMR_CONTROL_TOKEN`; launch its built `dist/main.js`
directly with the configured Node executable so stdout carries only the MCP
protocol. The normal `npm run build` includes this workspace. The setup and
seven tools are documented in [assistant controls](assistant-controls.md).

`packages/contracts/src/assistant.ts` defines device observations, command
requests, acknowledgements, and receipts. Scene edits retain the existing
`applyCommand` validation. The browser applies commands through the same draft
and audio operations used by local controls; the delivery broker never saves
a scene or operates an audio graph itself.

`PlaybackDevices` keeps connections and receipts in memory. Registration
creates a device ID, a connection epoch, and distinct browser/control tokens.
The registry stores token hashes. Browser poll, acknowledgement, and revocation
routes require the browser token; MCP observation and submission routes require
the paired control token. The existing exact Host/Origin checks also apply.
The collection read returns only the paired device, not a device directory.

All assistant routes are under `/api/assistant/devices`:

| Route | Operation |
| --- | --- |
| `POST /` | Register a browser observation and return the new connection credentials. |
| `GET /` | Read the single device paired with the control token. |
| `GET /:id?epoch=…` | Read the selected device and observation freshness. |
| `POST /:id/poll` | Publish current browser state and receive at most one command. |
| `POST /:id/ack` | Report an operation's result and resulting browser state. |
| `POST /:id/revoke` | Revoke the browser connection. |
| `POST /:id/commands` | Submit an explicit device/epoch/version/request envelope. |
| `GET /:id/commands/:requestId?epoch=…` | Reconcile the retained receipt. |

Use `X-ASMR-Device-Token` for browser operations and `X-ASMR-Control-Token` for
controller operations. Registration uses the existing same-origin boundary.
Do not log request headers or connection settings.

Request IDs are immutable within a connection. The broker delivers one pending
command once and retains its receipt. A queued command can expire without
delivery; a dispatched command without a timely acknowledgement becomes
`unconfirmed`. Late acknowledgements cannot backdate current observations.
Browser state versions guard both local and assistant edits, including work
that waits for audio decoding. An edit-only undo is accepted only while its
resulting version is still current.

The broker accepts an injected clock and limits for focused tests. Its default
heartbeat, lease, expiry, retention, and capacity are described in the setup
guide. A restart clears connection capabilities and receipts without changing
the ordinary saved-session database. No assistant listener is exposed beyond
the existing loopback application.

## Audio engine

The mixer in `packages/audio-engine` does not depend on React. The caller owns
the AudioContext lifetime and starts it from a user gesture. `setScene` loads
assets and stops the previous playback. `updateScene` reconciles edits within
the loaded scene while keeping unchanged layer sources and the audio clock.
`apply` updates controls, removals, and loop settings immediately, including the
pending desired mix while another recording decodes. Failed additions preserve
the previous playable mix and expose an error. The editor retains unsaved edits
and keeps pause/stop available after a failed live update.

The engine uses the audio clock for source timing and native looping. Crossfaded
loops preserve an initial segment, then repeat a precomputed linear overlap.
The repeat period is the loop interval minus its overlap. Original and derived
buffers, including buffers still held by fading sources, count toward the
engine's configured memory budget. Re-adding the same loop during its outgoing
fade reuses its prepared buffer.

The web app currently uses a fixed 256 MiB decoded-buffer budget; the server's
environment setting does not configure the browser. Long audio may exceed that
budget. No streaming/chunked narration path is implemented yet.

Each layer fades in over 20 ms when it starts or resumes. Pause, stop, and layer
removal fade the outgoing audio over at most 20 ms; the reported transport state
and position change immediately. Each playback has its own envelope; a restart
complements the combined outgoing fades without prolonging them. Loop intro/overlap
handoffs share that envelope and do not retrigger the fade. Finite scenes and
non-looping clips fade out before their existing end; clips shorter than 40 ms
use half their remaining duration for each fade. Replacing a scene, disposing
the mixer, or an interrupted AudioContext clears outstanding audio immediately.

The optional saved `listeningTimer` settings add an audio-clock envelope after
the limiter and before final metering. The production worklet exposes an a-rate
`listeningGain` AudioParam; engine users without an output stage get a native
gain node when timer settings are first present. The shared envelope function
also drives finite exports. A timer deadline gates the entire output, including
filter tails, even when the UI callback is delayed. Fade-only edits retain
sources; duration changes preallocate replacement sources and preserve their
elapsed offsets. See [timer behavior](listening-timer.md) and the
[implementation plan](listening-timer-plan.md).

Fade and loop quality, genuine whispered speech, and phone background/screen-off
playback need real listening and device checks. Signal tests verify gain, stereo
channels, silence, timing, and cleanup, not perceived sound quality or headphone
loudness.
