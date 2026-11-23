# Finished mixes

Open **Export mix** below the master volume. Choose a duration in minutes and
press **Export WAV**. If the mix has unsaved changes, **Save & export WAV** saves
them first. A failed or conflicting save leaves the draft in place and does not
start an export.

Rendering runs in the local API, independently of playback. You can keep
listening, adjust the mix, or close the browser. Keep the studio server running
until the file finishes. Reopening the same session shows its saved exports.

## What the file contains

The output is a 48 kHz, stereo, 16-bit PCM WAV. It starts at the beginning of the
saved mix, with the duration selected in the export panel. This duration sets
the export's end even when the saved recipe has a different session duration.

Layer gains, master volume, stereo positions, mute, solo, start times, and
layer/master equalizer settings come from the captured saved revision. Looping recordings repeat using their saved
start, end, and crossfade settings. Play-once recordings end naturally; any
remaining duration is silence. Initial and final layer transitions use the
mixer's short 20 ms fades, shortened for very short clips.

The [equalizer](equalizer.md) uses the same band frequencies and filter definitions
as the live mixer. Bypass retains the saved knob positions while exporting with
those filters neutral. A finite recording's filter decay can continue briefly
after its source ends, up to the requested export duration.

Per-layer [stereo movement](stereo-movement.md) also comes from the captured
revision. Sway starts at the layer's center at its saved start time and continues
across loop repetitions and any finite EQ decay. Exports render this fresh
trajectory; they do not reproduce a history of live control changes or pauses.

An enabled [listening timer](listening-timer.md) contributes its saved fade-in
and fade-out lengths. They apply at the beginning and end of the chosen export
duration, independently of the saved listening deadline. Their combined length
must fit the actual output duration after rounding to complete audio frames.
An incompatible choice is rejected before an export job is created. Off retains
the timer settings in the recipe and leaves these long fades inactive.

The render preserves the chosen levels and does not normalize the mix. If the
saved session enables the [peak limiter](output-levels.md), the export applies
the same stereo-linked limiting after master EQ and volume; otherwise limiting
remains off. Long listening fades follow limiting, and the completed file reports
its measured final peak. A full-scale warning means some
output samples reached the PCM limit. Lower the master volume and render again
if the mix sounds distorted. Numeric checks establish file and signal properties;
headphone listening is still needed to judge textures, loop seams, and balance.

## Exporting a saved transition

A transition arrangement must contain both captured mixes before it can be
exported. Its WAV starts both mixes at their own position zero on the shared
playhead. Manual mode uses the saved crossfader position throughout the file.
Timed mode holds the saved starting position until its saved start time, moves
to B over the chosen duration, and then stays at B. Live slider movements,
pauses, and earlier listening are not a recorded performance in the recipe.

Each side keeps its own layers, solo scope, layer and master EQ, master volume,
peak limiter, and listening timer. A captured timer retains its original
deadline and fade lengths; the export duration does not move that deadline.
An ended side contributes silence. A shorter export crops continuing playback
without adding a new ending fade. The ordinary mix behavior described above
continues to use the selected export endpoint for its long listening fades.

The crossfader uses linear gains: A is multiplied by one minus the blend and B
by the blend. Shared recordings remain two independently processed sides.
There is no hidden normalization or removal of matching layers. Their sum goes
through the arrangement master volume and final selected peak limiter; new
arrangements begin with that final limiter enabled at -1 dBFS.

Both captured source identities and saved revisions appear in **Recipe &
credits**, along with every recording declaration from both sides. This
includes the inaudible side, muted layers, and inactive occasional alternatives.
Different recording declarations with identical audio bytes retain separate
credits. Later source edits do not change a capture, a saved copy of an
arrangement, or an accepted export. Every source still requires permission for
private use and available, matching managed audio bytes.

**Download WAV** saves the listening file. **Recipe & credits** saves the exact
scene revision, export duration, and original asset metadata, including each
recording's source and usage declaration. Later edits create a different export;
they never rewrite a finished file. Exporting does not change source permissions.

## Sharing a mix

Download **Recipe & credits** with the WAV. Include the attribution, license
links, and change notices required by the recordings when you share the result.
The starter rain and ocean recordings use CC BY 4.0; their original creators and
upstream edits are listed in [the sound library](sound-library.md).

For imported recordings, verify that your permission covers the intended use.
The export check uses the imported private-use declaration; it does not verify
redistribution rights. ASMR Studio's MIT code license does not relicense audio.

## Progress, cancellation, and restart

One render runs at a time, with additional requests queued. **Cancel export**
cancels that request and does not alter the live mix or saved scene. An incomplete
file is never offered for download.

If the browser loses the submission response, **Check export request** looks up
the same request identity and, if necessary, resubmits that identical request.
It does not start a second job for the same request. The pending identity is
retained in browser storage when available.

Completed exports survive a server restart. Unfinished requests are marked
interrupted after an unexpected stop; they do not automatically resume or create
another export. The saved mix remains available so a new export can be started
explicitly.

## Implementation

`POST /api/exports` accepts a request UUID, saved scene ID, expected revision,
and finite duration. The API verifies the current revision and captures the
scene and referenced asset records before acknowledging the job. Reusing a
request UUID with the same input returns the same job; changing its input is a
conflict. Client-supplied filenames, download URLs, FFmpeg options, and storage
paths are not accepted.

The local export store retains the recipe and job status in the private data
directory. Source bytes are copied through managed asset streams and verified
against their recorded SHA-256 digests before decoding. Temporary inputs and
incomplete output belong to the job; the original sound library is unchanged.

