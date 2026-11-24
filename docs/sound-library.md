# Starter sound library

The starter library contains 19 sounds for layering and looping: 16 real
recordings and three prepared Earshot water ambiences.
Whisper generation remains separate from this collection.

## Browse and inspect sounds

Search by name or choose a category, then use the plus/check control to add or
remove a sound from the active mix. The information icon on each tile opens
**Source & permission** in a modal, preserving the complete recording credits
and recorded permissions without expanding the grid. Close it with its close
button, Escape, or a click outside. Keyboard focus returns to the same info
button, and opening credits leaves playback running. Long attribution text
scrolls inside the modal on smaller screens.

Interface icons use the MIT-licensed Tabler set; see
[Third-party notices](../THIRD_PARTY_NOTICES.md).

## Add the sounds

Choose **Add starter sounds** in the app, or run this from the repository root:

```sh
npm run sounds:install
```

Use the same `ASMR_DATA_DIR` as the server, with `ffmpeg` and `ffprobe` available
on `PATH`. Both entry points use the same fixed catalog and verify SHA-256
hashes before preparing audio. Installation can be repeated and preserves
recordings you have already imported. After updating the app, use the same
installer to add new catalog entries; existing asset IDs and saved sessions stay
unchanged. An interrupted installation can resume without downloading or
preparing completed entries again.

## Storage and playback copies

Downloaded source bytes remain unchanged in the private data directory under
`starters/originals/`. The keyboard source ZIP is retained there too.
`starters/attribution/<sha256>.json` records each catalog's credits and processing
changes in an immutable snapshot. Older installations may also contain
`starters/attribution.json`; that historical file is preserved unchanged.
Prepared playback files enter the normal `media/blobs/` store. Audio and private
app data stay outside Git.

The 16 recorded entries select excerpts starting at zero, with the durations
shown below. Their playback copies are converted to **44.1 kHz, 16-bit PCM WAV**,
preserving the source's mono or stereo channels. The three Earshot entries arrive
as prepared WAVs in the same format and enter the media store byte for byte,
without another conversion or gain adjustment. These short files keep decoded
audio memory manageable. Longer recordings imported by the user remain
supported; the starter durations do not set an import-duration limit. The audio
engine applies the adjustable loop crossfade during playback.

For the eight Freesound preview entries, the retained source is the downloaded
**public HQ MP3 preview**, not the creator's original upload. Converting those
previews to WAV does not restore information lost in MP3 encoding.

Two quiet recordings receive a fixed gain in their playback copies: **+10 dB for
makeup brushing** and **+42 dB for slow hand rubbing**. The other recorded entries
retain their source level. These are constant gain changes, with no compression or
loudness normalization; the unchanged downloads remain in `starters/originals/`.
The gain is included in each affected asset's attribution and catalog snapshot.
The separate preparation of the Earshot rain sounds is described below.

## Recording credits and licenses

Rights apply to each sound individually. The following source, creator,
permission, and editor credits are the attribution for the corresponding sound.
For the recorded entries, ASMR Studio's changes are the excerpt selection,
conversion, and the two fixed gain adjustments described above. The Earshot
entries retain their generator and source-model credits separately.

### Ambience from Blanket

These seven OGG files come from [Blanket][blanket] at commit
`2eaca9ba5a1b624adf90b6ccee1008efc46f0273`. Its pinned
[sound-license catalog][blanket-licenses] identifies each recording and editor.
Downloads use this immutable prefix followed by the filename in the table:

```text
https://raw.githubusercontent.com/rafaelmardojai/blanket/2eaca9ba5a1b624adf90b6ccee1008efc46f0273/data/resources/sounds/
```

