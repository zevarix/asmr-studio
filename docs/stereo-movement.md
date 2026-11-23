# Stereo movement

Open **Movement** on a layer and choose **Sway** to let that sound travel gently
from side to side. Each layer has its own movement settings, so a texture can
move while the surrounding ambience stays steady. New and existing layers
start with movement off.

## Controls

- **Stereo position** sets the center of the movement.
- **Width** sets how far the sound travels on either side of that center.
  The initial width is 30%. Zero width holds the sound at its center.
- **Cycle time** is the number of seconds for one complete round trip. It starts
  at 30 seconds and accepts values from 2 to 600, including fractions. Arrow
  keys adjust it by one second.
- **Off** returns to the fixed stereo position and keeps the width and cycle
  settings for the next time you enable Sway.

The available travel shrinks near either stereo edge. For example, a center at
Right 90% can travel only from Right 80% to Right 100%, even if the requested
width is larger. The controls show the effective travel and explain when the
center or zero width prevents movement. Move the center inward for more room.

Movement is stereo panning. It does not simulate a room or track head position.
Use headphones to judge whether the chosen width and speed suit the recording.

## Playback and saving

A fresh play starts at the layer's center and moves toward the right. A delayed
layer starts its movement when its recording starts. Pause holds the movement
phase; resuming continues it. Stop resets the phase for the next play. Rapid
Stop/Play blends into the fresh movement over 20 ms while the outgoing audio
fades, keeping the transition smooth.

You can change the center, width, or cycle time while listening. The engine
smooths these changes over 20 ms without restarting the recordings or resetting
the playback clock. Muting or soloing layers does not reset their movement.
An established movement phase continues while its layer is muted or Sway is
off. Adding a layer during playback initializes it from that layer's elapsed
time in the session.

The settings save, copy, and reopen with the session. Expanding the controls
does not change the recipe. Turning Sway off preserves its settings. Existing
recipes without movement settings keep their fixed stereo positions.

## WAV exports

[Finished mixes](exports.md) apply movement from the captured saved revision.
Each layer starts at its center at the saved start time, and movement continues
across sound-loop repetitions. A finite recording's EQ decay passes through the
moving panner until that decay ends or the export reaches its requested end.

An export renders the saved recipe from the beginning. It does not replay the
history of pauses, live edits, or enable/disable changes made while listening.
Movement leaves the source recordings and their credits intact.

## Validation scope

The implementation includes [native browser signal checks](../tests/e2e/movement-audio.spec.ts),
[WAV comparisons](../tests/e2e/finished-export.spec.ts), transport and live-edit
checks, saved-session checks, and [keyboard and narrow-screen coverage](../tests/e2e/movement-ui.spec.ts).
The [design notes](stereo-movement-plan.md#verification) describe these boundaries.

Signal checks do not replace listening or establish phone screen-off behavior.
