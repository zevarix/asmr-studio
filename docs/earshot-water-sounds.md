# Prepared water sounds

The `sounds-earshot-water-v1` sound pack adds **Window rain**, **Rain on wood**,
and **Small brook** to ASMR Studio's starter library. Each is a 20-second stereo
WAV at 44.1 kHz with 16-bit PCM samples. The prepared files are release assets;
audio is not committed to the source repository. The app downloads and verifies
these files, so listeners do not need Python, Earshot, or a model download.

Use **Add starter sounds** after updating the app, or run `npm run sounds:install`
with the server's data directory. See [the sound library](sound-library.md) for
installation and storage details.

## Source and permission

Generator: [Earshot](https://github.com/Leonxlnx/earshot), revision
`7a7f7c5c70d4a763a1eca4b3666af7c77e313f97`.
Its [MIT code license][earshot-code-license] and [rendered-output permission][earshot-permission]
are separate: the output statement permits unrestricted use, including commercial
use, without requiring attribution. Source and generator credits are retained
here and in the app's attribution records.

| Sound | Earshot design | Origin |
| --- | --- | --- |
| Window rain | `rain/window` | Procedural synthesis by Earshot contributors; no source recording |
| Rain on wood | `rain/wood` | Recording-derived texture model `deck`, based on **Rain On Wood Deck (Extreme Quality)** by **cocaine**, [Freesound source](https://freesound.org/people/cocaine/sounds/611421/), CC0 1.0 |
| Small brook | `stream/brook` | Recording-derived texture model `brook`, based on **Small Stream** by **Joseph Sardin (BigSoundBank.com)**, [original source](https://bigsoundbank.com/small-stream-s0823.html), CC0 1.0 |

The pinned [texture credits][earshot-credits] and [model index][earshot-index]
identify the source recordings and their CC0 terms. These two generated textures
are new renders from Earshot's models, not direct copies of the source recording
excerpts. Earshot's brook metadata has an upstream discrepancy: its credits name
seconds 23–35, while its index records a start of 18 seconds and a duration of
12 seconds. Both evidence files are retained as links; this pack does not assert
which original excerpt was used to build the model.

## Generation and preparation

All three files used these `earshot.make.make` arguments, with `sound` set to the
design in the table above and `out` set to the destination WAV:

```python
make(
    want="seamless loop", sound=design, out=destination,
    seed=0, dur=20, loop=True, listen=False,
    sr=44100, bits=16, lufs=-28,
    energy=-0.5, bright=-0.3, space=-0.5,
)
```

Earshot's `lufs=-28` argument targets its momentary-maximum measure; it is not a
claim that these files measure −28 integrated LUFS. Generation used the base
sound-making package without optional listening models.

After rendering, Window rain received a constant −7.5609548569773475 dB gain and
Rain on wood a constant −6.0857056079240905 dB gain. Each was written back to
16-bit PCM WAV. Small brook retained the original render bytes. No additional
normalization, compression, excerpt boundary fades, or crossfades were applied
in this preparation step. The complete 20 seconds remain in every file.

The [provenance manifest](earshot-water-sounds.json) records both the original
render hashes and the final distributed hashes. Those distributed hashes define
the exact release artifacts; generation parameters alone do not guarantee
identical floating-point output across different dependency versions or hosts.

## Loop settings

| Sound | Start | End | Playback crossfade |
| --- | ---: | ---: | ---: |
| Window rain | 0s | 20s | 0s |
| Rain on wood | 0s | 20s | 0.02s |
| Small brook | 0s | 20s | 0.02s |

The starter catalog applies these defaults when a sound is added to a mix or its
loop is turned back on. Crossfades are applied by the audio engine rather than
baked into the file. Loop edits remain available and are saved with each session;
updating the catalog does not replace an existing session's loop settings.

Desktop listening acceptance is complete for the three prepared files and their
continuous loops. This does not establish phone background or screen-off
behavior, which remains a separate device-validation task.

## Release files

Release: [Earshot water sounds v1][water-release]. Each WAV is exactly
**3,528,044 bytes** and contains **882,000 stereo frames**.

| File | SHA-256 |
| --- | --- |
| [window-rain.wav][window-download] | `ae9f3dc1fac28f3f41087c41d50506da97d8a1934c89203e2ca684f1f7816035` |
| [rain-on-wood.wav][wood-download] | `5049b51ea3b1b97a2630db181628686ce99a807b7deea1f480b482850ce99227` |
| [small-brook.wav][brook-download] | `69a50dc8dc98dc03904781730e66f0e4f127a852ea38eeb34074b9449a7523b8` |

Installation preserves these bytes without re-encoding or applying the rain
attenuation again. Downloads must match both the exact byte count and SHA-256.
The installer accepts the release URL's single HTTPS redirect only to GitHub's
release-asset host. A previously imported permitted asset with the same verified
audio identity is reused, preserving its ID, source declaration, and saved mix
references.

[earshot-code-license]: https://github.com/Leonxlnx/earshot/blob/7a7f7c5c70d4a763a1eca4b3666af7c77e313f97/LICENSE
[earshot-permission]: https://github.com/Leonxlnx/earshot/blob/7a7f7c5c70d4a763a1eca4b3666af7c77e313f97/README.md#licence
[earshot-credits]: https://github.com/Leonxlnx/earshot/blob/7a7f7c5c70d4a763a1eca4b3666af7c77e313f97/earshot/data/textures/CREDITS.md
[earshot-index]: https://github.com/Leonxlnx/earshot/blob/7a7f7c5c70d4a763a1eca4b3666af7c77e313f97/earshot/data/textures/index.json
[water-release]: https://github.com/zevarix/asmr-studio/releases/tag/sounds-earshot-water-v1
[window-download]: https://github.com/zevarix/asmr-studio/releases/download/sounds-earshot-water-v1/window-rain.wav
[wood-download]: https://github.com/zevarix/asmr-studio/releases/download/sounds-earshot-water-v1/rain-on-wood.wav
[brook-download]: https://github.com/zevarix/asmr-studio/releases/download/sounds-earshot-water-v1/small-brook.wav
