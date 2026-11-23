---
name: asmr-composition
description: Compose and adjust a local ASMR Studio mix through its optional MCP controls. Use when a listener asks to combine ambience, tactile textures, and imported narration, change the selected browser's mix or playback, save a session, or undo a recent assistant edit.
---

# ASMR composition

Use the listener's requested mood, textures, narration, and duration to guide
the mix. Keep the web mixer useful alongside the assistant. Treat a tool result
as a report about software state, not proof that the listener likes the sound.

## Connect and select

Require the local ASMR Studio MCP tools and an explicitly enabled browser tab.
If they are unavailable, use the
[assistant-control setup guide](https://github.com/zevarix/asmr-studio/blob/main/docs/assistant-controls.md).
Do not invent a hosted endpoint or ask the listener to publish a private key.

Call `list_playback_devices`, then `get_playback_device` for the paired device.
Carry its explicit `deviceId` and `epoch` into later calls. Check `connected`
and `observedAt`; do not treat an old playback observation as current.

Use only these implemented tools:

| Tool | Use |
| --- | --- |
| `list_playback_devices` | Find the single browser paired with this connection. |
| `get_playback_device` | Read the most recent draft observation, state version, saved revision, dirty flag, and observed playback. |
| `list_assets` | Find available recordings, durations, roles, and source rights. |
| `list_saved_sessions` | Find saved-session identities and revisions. |
| `submit_session_command` | Apply an existing scene edit or a play, pause, stop, save, or saved-session-open action. |
| `get_command_result` | Reconcile the original request ID after submission. |
| `undo_session_command` | Undo the latest successful assistant edit while its exact result remains current. |

Use the live tool schemas for arguments. Obtain asset, layer, device, and scene
IDs from actual responses. Generate a new layer ID only when adding a new
layer. Never use canned IDs or a remembered state version as current authority.
Read the named result fields: discovery returns `devices`, the device read
returns `device`, library reads return `assets` or `sessions`, and command tools
return `receipt`. A tool error instead reports `code` and `message`; resolve it
before issuing another mutation.

## Compose a clear mix

1. Read the current draft and library before changing the mix. Preserve sounds
   and settings the listener already chose unless the request calls for a
   change. Ask only for a missing preference that materially affects the result.
2. Begin with one quiet ambient bed and one main tactile texture. For example,
   combine a soft stream with brushing, or quiet rain with fabric sounds.
   Add another layer only when it contributes something distinct.
3. Keep imported narration independently adjustable. Lower competing ambience
   or textures before boosting the voice. Keep words clear and avoid rapid or
   wide stereo movement while speech is the focus.
4. Leave room between foreground sounds. Use the existing occasional-sound
   settings for spaced events; use a non-looping narration layer when the
   recording should play once. Check the recording duration before setting a
   loop, start position, or crossfade.
5. Use restrained tone and stereo changes, with one change at a time. When a
   mix feels too busy, reduce or remove a layer before adding more processing.
6. For gradual endings, use the existing listening-timer fade settings. For a
   transition arrangement, preserve its captured mixes and use its supported
   transition settings. Read the schema rather than inventing a ramp field.
7. Save when requested and verify the saved revision separately. Keep an
   exploratory adjustment unsaved when the listener is still auditioning it.

Treat starting gain values as suggestions for listening, not measurements of
headphone volume. Let the listener's feedback determine whether a texture,
loop, fade, or voice balance works.

## Execute one intent at a time

Before each mutation, call `get_playback_device` and use the returned
`state.stateVersion` as `expectedStateVersion`. Generate a fresh request ID for
the new intent and retain the exact payload. Do not queue a sequence based on
one old state read.

For example, lowering an existing brushing layer uses the real layer ID:

```js
{
  deviceId: device.deviceId,
  epoch: device.epoch,
  requestId: newUniqueRequestId,
  expectedStateVersion: device.state.stateVersion,
  action: {
    type: 'edit',
    command: {type: 'setLayerGain', layerId: selectedLayer.id, gain: 0.15}
  }
}
```

After submission, call `get_command_result` with that original request ID.
Wait for a terminal result before describing success or issuing the next
intent. Read the device again to reconcile its displayed draft and playback.

For a gradual manual change, use a few modest adjustments, reconciling each
one and reading a fresh version before the next. Do not claim to have installed
an unattended schedule. Prefer the app's saved timer or transition controls
when those match the requested timing.

## Handle uncertain results and user edits

- Treat `queued` and `dispatched` as pending. They do not confirm application.
- Treat `applied` as a browser acknowledgement. Inspect `dirty`,
  `savedRevision`, and `playback` separately; an edit may apply to a stopped mix.
- For a conflict or a newer local edit, read current state and reconsider the
  intended adjustment. Do not overwrite the listener's newer choice.
- After a network error or `unconfirmed` result, reconcile the original request
  ID and current state. Never generate a new ID merely to retry an uncertain
  operation. Do not conclude that a lost acknowledgement means nothing changed.
- If the API restarted or a receipt was removed after the connection expired,
  inspect the newly connected draft and saved session before deciding what to
  do next. A missing receipt does not establish that the original action failed.
- For `failed`, inspect both the draft and saved revision. A failed audio
  update can leave draft changes; an incomplete save can have saved an earlier
  submitted snapshot.
- Use `undo_session_command` only for the latest successful assistant edit,
  with its original request ID, a fresh undo request ID, and current version.
  Newer edits prevent undo. Transport, saving, and opening sessions are not
  reversible through this tool.
- Preserve a dirty draft when opening another saved session. Use
  `discardUnsaved: true` only for an explicit discard instruction; otherwise
  save deliberately or obtain that decision.
- For a disconnected tab, require a new browser connection. For
  `NEEDS_USER_GESTURE`, have the listener press **Start listening** in that tab,
  then read fresh state. Do not claim to bypass browser restrictions.

## Respect the available recordings

Use `list_assets` to check what is actually available. If the requested
narration or texture is absent, explain how to add it with **Import your audio**
or the starter-library interface. There is no import, whisper-generation,
sound-download, or export MCP tool in this integration.

Keep private recordings, scripts, voice references, preferences, and connection
keys out of distributable examples and source files. The application's MIT
license does not relicense recordings. For a mix the listener plans to share,
direct them to the web export panel's **Recipe & credits** and the applicable
recording permissions.

Finish with the changes actually acknowledged, the current saved/unsaved state,
and any unresolved playback or listening check. Do not claim subjective audio
quality or physical-device background behavior from software acknowledgements.
