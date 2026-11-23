# Assistant controls

An optional local MCP server lets an assistant adjust the mix in one selected
browser tab. The browser remains in charge of its draft and audio engine, and
every ordinary mixer control continues to work. The connection is off until
you enable it in that tab.

This integration requires an MCP host that can launch a local **stdio** server.
Run that host on the same computer as ASMR Studio. It does not provide a hosted
MCP endpoint, remote access, or whisper generation.

## Connect a browser

1. Follow the [local setup](../README.md#run-locally), including `npm run build`,
   and open the studio. The build includes the MCP adapter.
2. Open **Assistant controls**, give the playback device a recognizable name,
   and choose **Enable for this browser**. This click also prepares browser
   audio; it does not start the mix.
3. Open **Connection settings**. The displayed environment settings contain
   the studio URL and a key scoped to this browser connection.
4. Add a local stdio server to your MCP host. Use the actual source-checkout
   path and the settings displayed by the tab. For hosts that use an
   `mcpServers` configuration object:

   ```json
   {
     "mcpServers": {
       "asmr-studio": {
         "command": "node",
         "args": ["/path/to/asmr-studio/apps/mcp/dist/main.js"],
         "env": {
           "ASMR_STUDIO_URL": "http://127.0.0.1:4318",
           "ASMR_CONTROL_TOKEN": "PASTE_THE_KEY_FROM_CONNECTION_SETTINGS"
         }
       }
     }
   }
   ```

   The outer configuration format depends on the host. On Windows, use the
   checkout's absolute Windows path, with escaped backslashes or forward
   slashes in JSON. If the host cannot find the required Node version, use the
   absolute path to that Node executable as `command`.

5. Have the assistant call `list_playback_devices`, then read the returned
   device with `get_playback_device` before changing anything.

Launch `apps/mcp/dist/main.js` directly with Node. Do not use an npm script as
the MCP launch command: npm's startup output can interfere with the stdio
protocol. The server uses the pinned SDK; setup does not require a global MCP
package installation.

`ASMR_STUDIO_URL` defaults to `http://127.0.0.1:4318`. It must be a loopback HTTP
origin, without a path, query, or embedded credentials. Use the web origin shown
by the tab rather than the API's separate development port. `ASMR_CONTROL_TOKEN`
is required. Keep it in your MCP host's private configuration, outside source
control and shared examples.

## Choose the playback target explicitly

Each enabled tab has its own `deviceId`, connection `epoch`, and private key.
`list_playback_devices` returns only the device paired with that key. It does
not enumerate or control other tabs.

Every command still names its device and epoch explicitly. Two browser tabs
can display the same saved session while retaining separate drafts and audio
players. Changing one tab does not broadcast a command to the other. Saving
uses the existing saved-session revision checks.

Use **Disconnect assistant** to block new commands. The old key can briefly
read the last observation and retained receipts so an in-flight request can be
reconciled; it cannot start another action. Closing or reloading the tab,
restarting the API, or losing its heartbeat requires a new connection and an
updated key in the MCP host. Disconnecting does not itself stop ordinary
listening. Audio started by the listener remains under the normal transport
controls.

## Available tools

| Tool | Purpose |
| --- | --- |
| `list_playback_devices` | Discover the single tab paired with the configured key. |
| `get_playback_device` | Read that tab's most recent draft observation, state version, saved revision, dirty flag, and observed playback. |
| `list_assets` | Read recordings already in the local library, including roles, duration, provenance, and rights. |
| `list_saved_sessions` | Read saved-session summaries available to the paired tab. |
| `submit_session_command` | Send a validated edit, play, pause, stop, save, or saved-session-open action. |
| `get_command_result` | Reconcile a submitted request using its original ID. |
| `undo_session_command` | Undo the latest successful assistant edit while its exact result is still current. |

Edits use the same scene commands as the web interface: layer addition/removal,
gain, stereo position, mute/solo, loops, equalizers, movement, occasional sounds,
master gain, limiter, listening timer, and transition settings. Use the input
schema exposed by the connected tool for the exact settings.

There are no MCP tools for importing or generating audio, installing sounds,
creating exports, or browsing arbitrary files. Add recordings through the web
interface and render finished mixes with the existing export panel.

## Read, change, reconcile

For each new adjustment:

1. Read `get_playback_device`. Require `connected: true` and use its current
   `deviceId`, `epoch`, and `state.stateVersion`.
2. Create a new request ID for this intent. Keep that ID and the exact payload
   until the outcome is known.
3. Submit one command with `expectedStateVersion` set to the version just read.
4. Read `get_command_result` with the same request ID until the receipt is
   terminal. A queued or dispatched receipt is not confirmation of application.
5. Read the device again before the next edit, saving, or describing playback.

For example, a master-volume adjustment has this shape. The identifiers and
version come from the live device response; they are not reusable sample IDs:

```js
const request = {
  deviceId: device.deviceId,
  epoch: device.epoch,
  requestId: newUniqueRequestId,
  expectedStateVersion: device.state.stateVersion,
  action: {
    type: 'edit',
    command: {type: 'setMasterGain', gain: 0.25}
  }
};
```

That gain is an example setting, not a measurement of listening loudness. Make
level choices with the listener's requested mix in mind.

The tools return named structured fields: `list_playback_devices` returns
`devices`, `get_playback_device` returns `device`, and command tools return
`receipt`. After submitting `request`, pass these arguments to
`get_command_result`:

```js
{
  deviceId: request.deviceId,
  epoch: request.epoch,
  requestId: request.requestId
}
```

Keep reading that receipt while its status is `queued` or `dispatched`. If the
tool returns `isError: true`, handle its `code` and `message` before proceeding;
an HTTP conflict is not an applied command receipt.

### What the reported fields mean

| Field or receipt | Meaning |
| --- | --- |
| `state.scene` | The most recently reported draft from the selected tab. Check `observedAt` for its age. |
| `state.stateVersion` | An optimistic concurrency version for that tab; local and assistant changes can invalidate a pending command. |
| `state.savedRevision` | The saved revision known to the tab, or `null` for a new unsaved session. |
| `state.dirty` | Whether the displayed draft contains unsaved changes. |
| `state.playback` | The browser's observed playback state, position, error, and AudioContext state. |
| `observedAt` / `connected` | When the server received the observation and whether the connection is still live. An old observation does not prove current playback. |
| `queued` / `dispatched` | The command is waiting for delivery or has been delivered without a completion acknowledgement. |
| `applied` | The browser acknowledged the operation. Inspect the result and current state for saved and playback facts. |
| `rejected` / `failed` | The browser or broker could not accept or complete the request. A failed operation may still have changed a draft or submitted a save; inspect state. |
| `expired` / `disconnected` | An undelivered command was closed before it reached the browser. |
| `unconfirmed` | A delivered command did not receive a timely acknowledgement. It may have taken effect. |

An `applied` receipt does not establish perceived sound quality, headphone
output, or uninterrupted phone background playback. A gain edit can be applied
to a stopped mix. Saving a draft does not start audio.

### Conflicts, retries, and undo

A command is checked against the observed version when queued and against the
browser's current version before execution. If a local control or another
operation changed the mix, read the current state and decide whether the
original adjustment is still appropriate.

After a lost response, query the original request ID. Repeating the identical
request returns its existing receipt; reusing the ID with different arguments
is rejected. An `unconfirmed` outcome must not become a blind retry under a new
ID. Inspect current state and any saved revision first.

`undo_session_command` takes the original successful edit's ID, a fresh request
ID for the undo, and the current state version. It restores that edit only if
no newer change has replaced its result. It does not undo transport actions,
saving, or opening a session, and it is not a general undo history.

Opening a saved session uses `action.type: "openSavedSession"` with `sceneId`.
An unsaved draft is preserved unless `discardUnsaved: true` is explicitly
provided. Save deliberately or obtain the listener's discard decision before
using that option.

### Browser interruptions

If playback reports `NEEDS_USER_GESTURE`, press **Start listening** in the
selected browser, then read fresh state before another command. The bridge
does not bypass browser audio restrictions. Background throttling, screen lock,
sleep, or a network interruption can disconnect assistant control even while
ordinary listening has a different state.

The default heartbeat is one second, with a fifteen-second connection lease
and command deadline. Inactive connection records and their receipts are
removed five minutes after the last heartbeat or explicit disconnection.
Each connection retains at most 512 command identities; reconnect when that
limit is reached. A server restart clears this temporary delivery state;
saved sessions remain in the normal database. If a receipt is no longer
available, reconnect and inspect the draft and saved session before deciding
what to do next; a missing receipt does not prove that an action never happened.

## Composition skill

The portable [ASMR composition skill](../skills/asmr-composition/SKILL.md)
teaches these controls, careful receipt handling, texture selection, imported
narration, pauses, and gradual adjustments. Copy the `skills/asmr-composition`
folder into a skill location supported by your assistant, or import the folder
through its skill manager. Installing the skill does not configure MCP or
enable a browser connection; complete the setup above separately.

## Development checks

Run `npm test` and `npm run typecheck` for the contract, broker, HTTP, adapter,
and browser unit checks. The targeted integration procedure is:

```sh
npm run test:e2e -- tests/e2e/assistant-controls.spec.ts
```

The test stack needs its configured loopback ports available. See
[development notes](development.md). These are verification commands, not a
claim about an untested device or listening result.
