# Stereo movement design

**Goal:** Let selected layers sway around their saved stereo position, with
continuous live controls and matching finite exports.

**Architecture:** Keep the existing stereo panner. An audio-clock sine/cosine pair
modulates its pan through two coefficient gains; JavaScript display timers never
schedule movement. Fresh restarts blend the old and new trajectories over 20 ms
using those gains, without switching waveforms or allocating more oscillators.
The exporter evaluates the same fresh-recipe trajectory per sample, using the
established Web Audio pan equations inside the owned FFmpeg process.

**Tech stack:** Existing TypeScript, Web Audio, React, FFmpeg, Vitest, and
Playwright. No dependency or additional processing worklet is required.

**User guide:** [Stereo movement](stereo-movement.md).

## Behavior and shared interfaces

`Layer.movement?: StereoMovementSettings` contains `enabled: boolean`,
`width: number` from 0 to 1, and `cycleSeconds: number` from 2 to 600.
Fractional values are valid. `defaultStereoMovement()` returns
`{enabled:false, width:0.3, cycleSeconds:30}`; parsing never injects defaults
into old recipes. These cycle bounds span a two-second sweep through a
ten-minute drift; the initial cycle remains thirty seconds.

`setLayerMovement` carries `layerId` and the complete `movement` settings.
It follows the existing detached, validated layer-command boundary.

The engine exports:

- `movementParameters(pan, settings): {center, radius, frequency}`.
- `movementPan(pan, settings, elapsedSeconds): number`, for a fresh saved recipe.

Center, radius, and frequency use Float32 values, matching AudioParam precision.
Radius is `min(width, 1 - abs(center))`, or zero when disabled. Frequency is
`1 / cycleSeconds`, quantized before phase calculation. Fresh position is
`center + radius * sin(2 * PI * frequency * elapsedSeconds)`, bounded to [-1, 1].
The first movement is from center toward the right. Width is an absolute pan
radius; moving the center toward an edge reduces available travel.

| Action | Defined behavior |
| --- | --- |
| Fresh play / replay after Stop | Phase zero at the layer's saved start; an audible replay blends to the fresh trajectory over 20 ms. |
| Delayed layer | Center until its start, then begin the phase. |
| Add layer during playback | Initialize from `max(0, scenePosition - startSeconds)`, matching source offsets. |
| Pause / interruption | Freeze movement phase. |
| Resume | Continue the held phase. |
| Saved start-time edit | Reinitialize from the new elapsed offset or remaining delay; a paused edit preserves the held pan until resume. |
| Center / width edit | Ramp center and effective radius over the existing 20 ms interval. |
| Cycle edit | Ramp frequency over 20 ms while retaining phase. |
| Movement Off | Ramp depth to zero and retain settings; an established phase continues while transport runs. |
| Mute / solo | Change audibility without resetting movement. |
| Stop / remove / replace / dispose | Retire owned modulation safely, including existing outgoing audio tails. |
| Export | Render the captured recipe afresh; live edit history is not part of the recipe. |

Absent, disabled, zero-width, and edge-centered settings retain the static
export path. No new phase field or schema version is introduced.

## Review focus

1. Rapid Stop/Play and Off/On must not double modulation depth or jump the pan
   of an audible outgoing tail; exercise these in engine and native tests.
2. Pausing before a delayed layer starts must not consume its future movement
   phase; prove held/resumed timing in engine tests.
3. An unrelated edit must not restart movement or recording sources; assert
   source identity and advancing transport in engine and native UI tests.
4. A failed graph allocation or async layer addition must preserve the accepted
   mix and release only newly owned nodes; cover the failure path in engine tests.
5. Float32 frequency and long elapsed time must remain consistent with export;
   use shared-trajectory tests plus native comparisons spanning both pan signs.

## WAV implementation

The export renderer applies dynamic pan after the layer envelope, EQ, and gain,
before its saved-start delay. It uses per-sample `n / 48000` timing and a named
stereo Float32 boundary after panning, so downstream master EQ retains both
channels. Each active moving layer reserves two additional 64 KiB working blocks.

## Verification

- [Contract tests](../packages/contracts/src/movement.test.ts) cover optional
  settings, fractional boundaries, unknown and invalid fields, detached edits,
  retained Off values, and legacy recipe identity.
- [Trajectory tests](../packages/audio-engine/src/movement.test.ts) cover the
  shared quantized math.
- [Engine tests](../packages/audio-engine/src/engine-movement.test.ts) exercise
  pause/resume, delayed starts, late additions, restarts, mute/solo, zero width,
  extreme centers, rapid changes, and allocation failures.
- [Native audio checks](../tests/e2e/movement-audio.spec.ts) and
  [export comparisons](../tests/e2e/finished-export.spec.ts) cover both pan signs,
  delayed loops, finite EQ tails, and the combined EQ/limiter path.
- [Browser controls](../tests/e2e/movement-ui.spec.ts) cover defaults, retained
  settings, bounds, keyboard interaction, source continuity, save/reopen,
  and narrow layouts.

Browser/export comparisons retain maximum 3 / RMS 0.75 PCM16-quanta limits and
exact-silence assertions. Signal checks do not establish listening preference or
phone background behavior.

Primary references: [Web Audio](https://www.w3.org/TR/webaudio-1.0/),
[FFmpeg filters](https://ffmpeg.org/ffmpeg-filters.html), and
[export behavior](exports.md).
