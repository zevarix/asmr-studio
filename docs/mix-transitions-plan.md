# Saved mix transitions design

**Goal:** Choose two saved mixes, blend between them manually or over a chosen
time, and save/export that combination as an independent arrangement.

**User guide:** [Mix transitions](mix-transitions.md). The details below define
saved captures, playback timing, crossfades, and export. This feature adds
neither a playlist nor a general timeline.

## Saved model and capture boundary

Ordinary scene documents retain their existing shape. A transition is a distinct
scene ID with an optional `transition` object; its top-level layers are empty,
duration is null, and it has no top-level EQ or listening timer. Its master gain
starts at 1 and its final peak limiter starts enabled at the existing -1 dBFS
ceiling. Each captured mix retains its own master gain, EQ, limiter, listening
timer, layers, movement, loops, and occasional recipe.

The transition object contains `a` and `b` (nullable `CapturedMix`),
`curve: 'linear'`, `mode: 'manual' | 'timed'`, `blend` (0 through 1),
`durationSeconds` (0.1 through 3,600; default 30), `startSeconds` (nonnegative),
and explicit `startPositions: {a: 0, b: 0}`. A capture is
`{id, scene, assets}`. Its scene must be an ordinary saved mix at revision 1 or
later, and its complete asset records must exactly cover every saved reference,
including disabled occasional alternates. Captures cannot contain transitions.
The same asset ID in both sides must have identical records; different records
with the same content digest remain separate credits.

`POST /api/scenes/:id/capture` with `{expectedRevision}` atomically captures the
canonical source and asset records in an immutable capture table (database v2).
Arrangement saves and copies validate the exact capture ID/document against
that table. Later source saves therefore cannot alter or invalidate an accepted
capture. The existing scene revision/conflict protocol, save-copy, and export
job protocol apply to arrangements. Summaries identify `kind: mix | transition`.
Incomplete arrangements may save and play their available side, but exports
require both sides.

## Playhead and crossfader semantics

Both mixes follow one playhead, starting at their own position zero together.
A side selected while playback runs joins at the current playhead. The UI
explains this explicitly and offers Restart to hear both beginnings. This first
version has no source seeking or independently parked deck. An ended source
contributes silence; its saved timer and envelope are preserved, even when the
arrangement export is longer or shorter.

Manual mode renders a constant saved blend, not a recorded slider performance.
Timed mode holds the saved starting blend until `startSeconds`, then moves to B
over `durationSeconds` and remains at B. Starting a timed transition during
playback captures the current audio-clock blend and playhead into those saved
settings. A manual adjustment interrupts automation; Cancel holds its actual
current blend. Neither action records the earlier live performance. Pause holds
the shared playhead and fade position; Resume continues them. Stop resets the
playhead; Restart plays the saved arrangement from zero, including any saved
wait before its timed fade. Completion holds B without starting a new mix.
When both sides are finite, a timed arrangement lasts through the later of their
endpoints and the fade endpoint. Finished sides remain silent. Natural completion
retains the final playhead and blend; the next Play rewinds for a fresh replay.

The pure gain rule is `A = 1 - blend`, `B = blend`. An aligned identical
recording has no added midpoint boost. Uncorrelated recordings can have a
perceived midpoint dip. There is no hidden normalization or audible layer
deduplication. An incomplete arrangement routes its one available side at full
blend gain. Manual and timed controls require both captured sides.

## Audio and transactional preparation

One mixer owns the shared transport, asset/loop caches, and decoded-memory
budget. Each side has independent layer IDs, solo scope, master processing,
limiter, and listening envelope before its blend gain. Their sum feeds the
arrangement master gain, final selected limiter, and combined meters.

Gain automation runs on the audio clock. Display ticks only report progress.
Manual edits use the existing short edit fade. B's assets, loops, and processing
nodes are preflighted before swapping its accepted capture/graph; failed or
superseded preparation retains A and the previously accepted B. Pause, Stop,
session switches, and disposal invalidate stale starts. Side capture assets
provide canonical durations for occasional scheduling.

## Export

Reuse the immutable export job, source verification, cancellation, and final
WAV verification. Build independent side graphs into one four-channel Float32
stream, process the two captured limiters/listening envelopes in bounded blocks,
apply the shared gain rule and arrangement master/output policy, and quantize
once to stereo PCM16. Do not create intermediate PCM16 mixes or retain two
full-duration floating-point files. Decoded sources and occasional spools share
one job budget. Ordinary-scene rendering remains on its existing path.

Both capture identities/revisions and every accepted asset declaration remain
in the export recipe/credits. Inactive or silent sides still retain their rights
and credit requirements. Captured-side timers keep their saved endpoints;
ordinary scene exports keep their existing endpoint behavior.

## Verification

- [Contract tests](../packages/contracts/src/transition.test.ts) cover the
  nonrecursive capture schema, commands, defaults, references, and boundaries.
- [Engine tests](../packages/audio-engine/src/engine-transition.test.ts) cover
  transactional side preparation, allocation, automation, transport, and failures.
- [Transition writer tests](../apps/server/src/transition-output-wav.test.ts)
  cover bounded four-channel processing and final stereo output.
- [Native audio checks](../tests/e2e/mix-transition-audio.spec.ts) exercise
  browser/export agreement, failed-side continuity, unequal or silent sides,
  shared assets, and combined peaks.
- [Browser controls](../tests/e2e/mix-transition-ui.spec.ts) exercise source
  edits, reopen/copy, cancellation, keyboard interaction, and narrow layouts.

These checks verify state and signal behavior. Listening is still needed to
judge the perceived transition between two different recordings.