Job metadata and finished WAV files are flushed before atomic replacement.
On POSIX systems, the containing directories are also flushed. Windows does not
support that directory-flush operation through Node, so it retains file flushing
and atomic replacement without claiming the same directory-entry durability
after sudden power loss. Restart recovery still validates stored jobs and marks
unfinished work as interrupted instead of repeating it.

FFmpeg decodes the source recordings and renders the final mix. Loop preparation
shares the browser engine's sample overlap routine. A crossfaded loop plays its
intro once, then repeats the complete prepared period. The renderer trims that
period to sample zero before looping and joins it to the intro with a sample-count
delay. This keeps partial input packets from shortening later repetitions and
avoids timestamp rounding at the join. The decoded-audio budget reserves the
repeat cache, both split-mixer queues, FIFO growth, and processing blocks.
It estimates audio-buffer allocations, not the total FFmpeg process memory.
An actively moving layer reserves two additional 64 KiB processing blocks for
the panner's double-planar input and output. Absent or disabled movement, zero
width, and edge-centered layers retain the static pan path.
Limiting or active long fades use a bounded Float32 output stream and the shared
output processor before PCM16 conversion. Its budget includes a 4 KiB gain block;
absent, disabled, and zero long fades preserve the existing native PCM16 path
when limiting is off.

Transitions build two independent scene graphs in the same owned FFmpeg process
and join their stereo outputs into an explicitly mapped four-channel Float32
stream. Bounded blocks apply each side's limiter and listening envelope before
the shared crossfade curve, arrangement master volume, and final limiter. Only
the combined stereo result is quantized to PCM16. No intermediate PCM16 mix or
full-duration floating-point side file is created. Decoded recordings can be
shared, while audible layer graphs and side processing states remain separate.
Both sides share one decoded/preparation budget and one logical occasional-spool
allowance, including silent holes; the four-channel stream, processing buffers,
and native graph buffers are charged to the same job allowance.
The allowance includes the initial capacities in [FFmpeg's loop filter](https://github.com/FFmpeg/FFmpeg/blob/n7.1.5/libavfilter/f_loop.c),
the queues in its [mixer](https://github.com/FFmpeg/FFmpeg/blob/n7.1.5/libavfilter/af_amix.c),
and up to three times queued samples for old-plus-new storage during
[FIFO growth](https://github.com/FFmpeg/FFmpeg/blob/n7.1.5/libavutil/audio_fifo.c).
The repeat-queue allowance uses the 4096-frame packet size of the prepared
48 kHz raw input, derived from [PCM packet sizing](https://github.com/FFmpeg/FFmpeg/blob/n7.1.5/libavformat/pcm.c).

The render graph implements
the [Web Audio stereo panning equations](https://www.w3.org/TR/webaudio/#stereopanner-algorithm),
explicit layer and master gains, finite timing, and non-normalized summation.
Layer EQ follows its playback envelope and precedes layer gain and pan. Master
EQ follows summation and precedes master gain. Shared Web Audio coefficients
drive FFmpeg's generic biquads, with double precision filter state and float32
boundaries between bands. Missing, flat, and bypassed EQ omit the filter stages.
Moving pan uses layer-local sample time after loop assembly and before the saved
start delay. Its center, radius, and frequency share the browser's Float32
parameter values, with a Float32 output boundary after panning.
Native browser fixtures compare the delivered WAV against an `OfflineAudioContext`
render using the same scene and original PCM recordings. They check gain, mono
and stereo pan, mute and solo, loop intro/overlap, delayed starts, fades, and
silence padding, combined layer/master EQ, bypass, and finite filter tails.
Compressed-audio decoder and resampler differences mean exports
are not promised to be bit-identical to browser playback.

The renderer verifies the completed WAV's format, exact frame count, digest,
and decoded signal levels before publishing it as ready. It uses bounded decoded
audio memory and invokes FFmpeg with validated arguments and internal paths.

The maximum duration derives from standard RIFF WAV's 4 GiB size limit at
48,000 stereo 16-bit frames per second, with space reserved for the header
(about 6 hours 12 minutes). This keeps output in the broadly supported ordinary
WAV format. Longer files would need another format or RF64; see
[FFmpeg's WAV documentation](https://ffmpeg.org/ffmpeg-formats.html#wav).

Endpoints:

| Method and path | Result |
| --- | --- |
| `POST /api/exports` | Accept or recover an idempotent request. |
| `GET /api/exports` | List persisted job states. |
| `GET /api/exports/:id` | Read one job's current state. |
| `POST /api/exports/:id/cancel` | Cancel a queued or running job. |
| `GET /api/exports/:id/content` | Download only a verified completed WAV. |
| `GET /api/exports/:id/recipe` | Download the captured recipe and source credits. |

Exports use the same loopback Host and Origin policy as the rest of the local
API. No remote storage, public hosting, or assistant control is involved.

## Captured revision boundary

`POST /api/scenes/:id/capture` accepts exactly `{expectedRevision}` and returns
an immutable capture of an ordinary saved mix and all its source declarations.
The server checks the source revision and reads the scene and asset records in
one SQLite transaction. A stale revision returns the existing revision-conflict
response, and another transition cannot be captured as a side.

Database version 2 adds the private `captured_mixes` table without rewriting
ordinary scene documents. An arrangement's create/save/copy operation checks
each submitted capture identity and its complete canonical document against
that table. Caller-supplied changes to a captured scene, recording metadata,
rights, or attribution are rejected. Captures remain valid when the source mix
advances to a later revision. Arrangements use their own scene IDs and the
existing revision-conflict protocol; an existing ordinary mix cannot be
converted into an arrangement under the same identity.
