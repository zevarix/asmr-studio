# Audio tools roadmap

These tools build on the sound library, saved mixes, looping, WAV export, and
master/layer equalizers. The table records their implementation order; all six
are available in the current app. Issues track acceptance and follow-up work.
Whisper generation remains deferred.

| Order | Addition | Listening goal |
| --- | --- | --- |
| 1 | [Output meters and optional peak limiter](output-levels.md) | See combined levels and tame excess peaks. |
| 2 | [Gentle stereo movement](stereo-movement.md) | Let selected textures sway while ambience stays steady. |
| 3 | [Listening timer and long fades](listening-timer.md) | Give a session a gradual beginning and ending. |
| 4 | [Visual loop editor](loop-editor.md) | Find, adjust, and audition a useful repeating section. |
| 5 | [Occasional sounds and natural variation](occasional-sounds.md) | Space out gestures and make repetition less mechanical. |
| 6 | [Transitions between saved mixes](mix-transitions.md) | Move between two rooms with a manual or timed crossfade. |

Each addition includes its controls, validated recipe settings, save/copy/reopen,
and matching finite export behavior. Existing recipes retain their sound when a
new setting is absent or disabled. The audio clock owns playback timing; UI
animation does not schedule audio. Original recordings and their credits remain
intact. Signal checks establish timing and numeric behavior; listening establishes
whether an effect sounds useful.

## First addition: output levels

See [the design notes](output-levels-plan.md) and
[the user guide](output-levels.md).

The panel has left/right output meters, held peak values, a full-scale
indicator, Reset peaks, a Peak limiter toggle, an output ceiling, and a gain
reduction readout. Meter updates are transient and never mark a session dirty.
The panel fits the existing charcoal/sage mixer and remains usable at 320 px.

The implementation choice is a **sample-peak limiter**, stereo-linked with
immediate attenuation and a fixed 100 ms exponential release. It has no
lookahead, added latency, makeup gain, or extra audio tail. This first version
can alter transients when it works hard. It does not measure reconstructed
true peaks or headphone sound pressure. The visible gain reduction helps the
listener decide whether to lower the mix instead.

New and old ordinary mixes start with limiting off. Enabling begins at a
−1 dBFS ceiling; the control spans −12 to −0.1 dBFS in 0.1 dB steps. Turning it
off retains the ceiling setting. Browser and export use the same processing
code after master EQ and volume. An unavailable processor must never silently
ignore enabled limiting.

## Additional tools

**Stereo movement:** Off/Sway per layer, with width and cycle time around the
existing stereo position. The initial enabled values are 30% width and a
30-second cycle. The [design notes](stereo-movement-plan.md) define phase,
pause/resume, live edits, and export trajectory. This is stereo panning;
it is not head-tracked 3D audio.

**Timer/fades:** Off by default, with initial values of 45 minutes, a 3-minute
final fade, and zero fade-in. Pause freezes playback elapsed time. Numeric
changes apply together, and active fades must fit the selected duration.
The chosen export duration remains the render endpoint. The long envelope runs
after limiting and before final metering; existing 20 ms source envelopes remain
separate. See [using the timer](listening-timer.md) and its
[design notes](listening-timer-plan.md). Phone screen-off behavior still
needs device checks.

**Loop editor:** A waveform, start/end handles, shaded overlap, precise numeric
entry, and Preview join over the current loop engine. Waveform failure must
leave numeric editing usable. Audition the actual prepared seam. The implemented
editor uses a native SVG without a separate waveform dependency.

**Occasional sounds:** Choose Standard or Occasionally per layer. Whole recordings
play with 4–12 second starting pauses and optional alternates; extra variation
starts at zero. A saved seed reproduces the same balanced shuffled sequence.
Pauses follow each event's end, and late callbacks skip expired events. All saved
alternate records and credits are captured for export. See [occasional sounds](occasional-sounds.md)
and its [design notes](occasional-sounds-plan.md).

**Mix transitions:** Choose two captured saved revisions in a distinct
arrangement, then use the manual A/B crossfader or a timed move to B (initially
30 seconds). The linear weights share one playhead from source position zero;
a later-selected mix joins that position. Loading B preserves A on failure.
Each captured mix retains its processing and timer before the arrangement's
combined limiter and meters. Copies and exports retain both frozen revisions.
See [mix transitions](mix-transitions.md) and the
[design notes](mix-transitions-plan.md) for transport, gain, and export
semantics. Source sessions remain independently editable.

Playback speed, reversible rumble removal/cleanup, and restrained room/reverb
are [later candidates](https://github.com/zevarix/asmr-studio/issues/6). Select each from a concrete listening need and give it
its own bounded design when it is ready to build. The first
[candidate evaluation](audio-candidate-evaluation.md) includes reproducible
speed/low-cut auditions, native/export feasibility results, and a provisional
low-cut design; listening acceptance remains open.

The values above are the initial settings. Issues track current acceptance
and follow-up work.
