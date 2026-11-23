# Listening timer and fades design

**Goal:** Give saved listening sessions a predictable countdown and gradual beginning
and ending, with the same fresh envelope in a chosen-length WAV export.

**User guide:** [Listening timer](listening-timer.md). The details below define
its saved settings, audio-clock behavior, export envelope, and verification.

**Architecture:** Keep the current transport clock and source envelopes. Schedule
a separate session envelope against the audio clock after limiting and before
final metering. The existing output worklet exposes an a-rate gain parameter;
the engine uses a native gain when no output stage is installed. Exports use the
same Float32 envelope math in the bounded output writer. No new dependency.

## Contract and behavior

`Scene.listeningTimer?: ListeningTimerSettings` contains `enabled: boolean`,
`durationSeconds: number`, `fadeInSeconds: number`, and `fadeOutSeconds: number`.
Duration is finite and positive; fades are finite and nonnegative and their sum
must fit the duration. Equality permits a triangular envelope. There is no new
arbitrary duration cap. Defaults are Off, 2700 seconds, zero fade-in, and 180
seconds fade-out. Off retains the accepted values.

When this optional object is absent, preserve legacy `scene.durationSeconds`
behavior and JSON. When present it owns the timer: enabled uses its duration,
disabled has no explicit deadline. `setListeningTimer {timer}` validates and
detaches the complete settings and clears the legacy duration to null.

Shared contracts export `defaultListeningTimer()`,
`listeningDuration(settings, legacyDuration): number | null`, and
`listeningFadeError(settings, endpointSeconds): string | null`.
The audio engine exports
`listeningEnvelopeGain(settings, elapsedSeconds, endpointSeconds): number`.
It is the Float32, bounded, piecewise-linear fresh gain: fade-in from zero,
unity plateau, fade-out to zero at the endpoint. Absent/Off is unity. Zero fades
retain unity before the endpoint; existing 20 ms source transitions remain
separate. An enabled live timer gates the entire output to zero at its deadline,
including filter tails, without waiting for a UI callback.

| Action | Behavior |
| --- | --- |
| Fresh Play | Start elapsed time and the recipe envelope at zero. |
| Pause/interruption | Freeze elapsed time and actual envelope gain. |
| Resume | Continue from the held time/gain. |
| Manual Stop | Reset elapsed time; retain saved settings. |
| Automatic completion | Ready state at the exact deadline, with zero remaining; Play starts fresh. |
| Fade-only edit | Keep sources and clock; bridge held gain to the new curve over 20 ms. |
| Duration edit | Preserve clock and offsets; use the existing compensated source transition to replace scheduled source endings. |
| Deadline edited into the past | Release the audible mix over 20 ms, then complete. |
| Rapid Stop/Play | Blend into the fresh curve while an outgoing release is audible; do not introduce a burst on an ordinary fresh fade-in. |
| Finite recording | Finish naturally; the timer does not repeat or extend it. The remaining session may be silent. |

The UI uses a compact Listening timer disclosure near playback, Off/On, three
minute inputs accepting fractions, and one Apply action. Invalid drafts stay
editable and explain the error without changing the accepted recipe. Elapsed,
remaining time, and fading state do not dirty the session. Only state transitions
belong in a live region; numeric clocks do not announce every tick.

Exports keep their selected duration as the endpoint, independent of the saved
listening deadline. Validate active fades against the actual rounded output
duration, both before accepting a job and inside the renderer. Never scale an
impossible combination silently. Preserve original captured settings. Absent,
Off, and zero-fade exports retain the existing byte-identical native path when
the limiter is off. Active fades use the bounded Float32 writer after limiting,
before PCM16 conversion. Final meters measure the faded output; limiter gain
reduction continues to describe limiting alone.

## Alternatives considered

A display-timer fade would drift or stall with background callbacks, so audio
automation owns the deadline. Fading before the limiter would require fewer
output changes but can hold an overdriven mix at its ceiling for much of a fade.
The chosen output gain parameter keeps the fade predictable and meters truthful.
Rebuilding all source scheduling is unnecessary: duration changes can reuse the
existing short compensated transition, while fade-only edits retain sources.

## Review focus

1. A delayed UI callback must not let sound or EQ decay pass the audio deadline.
2. Extending/disabling an active timer must replace already scheduled source stops.
3. Rapid restart, paused edits, and interrupted ramps must avoid gain bursts or jumps.
4. A short export must reject incompatible fades before creating a job, including a save/edit race.
5. Output meter peaks/RMS must reflect the post-limiter fade; a zero gain must not hide an invalid-input fault.

## Verification

- [Contract tests](../packages/contracts/src/listening-timer.test.ts) cover
  optional settings, retained Off values, detached commands, invalid fades,
  fractional boundaries, and export-endpoint validation.
- [Envelope tests](../packages/audio-engine/src/listening-timer.test.ts) and
  [engine tests](../packages/audio-engine/src/engine-listening-timer.test.ts)
  cover the shared gain math, transport, live edits, and deadline cleanup.
- [Native audio checks](../tests/e2e/listening-timer-audio.spec.ts) exercise held
  automation, natural endings, short triangular envelopes, and source continuity.
- [Browser controls](../tests/e2e/listening-timer-ui.spec.ts) exercise editing,
  saving, paused countdowns, and narrow layouts.
- [Export comparisons](../tests/e2e/finished-export.spec.ts) retain maximum
  3 / RMS 0.75 PCM16-quanta limits and exact-silence assertions, including exports
  whose endpoint differs from the listening timer.

Phone background and screen-off behavior require actual device testing.
Neither browser signal checks nor a listening timer establish a system alarm.
