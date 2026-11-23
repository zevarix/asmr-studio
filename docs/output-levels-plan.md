# Output levels design

**Goal:** Show actual stereo output levels and optionally limit sample peaks,
with matching saved-session and WAV behavior.

**Architecture:** A small shared sample processor runs in an AudioWorklet for
listening and a bounded float-PCM stream stage for enabled exports. The mixer
exposes a separate meter subscription so 20 Hz display updates stay out of
session editing and transport state. Disabled exports retain their existing
native rendering path.

**Tech stack:** Existing TypeScript, Web Audio, React, Vite, Fastify, SQLite,
FFmpeg, Vitest, and Playwright. No new third-party dependency is needed.

**User guide:** [Output levels](output-levels.md). See also the
[audio tools overview](audio-tools.md#first-addition-output-levels).

## Constraints

- Preserve optional schema-version-1 recipes without injecting new defaults.
- Limiting is off by default; default enabled ceiling is −1 dBFS.
- Ceiling range is −12 to −0.1 dBFS; the UI step is 0.1 dB.
- Use identical stereo-linked gain, immediate attack, fixed 100 ms release,
  no makeup gain, no lookahead, no added latency, and no added tails.
- Keep sources and the playback clock continuous during control changes.
- Preserve exact neutral samples, source bytes, permissions, and finite frame counts.
- Existing browser/export tolerances remain unchanged: maximum error 3 PCM16
  quanta and RMS error 0.75 quanta.

## Failure cases to prove

1. A brief peak on just one channel must be caught and attenuate both channels
   equally; UI polling must not miss the event.
2. A disabled or absent limiter must leave quiet signals and exact silence
   unchanged, including after a prior enabled session.
3. Async worklet loading, failed loading, replacement, or disposal must not
   attach obsolete nodes or silently play an enabled-but-unapplied limiter.
4. Float-stream chunks may split a stereo frame; cancellation and malformed
   data must not produce a successful partial export.
5. Resetting meters must not save/dirty a mix, and live setting edits must
   survive save/reopen while preserving source identity and transport time.

## Recipe and command boundary

`OutputLimiterSettings` contains `enabled:boolean` and `ceilingDb:number`.
The optional `Scene.outputLimiter` preserves older recipes. The
`setOutputLimiter` command carries detached, validated settings and retains
the selected ceiling when limiting is disabled.

The contract lives in
[output.ts](../packages/contracts/src/output.ts), with
[tests](../packages/contracts/src/output.test.ts) for finite bounds, unknown
fields, detached commands, export recipes, and bypass.

## Shared processing and live audio

[StereoOutputProcessor](../packages/audio-engine/src/output-processor.ts)
applies the linked gain and collects per-channel peak/RMS/held peak, latched
full-scale flags, and positive gain reduction in dB. It uses bounded storage
and Float32 output.

The [worklet](../packages/audio-engine/src/output-worklet.ts) processes actual
buffer lengths and reports 50 ms meter windows. Vite bundles its imports through
`?worker&url`. The [output stage](../packages/audio-engine/src/output-stage.ts)
owns the node, settings, meter subscription, resets, and disposal.

An optional async output-stage factory connects this processing after master
gain. Callers without a stage keep the legacy path and reject enabled limiting.
Meter subscriptions and resets remain independent of playback-state updates.

## Finite WAV rendering

Enabled rendering consumes the owned FFmpeg process's unclipped stereo float
stream, runs the same processor at 48 kHz, and writes bounded PCM16 chunks.
Disabled rendering retains the native path when no other output processing is
required. Cancellation closes the child process and incomplete, extra, or
non-finite samples cannot produce a successful export.

The writer preserves the requested frame count, memory limits, digest checks,
and full-scale measurements. Loop regressions cover partial-packet repetition,
mono/stereo sources, one-frame overlap, and short output durations. Repeat caches,
split-mixer queues, FIFO growth, and working blocks all count toward the budget.

## Controls and verification

The panel subscribes to meters at 20 Hz without announcing every animation frame.
It shows L/R levels, held peaks, full-scale status, gain reduction, reset,
enabled state, and ceiling. Initialization failures stop playback with an error;
the interface must not claim that enabled limiting is active when it is not.

- [Processor tests](../packages/audio-engine/src/output-processor.test.ts) cover
  linkage, exact bypass, release, block sizes, meter holds/reset, silence,
  non-finite samples, and 44.1/48 kHz processing.
- [Worklet tests](../packages/audio-engine/src/output-worklet.test.ts) and
  [stage tests](../packages/audio-engine/src/output-stage.test.ts) cover parameter
  delivery, loading, failure, cleanup, and stale async work.
- [Engine tests](../packages/audio-engine/src/engine-output.test.ts) cover stage
  integration and live edits.
- [Writer tests](../apps/server/src/output-wav.test.ts) and
  [browser/export comparisons](../tests/e2e/finished-export.spec.ts) cover finite
  output, chunk boundaries, cancellation, sample agreement, and exact silence.
- [Browser controls](../tests/e2e/output-ui.spec.ts) cover keyboard edits, source
  continuity, saving, meter reset, and narrow layouts.

Primary API references: [Web Audio](https://www.w3.org/TR/webaudio-1.0/),
[Vite worker imports](https://vite.dev/guide/features.html#web-workers), and
[FFmpeg filters](https://ffmpeg.org/ffmpeg-filters.html).
