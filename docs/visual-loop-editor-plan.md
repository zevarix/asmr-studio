# Visual loop editor design

**Goal:** Find and audition useful repeated sections without losing precise
numeric editing or interrupting the other sounds in a session.

**User guide:** [Loop editor](loop-editor.md). The details below define the
waveform, draft editing, preview, and resource limits.

## Design

Keep the existing Loop details disclosure and three numeric fields. Add an SVG
waveform, Start and End range handles, shading for the selected region and its
overlapping head/tail, and Preview join. Native range controls support pointer,
touch, and keyboard input; precise number entry remains available at any width.
Only one layer's editor is open at a time.

Numbers, handles, and shading describe a draft. Preview does not edit the scene.
Apply loop changes only that layer using the existing command; Save session
persists the applied values. Closing the editor retains its unapplied numeric
draft in this session while stopping preview and releasing its audio resources. A
boundary handle moves by decoded frames and clamps the crossfade to fit; numeric
entry rejects invalid combinations instead of silently rewriting them.

The engine exports its existing rounded-frame validation as `getLoopFrames`.
The editor uses the decoded length and sample rate when available, with recording
metadata as a fallback. Failed drawing or decoding leaves numeric editing usable.
No scene schema, source media, provenance, or export-format change is needed.

## Waveform and resource lifetime

Use a small native SVG over at most 1,024 min/max bins spanning all channels.
Inspect every sample so isolated transients and anti-phase stereo stay visible;
yield and check cancellation every 262,144 samples. Cache only completed envelopes
in a 16-entry LRU (at most 128 KiB of peak arrays), keyed by content, decoded sample
rate, and frame count. No new package or audio player dependency is needed.

Borrow original decoded buffers from the mixer, including pending decodes. When
playback starts after editing, it can reuse the currently held editor buffer.
Otherwise serialize one editor-owned decode at a time; abort its fetch and discard
obsolete unabortable decode results. Bound new editor downloads and decoded PCM
to 64 MiB each, check metadata before decoding and actual size afterward. A buffer
already admitted by the mixer's existing budget may be borrowed without another
PCM copy. Keep only the open editor's buffer; closing/switching releases it and
cancels scanning. Dispose only the editor's own audio context.

## Audition

`createLoopJoinPreview` renders exactly two seconds centered on the prepared
period's repeat point, using the same direct samples and linear overlap writer
as `prepareLoop`. It allocates only the excerpt, even for a long selected interval.
Short periods repeat naturally. For an overlap longer than one second, the
excerpt includes its final second before the repeat point.

Preview is a separate, finite recording at 25% gain, with 20 ms entrance/exit
ramps outside the central seam. Like the library preview it requires a paused mix.
Library and loop previews exclude each other. Start, Stop, a new preview, draft
edits, editor close, asset switch, and scene replacement invalidate obsolete
resume/decode callbacks and stop owned preview sources. Apply remains available
during playback and preserves the main clock and unaffected sources.

## Verification

- [Loop math tests](../packages/audio-engine/src/loops.test.ts) cover mono/stereo
  audio, fractional endpoints, short periods, zero and half-interval crossfades,
  unchanged inputs, and bounded preview allocation.
- [Editor audio tests](../apps/web/src/features/mixer/loop-audio-service.test.ts)
  cover scanning, caching, buffer acquisition, and cancellation.
- [Native loop checks](../tests/e2e/loop-audio.spec.ts) exercise the prepared seam
  and playback behavior.
- [Browser controls](../tests/e2e/loop-editor-ui.spec.ts) cover waveform handles,
  keyboard and numeric entry, draft settings, preview, persistence, and narrow
  layouts.

Signal checks verify seam math and lifecycle. Listening is still needed to judge
a selected section and crossfade.
