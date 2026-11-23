# Occasional sounds design

**Goal:** Let taps, page turns, and other gestures recur with pauses and optional
alternate recordings, while a saved mix and its WAV share a reproducible recipe.

**User guide:** [Occasional sounds](occasional-sounds.md). The details below
define the saved settings, deterministic scheduling, and export behavior.

## Interaction and saved settings

Add a Playback mode choice to each layer: its existing loop/play-once behavior,
or Occasionally. Occasional playback uses each whole recording once, preserving
the saved loop for switching back. Its first event starts at the layer's saved
start offset. Each pause begins at the preceding event's canonical end; events
on one layer never overlap except for the existing short transport/edit fades.

The optional `occasional` settings contain `enabled`, `minPauseSeconds`,
`maxPauseSeconds`, a uint32 `seed`, `alternateAssetIds`, `levelVariation`, and
`panVariation`. Starting pauses are 4–12 seconds, with no level or position
variation. Pauses must be 0.25–3,600 seconds and minimum must not exceed maximum.
Allow up to seven distinct alternates in addition to the primary recording.
Level variation only attenuates, by up to 25%; position variation ranges up to
25% left/right before the layer's main position and movement. A New variation
action saves a new seed. Settings persist while the mode is disabled.

Range edits are an applied draft so a user can edit either pause bound without
sending an invalid intermediate recipe. Alternates use searchable library
selection. Changing one layer preserves other sources and the transport clock.

## Deterministic schedule

Share a pure scheduler between the browser and export. Event boundaries use
integer 48 kHz ticks and saved asset-record durations, rounded to at least one
tick. A block contains two independently seeded shuffles of all selected assets.
Each asset appears twice per block; repetitions at shuffle boundaries are
allowed. The second set of pauses complements the first, so a block's total
duration is known without generating earlier blocks. Independent hash domains
choose shuffles, pauses, attenuation, and position. New block indices produce new
choices rather than repeating a finite playlist.

This balance makes a jump to a distant playhead bounded by twice the selected
asset count. The browser refills one second of audio-clock scheduling every
100 ms. Delayed callbacks skip expired events and resume a still-active event at
its elapsed offset; they never replay a backlog. A throttled background tab can
have a gap when lookahead runs out. Pause holds the playhead, Stop resets it, and
restart follows the same seed. Canonical duration bounds timing; a decoder that
returns less content may finish early, while excess decoded padding is clipped.

## Audio and resource ownership

Each occasional event has a 20 ms entrance/exit envelope (short clips use a
triangle), attenuation, and its own stereo panner. It feeds the existing layer
EQ, gain, position/movement, mute/solo and master chain. The event panner creates
a stereo bus, including when variation is zero. Position variation and the main
layer panner compose in series, rather than adding numerical pan positions.
Movement keeps its phase relative to the layer start throughout silent gaps.

Load only the active playback references; count alternate PCM and retiring
sources in the existing decoded-memory budget. Reconciliation preflights new
assets and keeps accepted playback if a load fails. Transport/edit boundaries
cancel queued nodes and dispose event panners with their sources. Tests may
inject scheduler ticks at OfflineAudioContext suspension points; production uses
the bounded live timer.

Export writes stereo event PCM at its file offsets in cancellable, bounded blocks, then uses
the existing layer/master render chain. It does not build an FFmpeg input graph
per event or accumulate the complete mix in memory. Each event fades at its
actual truncated export endpoint; the occasional branch avoids an extra whole-
layer envelope. Temporary event files share an approximately 8 GiB logical-size
limit, including silent gaps, because sparse allocation differs across filesystems.
Existing and disabled recipes retain the previous render path.
All saved alternate references are validated and captured by record ID, including
their complete provenance and rights, even if not drawn during a short export.

## Verification

- [Contract tests](../packages/contracts/src/occasional.test.ts) cover optional
  settings, commands, reference coverage, persistence, and immutable recipes.
- [Scheduler tests](../packages/audio-engine/src/occasional.test.ts) cover fixed
  golden sequences, changed seeds, multiple durations, half-open boundaries,
  and bounded distant seeking.
- [Engine tests](../packages/audio-engine/src/engine-occasional.test.ts) cover
  scheduling, transactional edits, cancellation, pause/resume, and legacy scenes.
- [Native audio checks](../tests/e2e/occasional-audio.spec.ts) and
  [export comparisons](../tests/e2e/finished-export.spec.ts) exercise timing and
  signal agreement, gaps, truncation, channel layouts, and controls.
- [Browser controls](../tests/e2e/occasional-ui.spec.ts) cover mode, pause,
  alternatives, variation, saved settings, and narrow layouts.

Signal checks do not establish perceived naturalness or phone background
playback. Those require listening and device testing.
