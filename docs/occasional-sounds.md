# Occasional sounds

Use occasional playback for gestures that need space: a page turn, a few taps,
a brush stroke, or a short fabric recording. Other layers can continue looping.

## Make a layer occasional

1. Add a recording to the mix and change its **Playback mode** to **Occasionally**.
2. Set **Minimum pause** and **Maximum pause**, then choose **Apply pauses**.
   Pauses start after a recording ends. Both values are in seconds; equal values
   give a fixed pause. The allowed range is 0.25–3,600 seconds.
3. Optionally search for and add **Alternate recordings**. The primary recording
   stays in the selection; up to seven alternates can join it.
4. Optionally add **Level variation** or **Position variation**. Both start at
   zero. Level variation only makes some events quieter, by up to 25%.
5. Save the session. **New variation** chooses a different sequence; save again
   to keep that choice.

Each event plays the whole recording once. The existing loop range is retained
and returns when you choose **Standard** playback. Standard also keeps the
original **Loop continuously** checkbox and play-once behavior. Original audio
files are never edited.

Alternates are balanced through shuffled groups: each selected recording plays
twice per block, with a new order and variations in subsequent blocks. Adjacent
groups can repeat a recording. Every layer starts at its saved start offset;
separate layers may overlap, while events on one layer wait for their pause.

## Transport and sound controls

Pause holds the sequence position. Start after a pause resumes from that point;
Stop followed by Start repeats the recipe from the beginning. Editing a layer
changes that layer at the current playhead without restarting its neighbors.
Changing the seed does not reset the session clock.

Each event receives a short entrance and exit fade. Its optional position
variation comes before the layer's equalizer, volume, stereo position and
movement. The event and layer panners operate in series: their percentages are
not added. Each occasional event feeds a stereo bus, including a mono recording
with zero variation. Movement continues through the pauses. Mute, Solo, master
controls, output protection and the listening timer work normally.

The scheduler uses the audio clock and queues one second ahead. If a browser
throttles its callbacks longer than that, there can be a silent gap. When the
callback returns, expired events are skipped; a recording still in progress
resumes at the correct offset. Missed gestures are never played in a burst.

## Saving and exporting

The recipe stores pause ranges, alternate membership, variation amounts and a
seed. Reopening or copying a session retains them. Playback and WAV export use
the same deterministic schedule and the same saved recording durations. The WAV
starts at the beginning of the recipe and uses the chosen export duration. An
event crossing that endpoint is shortened and faded.

All selected alternate asset records are included in the export recipe and
credits, even if a short export does not reach one or occasional mode is disabled.
Distinct records retain their distinct source/rights declarations even when
their audio bytes match. Every saved reference must exist, and every export
source must carry permission for private use.

The schedule uses rounded 48 kHz frame boundaries based on asset metadata.
Different browser/native decoders can expose slightly different padding on
compressed recordings: extra content is clipped to the canonical duration, and
shorter decoded content can finish early. This does not shift subsequent events.

The existing decoded-audio budget includes active alternates. Export event files
are written in bounded blocks and share an approximately 8 GiB temporary logical
size limit, including silent gaps. If a very long mix exceeds it, shorten the
export or reduce its occasional layers. Failed or cancelled renders clean up
their temporary event files.
