# Output levels and peak limiting

The **Output** panel shows the final left and right channel levels after layer
mixing, equalization, master volume, and any enabled peak limiter.

## Reading the meters

- **L / R:** the highest sample level in each measurement window, displayed on
  a −60 to 0 dBFS scale. Silence reads −∞.
- **Held peak:** the highest level measured since the last reset or session
  change. The thin marker keeps that peak visible after the sound becomes quiet.
- **Full scale reached:** at least one channel reached 0 dBFS. The indication
  stays visible until **Reset peaks** or a session change.
- **Reduction:** the greatest attenuation applied by the limiter in the recent
  measurement window, expressed as a positive dB value.

Start listening to activate metering. Pause and Stop let the live bars settle
while retaining held peaks. Resetting peaks does not change audio settings or
mark the session as edited. Meter animation does not drive playback timing.

## Using the limiter

Turn on **Peak limiter** to cap sample peaks. **Output ceiling** begins at
−1 dBFS and can be adjusted from −12 to −0.1 dBFS in 0.1 dB steps. The native
slider supports arrow keys, Home, and End. Turning limiting off retains the
chosen ceiling so it can be used again.

The limiter reduces both channels by the same gain to retain stereo balance.
It responds immediately to an excess sample peak and recovers with a fixed
100 ms exponential release. It adds no makeup gain or playback delay. Heavy
reduction can change the character of transients; lower the layer or master
levels when a less processed result sounds better.

This is sample-peak limiting. It does not estimate reconstructed true peaks
or the physical loudness of headphones or speakers. The ceiling controls the
studio's digital samples; hardware listening volume remains separate.

## Saved sessions and exports

Limiter settings are part of the saved session and its immutable export recipe.
Existing sessions open with limiting off. A disabled limiter preserves the
original render path; enabling uses the same processing algorithm in live audio
and the exported 48 kHz stereo PCM16 WAV. PCM16 quantization can round a sample
by half of one PCM16 step.

Live edits keep existing sources and the playback clock in place. Turning off
active attenuation returns to unity over 20 ms. Loading another session resets
the limiter's processing history and meter holds. Original recordings and their
credits remain unchanged.

If the output processor fails, playback stops and reports the error. Reload the
session to create a fresh processor; Stop does not silently bypass the fault.

## Processing details

The browser uses an AudioWorklet after master gain. Limiter settings and scene
resets use the audio control timeline, including offline rendering. The worklet
processes every audio sample and sends at most one unacknowledged meter message,
so a delayed UI cannot accumulate a large message queue. It retains peaks while
the display catches up.

Enabled exports consume the unclipped float mix from the owned FFmpeg process,
apply the shared processor in bounded chunks, and quantize to PCM16. The exact
requested frame count, digest, format, and full-scale measurements are verified
before the export is marked complete. Incomplete or invalid audio and cancelled
renders do not produce a successful export.