| Sound | Creator, original source, and upstream editing credit | License | File | Excerpt |
| --- | --- | --- | --- | ---: |
| Rain | **alex36917**, [rain ambience](https://freesound.org/people/alex36917/sounds/524605/). Blanket version edited by **Porrumentzio**. | [CC BY 4.0][by] | `rain.ogg` | 30s |
| Fireplace | **ezwa**, [Fireplace](https://soundbible.com/1543-Fireplace.html). | Public Domain, as declared on the source page | `fireplace.ogg` | 24s |
| Wind | **felix.blume**, [Wind blowing in a field in Texas, USA](https://freesound.org/people/felix.blume/sounds/217506/). Blanket version edited by **Porrumentzio**. | [CC0 1.0][cc0] | `wind.ogg` | 14s |
| Ocean waves | **Luftrum**, [oceanwavescrushing.wav](https://freesound.org/people/Luftrum/sounds/48412/). Blanket version edited by **Porrumentzio**. | [CC BY 4.0][by] | `waves.ogg` | 30s |
| Forest birds | **kvgarlic**, [WoodThrushinMorningShawneeForestMay272012.wav](https://freesound.org/people/kvgarlic/sounds/156826/). Blanket version edited by **Porrumentzio**. | [CC0 1.0][cc0] | `birds.ogg` | 30s |
| Woodland stream | **gluckose**, [stream2.wav](https://freesound.org/people/gluckose/sounds/333987/). | [CC0 1.0][cc0] | `stream.ogg` | 30s |
| Night crickets | **Lisa Redfern**, [Crickets Chirping At Night](https://soundbible.com/2083-Crickets-Chirping-At-Night.html). | Public Domain, as declared on the source page | `summer-night.ogg` | 30s |

The original rain and ocean source pages identify their licenses as CC BY 4.0;
Blanket's catalog labels them CC BY. Both source links and the upstream editing
credits are retained.

### Tactile recordings

| Sound | Creator and original source | License | Downloaded source | Excerpt |
| --- | --- | --- | --- | ---: |
| Mic foam brushing | **salemaudio**, [ASMR Mic Foam Scratching/Brushing](https://freesound.org/people/salemaudio/sounds/803595/). | [CC0 1.0][cc0] | [Public HQ MP3 preview](https://cdn.freesound.org/previews/803/803595_17274093-hq.mp3) | 30s |
| Cardboard tapping | **madamdata**, [tapping on a box - stereo contact mic](https://freesound.org/people/madamdata/sounds/716591/). | [CC0 1.0][cc0] | [Public HQ MP3 preview](https://cdn.freesound.org/previews/716/716591_4967224-hq.mp3) | 30s |
| Fingernail glass taps | **Elias79**, [ASMR fingernail tap sound.mp3](https://freesound.org/people/Elias79/sounds/690082/). | [CC0 1.0][cc0] | [Public HQ MP3 preview](https://cdn.freesound.org/previews/690/690082_14301666-hq.mp3) | 20s |
| Turning book pages | **Mateusz_Chenc**, [Turning pages in a book](https://freesound.org/people/Mateusz_Chenc/sounds/519102/). | [CC0 1.0][cc0] | [Public HQ MP3 preview](https://cdn.freesound.org/previews/519/519102_10756146-hq.mp3) | 6s |
| Keyboard typing | **unicaegames**, [Keyboard Soundpack #1: Typing and Single Keystrokes](https://opengameart.org/content/keyboard-soundpack-1-typing-and-single-keystrokes). | [CC0 1.0][cc0] | [Creator's ZIP archive](https://opengameart.org/sites/default/files/unicae_games_keyboard_soundpack_1_0.zip), member `Human Typing/human_vel-001.wav` | 9s |
| Windscreen rubbing | **Seth_Makes_Sounds**, [Rubbing The Wind Screen of My Microphone](https://freesound.org/people/Seth_Makes_Sounds/sounds/621311/). | [CC0 1.0][cc0] | [Public HQ MP3 preview](https://cdn.freesound.org/previews/621/621311_13228046-hq.mp3) | 30s |
| Makeup brush on skin | **tea333**, [Makeup brush skin.m4a](https://freesound.org/people/tea333/sounds/575858/). | [CC0 1.0][cc0] | [Public HQ MP3 preview](https://cdn.freesound.org/previews/575/575858_12995869-hq.mp3) | 17s; +10 dB |
| Slow fabric petting | **conk0018**, [Fabric petting - slow](https://freesound.org/people/conk0018/sounds/713009/). | [CC0 1.0][cc0] | [Public HQ MP3 preview](https://cdn.freesound.org/previews/713/713009_41750-hq.mp3) | 9s |
| Slow hand rubbing | **LizzBitzz**, [Hands Rubbing_Slow rubs](https://freesound.org/people/LizzBitzz/sounds/766063/). | [CC0 1.0][cc0] | [Public HQ MP3 preview](https://cdn.freesound.org/previews/766/766063_15688689-hq.mp3) | 20s; +42 dB |

The keyboard selection is a human typing recording made with a Cherry KC 1000
and Shure SM7B, postprocessed by its creator with Izotope Neutron 2. The pack's
generated typing sequences are separate assets and are not used here.

### Prepared water ambience from Earshot

These 20-second stereo WAVs were rendered with [Earshot][earshot] at revision
`7a7f7c5c70d4a763a1eca4b3666af7c77e313f97`. Window rain is procedural synthesis;
Rain on wood and Small brook are new renders of models derived from credited
CC0 recordings. Earshot's [output permission][earshot-permission] allows rendered
sounds to be used freely, including commercially. Its MIT code license is
separate from that output permission and the original recordings' CC0 terms.

| Sound | Design and source | Preparation after rendering | Default loop |
| --- | --- | --- | --- |
| Window rain | `rain/window`; procedural synthesis by Earshot contributors | Fixed attenuation of about 7.561 dB | 0–20s, no crossfade |
| Rain on wood | `rain/wood`; model derived from **cocaine**, [Rain On Wood Deck (Extreme Quality)](https://freesound.org/people/cocaine/sounds/611421/), [CC0 1.0][cc0] | Fixed attenuation of about 6.086 dB | 0–20s, 0.02s crossfade |
| Small brook | `stream/brook`; model derived from **Joseph Sardin (BigSoundBank.com)**, [Small Stream](https://bigsoundbank.com/small-stream-s0823.html), [CC0 1.0][cc0] | Original render bytes retained | 0–20s, 0.02s crossfade |

The files contain the complete renders without baked boundary fades or
crossfades. The fixed rain attenuation is already in the downloaded WAVs. No
additional compression, normalization, or gain adjustment happens during their
installation. Audio is distributed as versioned release assets outside Git;
the installer verifies each file's exact size and SHA-256 before importing it.
Neither Python nor Earshot is needed to install or play these sounds.

Adding one of these sounds to a mix, or turning its loop back on, uses the
catalog's prepared loop settings. You can still edit and save the loop normally;
loading a session preserves its saved settings. Updating the starter library
recognizes an already imported, permitted copy with the same verified audio
identity and preserves its asset ID and existing session references.

See [the water sound preparation record](earshot-water-sounds.md) and
[machine-readable provenance](earshot-water-sounds.json) for generation settings,
exact gain changes, checksums, release URLs, and source evidence.

## Finding additional sounds

Free access and permission to redistribute reusable recordings are separate
questions. The starter catalog uses individually verified CC0, CC BY, or public
domain recordings, plus Earshot renders covered by its output permission. It
retains creator, source, permission, and processing details.
Personal imports can use other sources according to the user's own permissions.

The following distinctions were checked against the publishers' terms on
November 17, 2026:

| Source | Fit for ASMR Studio |
| --- | --- |
| [Freesound](https://freesound.org/help/faq/) | Check each recording. CC0 and CC BY allow a reusable catalog, with attribution and change notices for CC BY. The starter catalog avoids NonCommercial and legacy Sampling+ assets. Original-file downloads require login; these entries use public previews. |
| [Pixabay](https://pixabay.com/service/terms/) | Its current Content License permits creative works but prohibits standalone redistribution. Ordinary Pixabay-licensed clips are candidates for personal imports, not the reusable starter pack without additional permission. Trimming or converting a file alone does not establish a new creative work. |
| [Soundpaint Free ASMR](https://soundpaint.com/products/free-asmr) | A registered-user Soundpaint instrument. Its [product license](https://soundpaint.com/policies/terms-of-service) allows finished production but excludes putting its samples into another library or sample playback system without written permission. |
| [Soundsnap](https://www.soundsnap.com/licence) | A subscription license for creative production. Its ordinary license prohibits redistributing sounds as supplied and creating reusable sound expansion packs for apps or plugins. |

These sources remain useful discovery links. None of the restricted libraries
above is included in the starter catalog.

## Application references and acceptance

Blanket's application code is GPL-licensed; this integration uses its separately
licensed recordings and does not copy its application code.
[Moodist][moodist], whose code is MIT-licensed, was considered as an interaction
reference. That reference does not imply that its code was copied or that its
third-party audio shares the MIT license.

Source hashes, audio decoding, and format checks establish technical integrity.
Desktop listening acceptance is complete for the three prepared water sounds,
including their selected levels and continuous loops. Phone background and
screen-off behavior remain separate device-validation work; this sound pack
does not establish those capabilities.

[blanket]: https://github.com/rafaelmardojai/blanket
[blanket-licenses]: https://github.com/rafaelmardojai/blanket/blob/2eaca9ba5a1b624adf90b6ccee1008efc46f0273/SOUNDS_LICENSING.md
[moodist]: https://github.com/remvze/moodist
[cc0]: https://creativecommons.org/publicdomain/zero/1.0/
[by]: https://creativecommons.org/licenses/by/4.0/
[earshot]: https://github.com/Leonxlnx/earshot
[earshot-permission]: https://github.com/Leonxlnx/earshot/blob/7a7f7c5c70d4a763a1eca4b3666af7c77e313f97/README.md#licence
