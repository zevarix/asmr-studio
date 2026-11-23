# Editing a loop

Open **Loop details** on a sound in the active mix. Its waveform shows the
recording, the selected region, and shaded crossfade areas at both edges.

- Move the **Start** and **End** handles to choose a repeated section. You can
  focus either handle and use the arrow keys to move by one audio sample.
- Use **Start**, **End**, and **Crossfade** for precise times in seconds. Moving
  a handle keeps the loop valid and reduces an oversized crossfade to fit.
  Numeric entry explains invalid combinations without changing them silently.
- Pause the mix and choose **Preview join** to hear two seconds around the
  repeated section's join. The preview uses the draft at a fixed, quiet level;
  it does not include the layer's EQ, movement, or the master effects.
- Choose **Apply loop** to use those values on this layer. You can apply while
  the mix plays; the other sources and playback clock keep going.
- Choose **Save session** when you want to keep the applied loop for later.
  Saving a copy and WAV export also use the applied values.

Previewing does not change the session. Changing the draft, closing the editor,
starting playback, or previewing another sound stops the previous audition.
Closing Loop details keeps the numeric draft until the layer or session is
replaced; it does not apply or save it. Only one waveform editor opens at a time.

The audition uses the same crossfade and repeated samples as the mixer and WAV
renderer. It plays the final second before the repeat point and the following
second. A longer crossfade is therefore heard only in part; a very short loop
may repeat several times. Brief fades at the excerpt's outer edges avoid an
abrupt start and ending without changing the central join. The waveform never
normalizes or modifies the original recording.

If the waveform is unavailable, the number fields and Apply loop remain usable.
When decoding succeeds but drawing fails, Preview join remains available too.
Very large recordings can exceed the editor's bounded decoding allowance; if
the mixer has already loaded the sound, the editor can reuse its decoded audio.
The waveform cache stores compact peak data, not another collection of recordings.

An attractive waveform or a low-amplitude boundary does not guarantee a pleasing
loop. Listen to representative brush, fabric, and tapping sections when choosing
your final join.
