# Equalizer

**Master equalizer** shapes the whole mix. Open **Equalizer** inside any active
sound layer to adjust that recording separately, including recorded narration.
The layer's summary shows **Flat**, **Adjusted**, or **Bypassed** so its state is
visible while the controls are closed.

| Knob | What it changes | Example |
| --- | --- | --- |
| Bass · Warmth | Low frequencies | Reduce rumble in a wind recording, or give distant rain more weight. |
| Mid · Detail | The middle of the sound | Bring out a tactile texture, or soften a prominent midrange tone. |
| Treble · Air | High frequencies | Soften bright rain or emphasize fine brushing detail. |

All three knobs start at **0 dB**, which leaves the tone unchanged. Each offers
up to 12 dB of boost or reduction in 0.5 dB steps. Raising a band also raises the
signal level in that part of the sound; lower the layer or master volume if the
combined mix becomes too loud or distorted. The mixer does not normalize the
signal. Enable the optional [Peak limiter](output-levels.md) to cap sample peaks;
ordinary sessions start with limiting off.

## Using the knobs

The dial's marker points to the current setting. The lit arc starts at the top
(0 dB): left shows a reduction, and right shows a boost. At 0 dB the arc is unlit.

- Drag around a knob clockwise to increase a band, or counterclockwise to decrease
  it. Clicking a knob does not jump to a new value. The knob stops at either limit
  and responds immediately when you turn back.
- Focus a knob with Tab and use the arrow keys to adjust by 0.5 dB. Home and End
  select the minimum and maximum. The current value is available to screen readers.
- Double-click a knob to return that band to 0 dB. Scrolling over it does not
  change the setting.
- **Bypass** temporarily makes that equalizer neutral while retaining all three
  knob positions. Press it again to hear those settings. The knobs are disabled
  while bypassed; Reset remains available.
- **Reset** returns all three bands to 0 dB and turns bypass off.

Master bypass affects only the master equalizer. A layer's equalizer remains
active until you bypass or reset that layer too. Adjustments smooth over 20 ms
and do not restart playing loops or reset the playback clock.

## Saving and exporting

EQ changes are ordinary session edits. **Save session** stores both the master
settings and each layer's settings, including bypass. Reopening the session
restores those values. **Save a copy** includes them in the copied recipe.

Export uses the settings from the captured saved revision. Later knob changes
do not alter a file already rendering. The downloaded recipe includes the same
settings, and the WAV applies them in the same order as playback. See
[finished mixes](exports.md) for export behavior and level checks.

Sessions created before the equalizer remain valid and open with neutral EQ.
No migration or rewrite of existing recipes is required. Once a recipe contains
EQ settings, it requires a studio version that understands those fields.

## Filter definitions

| Band | Filter | Frequency | Q |
| --- | --- | --- | --- |
| Bass | Low shelf | 200 Hz | Web Audio's fixed shelf slope |
| Mid | Peaking | 1,000 Hz | √½, approximately 0.7071 |
| Treble | High shelf | 4,000 Hz | Web Audio's fixed shelf slope |

The signal passes through the playback envelope, layer EQ, layer gain, stereo
pan, summation, master EQ, and master gain, in that order. The optional peak
limiter and listening-timer envelope follow master gain, before final metering.
Stereo channels remain independent through the EQ stages. Both playback and
export share the definitions in `packages/audio-engine/src/equalizer.ts`;
export coefficients follow the
[Web Audio biquad equations](https://www.w3.org/TR/webaudio/#filters-characteristics).

Native-browser fixtures compare exported PCM against `OfflineAudioContext`
output, including combined EQ, bypass, and the decay after a finite source ends.
These are signal checks; choosing a pleasing balance still benefits from listening.
