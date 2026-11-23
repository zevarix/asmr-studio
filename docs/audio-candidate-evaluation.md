# Audio candidate evaluation

This evaluation explores [optional audio tools](https://github.com/zevarix/asmr-studio/issues/6)
after the six core mixer additions. Its standalone probes and recorded metrics
are included under [tools/audio-candidates](../tools/audio-candidates).
**No candidate is implemented or accepted for listening yet.** The experiments
leave saved sessions and source recordings unchanged.

## Recommendation and remaining decision

The smaller next implementation candidate is an optional per-layer **Low cut**,
initially off, with 40 Hz as the first enabled setting. It removes deep frequency
content without changing recording timing. That is useful only when the removed
sound is unwanted: brushing can depend on its low-frequency body. Listening must
decide whether this helps the selected recordings before a focused feature issue
is opened.

Linked speed and pitch is also worth auditioning. A direct browser
`playbackRate` control, paired with FFmpeg resampling for export, did not meet the
studio's existing comparison limits in this experiment. It needs a more deliberate
shared resampling design before implementation.

Subtle room/reverb was not auditioned in this pass. It remains a separate
candidate requiring dry defaults and a design for tails, wet/dry balance, latency,
and export. Generated whisper remains deferred.

## Listen to the actual recordings

The [generator](../tools/audio-candidates/make-auditions.py) produces two stereo
48 kHz PCM16 comparisons and eight individual clips. Source declarations and
download URLs are in [sources.json](../tools/audio-candidates/sources.json).
Both Freesound pages identified the selected previews as CC0 when checked on
2026-11-18:

- [Mic foam brushing by salemaudio](https://freesound.org/people/salemaudio/sounds/803595/):
  source seconds 6–12, common gain 0 dB.
- [Cardboard tapping by madamdata](https://freesound.org/people/madamdata/sounds/716591/):
  source seconds 0–6, common gain +6 dB.

These are public MP3 previews, not the creators' original WAVs. The unchanged
downloaded previews are included in the listening bundle with their SHA-256
hashes. Each comparison's “Original” means the decoded selected excerpt with
the same gain and edge fades as its alternatives. No normalization, compressor,
limiter, or compensating boost is used. Each clip has a 20 ms outer-edge fade
to avoid an abrupt cut-in/out. The low-cut filter is warmed from the beginning
of the recording before taking the excerpt.

| Speed audition start | Recording | Setting |
| --- | --- | --- |
| 0:00.25 | Mic foam brushing | Original |
| 0:06.75 | Mic foam brushing | 0.85× speed, linked pitch |
| 0:14.56 | Cardboard tapping | Original |
| 0:21.06 | Cardboard tapping | 0.85× speed, linked pitch |

The speed comparison lasts 28.368 seconds. Six source seconds become about
7.059 seconds at 0.85×; pitch drops by about 2.81 semitones. This is an audition
rendered with FFmpeg, not a claim that native browser speed changes match it.

| Low-cut audition start | Recording | Setting |
| --- | --- | --- |
| 0:00.25 | Mic foam brushing | Original |
| 0:06.75 | Mic foam brushing | 40 Hz low cut |
| 0:13.25 | Mic foam brushing | 80 Hz low cut |
| 0:20.00 | Cardboard tapping | Original |
| 0:26.50 | Cardboard tapping | 40 Hz low cut |
| 0:33.00 | Cardboard tapping | 80 Hz low cut |

The low-cut comparison lasts 39.25 seconds. Each condition lasts six seconds.
Ask whether the filtered brush is clearer or loses desirable body, and whether
slower tapping feels more useful than its original pace. “Original is best” is a
valid result. Signal measurements cannot answer that preference.

## What the measurements establish

The [source analysis](../tools/audio-candidates/source-analysis.json) covers the
first 30 seconds of each preview, which is a larger interval than the auditions.
It uses 48 kHz stereo decoding, a channel-averaged Welch spectrum, a 65,536-sample
Hann window, 32,768-sample overlap, and constant detrending. Filter comparisons
use double arithmetic and the Web Audio high-pass coefficients with float32 Q.

| Recording | Spectral power below 20 Hz | Below 80 Hz | RMS change at 40 Hz | RMS change at 80 Hz |
| --- | --- | --- | --- | --- |
| Mic foam brushing | 82.55% | 98.29% | −12.16 dB | −16.80 dB |
| Cardboard tapping | 0.0019% | 8.51% | −0.08 dB | −0.71 dB |

The brushing preview contains substantial very deep energy. A large RMS decrease
there does not establish an equally large audible improvement. Equalizing RMS
after filtering would add a large boost and obscure what the filter removed.
The audition therefore keeps the gain identical. At 40 Hz, the measured brush
power in the 60–200 Hz band falls by 0.27 dB; at 80 Hz it falls by 2.44 dB.
That is a reason to try the gentler starting point, not listening acceptance.

## Native browser and export feasibility

The standalone probes use three deterministic stereo fixtures: seeded broadband
content, impulses, and mixed tones. Every case compares every output sample;
the limits remain **maximum 3 and RMS 0.75 PCM16 steps**. There is no alignment,
gain normalization, cropping, or tolerance relaxation. The reported interior
window is diagnostic only and never determines a passing result.

The environment was Windows, Node 22.23.3, Chromium 159.0.8154.6, and FFmpeg
9.0.2. The sample rate was 48 kHz. The probes use the project's Playwright
dependency and deterministic generated fixtures. These are primitive feasibility
observations, not a full application test or a Safari/WebKit result.

| Observation | Identity | High pass, 40/80 Hz | Speed, 0.85×/1.15× |
| --- | --- | --- | --- |
| V1: native source ends after two seconds | 3/3 exact | 2/6 within limits | 0/6 within limits |
| V2: same explicit trailing stereo silence in both filter inputs | 3/3 exact | 6/6 within limits | 0/6 within limits |

In V1, all high-pass active interiors agreed within one PCM16 step. Four cases
diverged at the exact source-end frame: FFmpeg had explicit silence entering its
filter for the final quarter-second, while the native source had ended. V2
extends only the native high-pass input with the same stereo zeros. The entire
output remains in the comparison. V2's worst filter errors were **0.9981 maximum
and 0.3100 RMS steps**. The first observation is retained, not replaced.

This establishes agreement for the padded filter topology. It does not prove
the cause inside Chromium, establish a bug in the current application's finite
source envelopes, or settle how a future effect should manage every tail. A
production feature still needs finite-source, occasional-event, loop, pause/
resume, and captured-transition endpoint coverage.

Both runs give identical speed results. Worst errors are **7,183.98 maximum and
1,022.00 RMS steps**. Interior differences persist, so the source-end adjustment
does not solve resampling. Web Audio allows the user agent to choose interpolation
for buffer playback; FFmpeg's resampler is a separate implementation.

The [full metrics](../tools/audio-candidates/dsp-results.json) retain both runs,
parameters, source hashes, runtime versions, full-output results, and diagnostic
windows. Scripts are [V1](../tools/audio-candidates/dsp-feasibility.mjs) and
[V2](../tools/audio-candidates/dsp-feasibility-v2.mjs). Both runs closed their
isolated browser and left zero owned FFmpeg children.

## Provisional low-cut design

This is a bounded proposal for listening feedback, not a product selection.

| Concern | Proposed behavior |
| --- | --- |
| Placement | Per-layer Low cut section beside the existing tone controls. |
| Controls | Off/on, cutoff from 20–160 Hz in 5 Hz steps, and Reset. No resonance control. |
| Default | Absent or off is the unchanged path. First enabled cutoff is 40 Hz. |
| Bypass/reset | Off restores the unfiltered path while retaining the cutoff. Reset returns to off/40 Hz. No new global undo system is implied. |
| Filter | Fixed two-pole Butterworth high pass, 12 dB/octave, no automatic makeup gain. |
| Persistence | Optional per-layer recipe settings; save/copy/reopen and captured mix sides preserve them. Originals and credits remain unchanged. |
| Timing | Loop marks, playhead, occasional pauses, timers, and transition times remain unchanged. |
| Graph | Source/event envelope → low cut → layer EQ → layer gain/pan → existing master processing. |
| Export | Use the same validated coefficients and ordering; include low-cut-only layers in required silence padding and processing budgets. |
| Live editing | Apply controls without a click or unintended transport restart; define and test the short parameter/bypass transition. |

The existing shared EQ/FFmpeg biquad path provides the needed building blocks;
no new runtime dependency is proposed. Web Audio high-pass Q is expressed in
**dB**, unlike peaking EQ's linear Q. A Butterworth value is approximately
−3.0103 dB, rounded to the native AudioParam's float32 representation before
coefficient generation. Reusing a linear-Q helper unchanged would be incorrect.

For occasional sounds, the processing state must be defined across events and
their gaps, not accidentally reset for each gesture. Full-engine tests must
exercise a low-cut-only layer as well as its combinations with EQ, movement,
timers, limiting, loops, and captured mix transitions. Source-end handling must
be explicit in both playback and export, including 44.1 and 48 kHz contexts.
The isolated experiment does not satisfy that implementation gate.

## If speed becomes the preferred feature

Start with clearly labeled **linked speed and pitch**, default 1×. Preserve
loop marks in original-source seconds; audible content length scales by the
rate. Layer starts, movement cycles, timers, transition duration, and occasional
pauses remain in listening seconds. An occasional pause follows the newly
scaled event end. Live rate edits need a source-time anchor so changing rate
does not jump the cursor.

One possible architecture is a canonical derived recording keyed by source hash,
rate, and algorithm version. Browser and export would consume the same prepared
frames at 1×; loops would use consistently mapped bounds. Preparation would be
transactional, counted in memory/render budgets, and leave original recordings
and credits intact. That approach still needs browser-rate and loop-seam proof.
It is a larger change than connecting a slider to `playbackRate`.

No time-stretch library is selected, and pitch preservation is outside this
proposal. Any later external dependency needs a fresh platform, license,
maintenance, and size assessment.

## Reproduction

For the listening files, install no app feature. Use Python 3.11+ and an existing
FFmpeg executable. Download the two previews named in `sources.json` into a
source directory; the script checks their hashes before creating output.

```sh
python3 tools/audio-candidates/make-auditions.py \
  --source-dir /absolute/path/to/previews \
  --output-dir /absolute/path/to/new-auditions
```

The output includes a simple `index.html` listening page, original previews,
individual clips, both comparisons, processing metadata, hashes, and a copy of
the generator. No source files are edited. Exact encoded output can vary across
FFmpeg versions; the manifest records the generating version. The committed
tools have no new package or lockfile dependencies. The separate spectral
analysis used existing NumPy 2.3.5 and SciPy 1.17.0, recorded in its result file.

For the native probes, use a checkout with its existing Playwright dependency
and browser installed, Node, and FFmpeg. Each output directory must be new.
Set `PLAYWRIGHT_BROWSERS_PATH` only if the existing browser cache requires it.

```sh
node tools/audio-candidates/dsp-feasibility.mjs REPO NEW_OUTPUT_V1 FFMPEG
node tools/audio-candidates/dsp-feasibility-v2.mjs REPO NEW_OUTPUT_V2 FFMPEG
```

The scripts create isolated headless browser contexts and never start the app.
A completed experiment can contain cases outside the comparison limits; read
the individual results and summary, not just the process exit status.

## Primary references

- [Web Audio filter characteristics and high-pass coefficients](https://www.w3.org/TR/webaudio-1.1/#filters-characteristics)
- [Web Audio playback and interpolation](https://www.w3.org/TR/webaudio-1.1/#playback-AudioBuffer-contents)
- [FFmpeg `asetrate`](https://ffmpeg.org/ffmpeg-filters.html#asetrate)
- Source-specific credits, preview URLs, and [CC0](https://creativecommons.org/publicdomain/zero/1.0/)
  declarations are in `sources.json` and the generated bundle.
