import type { Loop } from '@asmr-studio/contracts';

/** Fixed, attributed sounds. Audio stays in private application storage. */
export interface StarterSound {
  id:string;
  title:string;
  category:'ambience'|'tactile';
  description:string;
  filename:string;
  downloadUrl:string;
  bytes:number;
  sha256:string;
  durationSeconds:number;
  sampleRate:number;
  channels:1|2;
  creator:string;
  creatorUrl:string;
  sourceUrl:string;
  license:'CC0-1.0'|'CC-BY-4.0'|'Public Domain'|'Earshot output permission';
  licenseUrl:string;
  licenseEvidenceUrl:string;
  upstreamLicenseEvidenceUrl?:string;
  upstreamProject?:string;
  upstreamRevision?:string;
  upstreamEditor?:string|null;
  recordingKind:'real-recording'|'procedural-synthesis'|'recording-reconstruction';
  sourceForm:string;
  attribution:string;
  archiveMember?:string;
  archiveBytes?:number;
  archiveSha256?:string;
  gainDb?:number;
  /** Already prepared PCM16 WAVs are installed without changing any bytes. */
  preparation?:'preserve-wav';
  preparationNotes?:string;
  /** Applied only when adding a layer or explicitly enabling looping. */
  preferredLoop?:Loop;
  excerpt:{startSeconds:number;durationSeconds:number};
}

const earshotRevision='7a7f7c5c70d4a763a1eca4b3666af7c77e313f97';
const earshotReadme=`https://github.com/Leonxlnx/earshot/blob/${earshotRevision}/README.md`;
const earshotCredits=`https://github.com/Leonxlnx/earshot/blob/${earshotRevision}/earshot/data/textures/CREDITS.md`;
const earshotParameters='Generated with seed 0, duration 20 seconds, loop=true, 44.1 kHz / 16-bit output, lufs=-28 (momentary maximum), energy=-0.5, bright=-0.3, space=-0.5.';

export const starterCatalog:readonly StarterSound[] = [
  {
    "id": "rain",
    "title": "Rain",
    "category": "ambience",
    "description": "Real light-to-medium rain recording; upstream source mentions distant thunder and train sound near its end.",
    "filename": "rain.ogg",
    "downloadUrl": "https://raw.githubusercontent.com/rafaelmardojai/blanket/2eaca9ba5a1b624adf90b6ccee1008efc46f0273/data/resources/sounds/rain.ogg",
    "bytes": 3133874,
    "sha256": "b84c1daf259a24283be40b7663656d17676df4eb60c1e0332820570db891848a",
    "durationSeconds": 124.577778,
    "sampleRate": 44100,
    "channels": 2,
    "creator": "alex36917",
    "creatorUrl": "https://freesound.org/people/alex36917/",
    "sourceUrl": "https://freesound.org/people/alex36917/sounds/524605/",
    "license": "CC-BY-4.0",
    "licenseUrl": "https://creativecommons.org/licenses/by/4.0/",
    "licenseEvidenceUrl": "https://freesound.org/people/alex36917/sounds/524605/",
    "upstreamLicenseEvidenceUrl": "https://raw.githubusercontent.com/rafaelmardojai/blanket/2eaca9ba5a1b624adf90b6ccee1008efc46f0273/SOUNDS_LICENSING.md",
    "upstreamProject": "Blanket",
    "upstreamRevision": "2eaca9ba5a1b624adf90b6ccee1008efc46f0273",
    "upstreamEditor": "Porrumentzio",
    "recordingKind": "real-recording",
    "sourceForm": "Blanket OGG distribution",
    "attribution": "Rain by alex36917 (https://freesound.org/people/alex36917/sounds/524605/), CC-BY-4.0 (https://creativecommons.org/licenses/by/4.0/). Blanket version edited by Porrumentzio.",
    "excerpt": {
      "startSeconds": 0,
      "durationSeconds": 30
    }
  },
  {
    "id": "fireplace",
    "title": "Fireplace",
    "category": "ambience",
    "description": "Real fireplace crackle and sizzle.",
    "filename": "fireplace.ogg",
    "downloadUrl": "https://raw.githubusercontent.com/rafaelmardojai/blanket/2eaca9ba5a1b624adf90b6ccee1008efc46f0273/data/resources/sounds/fireplace.ogg",
    "bytes": 325065,
    "sha256": "a6395379a32c2dc30dd870c4571ded4a5311435aacfe354b3a82a9b3ab98620b",
    "durationSeconds": 25.537596,
    "sampleRate": 44100,
    "channels": 2,
    "creator": "ezwa",
    "creatorUrl": "https://soundbible.com/1543-Fireplace.html",
    "sourceUrl": "https://soundbible.com/1543-Fireplace.html",
    "license": "Public Domain",
    "licenseUrl": "https://soundbible.com/1543-Fireplace.html",
    "licenseEvidenceUrl": "https://soundbible.com/1543-Fireplace.html",
    "upstreamLicenseEvidenceUrl": "https://raw.githubusercontent.com/rafaelmardojai/blanket/2eaca9ba5a1b624adf90b6ccee1008efc46f0273/SOUNDS_LICENSING.md",
    "upstreamProject": "Blanket",
    "upstreamRevision": "2eaca9ba5a1b624adf90b6ccee1008efc46f0273",
    "upstreamEditor": null,
    "recordingKind": "real-recording",
    "sourceForm": "Blanket OGG distribution",
    "attribution": "Fireplace by ezwa (https://soundbible.com/1543-Fireplace.html), Public Domain (https://soundbible.com/1543-Fireplace.html).",
    "excerpt": {
      "startSeconds": 0,
      "durationSeconds": 24
    }
  },
  {
    "id": "wind",
    "title": "Wind",
    "category": "ambience",
    "description": "Real wind blowing in a Texas field.",
    "filename": "wind.ogg",
    "downloadUrl": "https://raw.githubusercontent.com/rafaelmardojai/blanket/2eaca9ba5a1b624adf90b6ccee1008efc46f0273/data/resources/sounds/wind.ogg",
    "bytes": 289537,
    "sha256": "cfdc81be69cd5f434ebfeb708bdf094725f3052d76691f550ff0e10eee3e32d2",
    "durationSeconds": 14.839955,
    "sampleRate": 44100,
    "channels": 2,
    "creator": "felix.blume",
    "creatorUrl": "https://freesound.org/people/felix.blume/",
    "sourceUrl": "https://freesound.org/people/felix.blume/sounds/217506/",
    "license": "CC0-1.0",
    "licenseUrl": "https://creativecommons.org/publicdomain/zero/1.0/",
    "licenseEvidenceUrl": "https://freesound.org/people/felix.blume/sounds/217506/",
    "upstreamLicenseEvidenceUrl": "https://raw.githubusercontent.com/rafaelmardojai/blanket/2eaca9ba5a1b624adf90b6ccee1008efc46f0273/SOUNDS_LICENSING.md",
    "upstreamProject": "Blanket",
    "upstreamRevision": "2eaca9ba5a1b624adf90b6ccee1008efc46f0273",
    "upstreamEditor": "Porrumentzio",
    "recordingKind": "real-recording",
    "sourceForm": "Blanket OGG distribution",
    "attribution": "Wind by felix.blume (https://freesound.org/people/felix.blume/sounds/217506/), CC0-1.0 (https://creativecommons.org/publicdomain/zero/1.0/). Blanket version edited by Porrumentzio.",
    "excerpt": {
      "startSeconds": 0,
      "durationSeconds": 14
    }
  },
  {
    "id": "ocean",
    "title": "Ocean waves",
    "category": "ambience",
    "description": "Real close shoreline waves recorded with a Zoom H2.",
    "filename": "waves.ogg",
    "downloadUrl": "https://raw.githubusercontent.com/rafaelmardojai/blanket/2eaca9ba5a1b624adf90b6ccee1008efc46f0273/data/resources/sounds/waves.ogg",
    "bytes": 2765739,
    "sha256": "20e1aec7c7542f71645275871650881ea33bc92bd9816b243ea920bb1daa51a0",
    "durationSeconds": 118.034263,
    "sampleRate": 44100,
    "channels": 2,
    "creator": "Luftrum",
    "creatorUrl": "https://freesound.org/people/Luftrum/",
    "sourceUrl": "https://freesound.org/people/Luftrum/sounds/48412/",
    "license": "CC-BY-4.0",
    "licenseUrl": "https://creativecommons.org/licenses/by/4.0/",
    "licenseEvidenceUrl": "https://freesound.org/people/Luftrum/sounds/48412/",
    "upstreamLicenseEvidenceUrl": "https://raw.githubusercontent.com/rafaelmardojai/blanket/2eaca9ba5a1b624adf90b6ccee1008efc46f0273/SOUNDS_LICENSING.md",
    "upstreamProject": "Blanket",
    "upstreamRevision": "2eaca9ba5a1b624adf90b6ccee1008efc46f0273",
    "upstreamEditor": "Porrumentzio",
    "recordingKind": "real-recording",
    "sourceForm": "Blanket OGG distribution",
    "attribution": "Ocean waves by Luftrum (https://freesound.org/people/Luftrum/sounds/48412/), CC-BY-4.0 (https://creativecommons.org/licenses/by/4.0/). Blanket version edited by Porrumentzio.",
    "excerpt": {
      "startSeconds": 0,
      "durationSeconds": 30
    }
  },
  {
    "id": "birds",
    "title": "Forest birds",
    "category": "ambience",
    "description": "Real morning birds in Shawnee Forest.",
    "filename": "birds.ogg",
    "downloadUrl": "https://raw.githubusercontent.com/rafaelmardojai/blanket/2eaca9ba5a1b624adf90b6ccee1008efc46f0273/data/resources/sounds/birds.ogg",
    "bytes": 3063230,
    "sha256": "e59b19c2a377d5835d07e7ec8f8c876b9f40ae7f703738b55d616ef96a1638b2",
    "durationSeconds": 129.804807,
    "sampleRate": 44100,
    "channels": 2,
    "creator": "kvgarlic",
    "creatorUrl": "https://freesound.org/people/kvgarlic/",
    "sourceUrl": "https://freesound.org/people/kvgarlic/sounds/156826/",
    "license": "CC0-1.0",
    "licenseUrl": "https://creativecommons.org/publicdomain/zero/1.0/",
    "licenseEvidenceUrl": "https://freesound.org/people/kvgarlic/sounds/156826/",
    "upstreamLicenseEvidenceUrl": "https://raw.githubusercontent.com/rafaelmardojai/blanket/2eaca9ba5a1b624adf90b6ccee1008efc46f0273/SOUNDS_LICENSING.md",
    "upstreamProject": "Blanket",
    "upstreamRevision": "2eaca9ba5a1b624adf90b6ccee1008efc46f0273",
    "upstreamEditor": "Porrumentzio",
    "recordingKind": "real-recording",
    "sourceForm": "Blanket OGG distribution",
    "attribution": "Forest birds by kvgarlic (https://freesound.org/people/kvgarlic/sounds/156826/), CC0-1.0 (https://creativecommons.org/publicdomain/zero/1.0/). Blanket version edited by Porrumentzio.",
    "excerpt": {
      "startSeconds": 0,
      "durationSeconds": 30
    }
  },
  {
    "id": "stream",
    "title": "Woodland stream",
    "category": "ambience",
    "description": "Real small woodland stream recorded with a Rode NT5 pair.",
    "filename": "stream.ogg",
    "downloadUrl": "https://raw.githubusercontent.com/rafaelmardojai/blanket/2eaca9ba5a1b624adf90b6ccee1008efc46f0273/data/resources/sounds/stream.ogg",
    "bytes": 5025476,
    "sha256": "ce372c5db561168636647dd7d4aac39ef1785ae5d415ad0e589186ce1b7c5796",
    "durationSeconds": 145.528866,
    "sampleRate": 44100,
    "channels": 2,
    "creator": "gluckose",
    "creatorUrl": "https://freesound.org/people/gluckose/",
    "sourceUrl": "https://freesound.org/people/gluckose/sounds/333987/",
    "license": "CC0-1.0",
    "licenseUrl": "https://creativecommons.org/publicdomain/zero/1.0/",
    "licenseEvidenceUrl": "https://freesound.org/people/gluckose/sounds/333987/",
    "upstreamLicenseEvidenceUrl": "https://raw.githubusercontent.com/rafaelmardojai/blanket/2eaca9ba5a1b624adf90b6ccee1008efc46f0273/SOUNDS_LICENSING.md",
    "upstreamProject": "Blanket",
    "upstreamRevision": "2eaca9ba5a1b624adf90b6ccee1008efc46f0273",
    "upstreamEditor": null,
    "recordingKind": "real-recording",
    "sourceForm": "Blanket OGG distribution",
    "attribution": "Woodland stream by gluckose (https://freesound.org/people/gluckose/sounds/333987/), CC0-1.0 (https://creativecommons.org/publicdomain/zero/1.0/).",
    "excerpt": {
      "startSeconds": 0,
      "durationSeconds": 30
    }
  },
  {
    "id": "night",
    "title": "Night crickets",
    "category": "ambience",
    "description": "Real crickets chirping at night.",
    "filename": "summer-night.ogg",
    "downloadUrl": "https://raw.githubusercontent.com/rafaelmardojai/blanket/2eaca9ba5a1b624adf90b6ccee1008efc46f0273/data/resources/sounds/summer-night.ogg",
    "bytes": 612962,
    "sha256": "2eb2efb8f5c6733e74dc8546f2ecfac40407e8242a9eed96a72e0fc68790ac6f",
    "durationSeconds": 49.320635,
    "sampleRate": 44100,
    "channels": 2,
    "creator": "Lisa Redfern",
    "creatorUrl": "https://soundbible.com/2083-Crickets-Chirping-At-Night.html",
    "sourceUrl": "https://soundbible.com/2083-Crickets-Chirping-At-Night.html",
    "license": "Public Domain",
    "licenseUrl": "https://soundbible.com/2083-Crickets-Chirping-At-Night.html",
    "licenseEvidenceUrl": "https://soundbible.com/2083-Crickets-Chirping-At-Night.html",
    "upstreamLicenseEvidenceUrl": "https://raw.githubusercontent.com/rafaelmardojai/blanket/2eaca9ba5a1b624adf90b6ccee1008efc46f0273/SOUNDS_LICENSING.md",
    "upstreamProject": "Blanket",
    "upstreamRevision": "2eaca9ba5a1b624adf90b6ccee1008efc46f0273",
    "upstreamEditor": null,
    "recordingKind": "real-recording",
    "sourceForm": "Blanket OGG distribution",
    "attribution": "Night crickets by Lisa Redfern (https://soundbible.com/2083-Crickets-Chirping-At-Night.html), Public Domain (https://soundbible.com/2083-Crickets-Chirping-At-Night.html).",
    "excerpt": {
      "startSeconds": 0,
      "durationSeconds": 30
    }
  },
  {
    "id": "brush",
    "title": "Mic foam brushing",
    "category": "tactile",
    "description": "Real scratching/brushing on mic foam, recorded with Neat King Bee v1 and Audient Evo 4.",
    "filename": "brush-hq-preview.mp3",
    "downloadUrl": "https://cdn.freesound.org/previews/803/803595_17274093-hq.mp3",
    "bytes": 3313536,
    "sha256": "7d9669dad6353026b434832eb84c407a3bd2b958b5baaf4de4507d840d277be8",
    "durationSeconds": 176.664,
    "sampleRate": 48000,
    "channels": 2,
    "creator": "salemaudio",
    "creatorUrl": "https://freesound.org/people/salemaudio/",
    "sourceUrl": "https://freesound.org/people/salemaudio/sounds/803595/",
    "license": "CC0-1.0",
    "licenseUrl": "https://creativecommons.org/publicdomain/zero/1.0/",
    "licenseEvidenceUrl": "https://freesound.org/people/salemaudio/sounds/803595/",
    "recordingKind": "real-recording",
    "sourceForm": "Public Freesound HQ MP3 preview; not the gated original file",
    "attribution": "Mic foam brushing by salemaudio (https://freesound.org/people/salemaudio/sounds/803595/), CC0-1.0 (https://creativecommons.org/publicdomain/zero/1.0/).",
    "excerpt": {
      "startSeconds": 0,
      "durationSeconds": 30
    }
  },
  {
    "id": "cardboard-tapping",
    "title": "Cardboard tapping",
    "category": "tactile",
    "description": "Rhythmic real tapping on a cardboard box, stereo contact microphones into a Zoom H1n.",
    "filename": "cardboard-tapping-hq-preview.mp3",
    "downloadUrl": "https://cdn.freesound.org/previews/716/716591_4967224-hq.mp3",
    "bytes": 825072,
    "sha256": "3206371c5e994c480f437c5295dd609dd6d251830c4696814894957cce487324",
    "durationSeconds": 32.232,
    "sampleRate": 48000,
    "channels": 2,
    "creator": "madamdata",
    "creatorUrl": "https://freesound.org/people/madamdata/",
    "sourceUrl": "https://freesound.org/people/madamdata/sounds/716591/",
    "license": "CC0-1.0",
    "licenseUrl": "https://creativecommons.org/publicdomain/zero/1.0/",
    "licenseEvidenceUrl": "https://freesound.org/people/madamdata/sounds/716591/",
    "recordingKind": "real-recording",
    "sourceForm": "Public Freesound HQ MP3 preview; not the gated original file",
    "attribution": "Cardboard tapping by madamdata (https://freesound.org/people/madamdata/sounds/716591/), CC0-1.0 (https://creativecommons.org/publicdomain/zero/1.0/).",
    "excerpt": {
      "startSeconds": 0,
      "durationSeconds": 30
    }
  },
  {
    "id": "glass-tapping",
    "title": "Fingernail glass taps",
    "category": "tactile",
    "description": "ASMR fingernails tapping on glass; source supplied as MP3.",
    "filename": "glass-tapping-hq-preview.mp3",
    "downloadUrl": "https://cdn.freesound.org/previews/690/690082_14301666-hq.mp3",
    "bytes": 497808,
    "sha256": "831718d3abb27f47acffb06201a21e1680d4d69ce3d9e95b1d7e227611aa55c9",
    "durationSeconds": 20.592,
    "sampleRate": 48000,
    "channels": 2,
    "creator": "Elias79",
    "creatorUrl": "https://freesound.org/people/Elias79/",
    "sourceUrl": "https://freesound.org/people/Elias79/sounds/690082/",
    "license": "CC0-1.0",
    "licenseUrl": "https://creativecommons.org/publicdomain/zero/1.0/",
    "licenseEvidenceUrl": "https://freesound.org/people/Elias79/sounds/690082/",
    "recordingKind": "real-recording",
    "sourceForm": "Public Freesound HQ MP3 preview; not the gated original file",
    "attribution": "Fingernail glass taps by Elias79 (https://freesound.org/people/Elias79/sounds/690082/), CC0-1.0 (https://creativecommons.org/publicdomain/zero/1.0/).",
    "excerpt": {
      "startSeconds": 0,
      "durationSeconds": 20
    }
  },
  {
    "id": "paper",
    "title": "Turning book pages",
    "category": "tactile",
    "description": "Real pages turning in a book; no spoken narration indicated in source.",
    "filename": "paper-hq-preview.mp3",
    "downloadUrl": "https://cdn.freesound.org/previews/519/519102_10756146-hq.mp3",
    "bytes": 150377,
    "sha256": "2df1b36d1cf179f360710010b1c7063f0aca673e480a300b205703a2d5b6d194",
    "durationSeconds": 6.452245,
    "sampleRate": 44100,
    "channels": 1,
    "creator": "Mateusz_Chenc",
    "creatorUrl": "https://freesound.org/people/Mateusz_Chenc/",
    "sourceUrl": "https://freesound.org/people/Mateusz_Chenc/sounds/519102/",
    "license": "CC0-1.0",
    "licenseUrl": "https://creativecommons.org/publicdomain/zero/1.0/",
    "licenseEvidenceUrl": "https://freesound.org/people/Mateusz_Chenc/sounds/519102/",
    "recordingKind": "real-recording",
    "sourceForm": "Public Freesound HQ MP3 preview; not the gated original file",
    "attribution": "Turning book pages by Mateusz_Chenc (https://freesound.org/people/Mateusz_Chenc/sounds/519102/), CC0-1.0 (https://creativecommons.org/publicdomain/zero/1.0/).",
    "excerpt": {
      "startSeconds": 0,
      "durationSeconds": 6
    }
  },
  {
    "id": "keyboard",
    "title": "Keyboard typing",
    "category": "tactile",
    "description": "Human typing on Cherry KC 1000 recorded with Shure SM7B; creator postprocessed with Izotope Neutron 2. Selected human typing, not the generated typing sequences.",
    "filename": "keyboard-human-typing.wav",
    "downloadUrl": "https://opengameart.org/sites/default/files/unicae_games_keyboard_soundpack_1_0.zip",
    "bytes": 797010,
    "sha256": "4790a623321eb4da8a9e33f3ea609fb4a5559db5de61375f61c060c5aa466fc3",
    "durationSeconds": 9.0,
    "sampleRate": 44100,
    "channels": 1,
    "creator": "unicaegames",
    "creatorUrl": "https://opengameart.org/users/unicaegames",
    "sourceUrl": "https://opengameart.org/content/keyboard-soundpack-1-typing-and-single-keystrokes",
    "license": "CC0-1.0",
    "licenseUrl": "https://creativecommons.org/publicdomain/zero/1.0/",
    "licenseEvidenceUrl": "https://opengameart.org/content/keyboard-soundpack-1-typing-and-single-keystrokes",
    "recordingKind": "real-recording",
    "sourceForm": "Unchanged WAV extracted from creator ZIP",
    "attribution": "Keyboard typing by unicaegames (https://opengameart.org/content/keyboard-soundpack-1-typing-and-single-keystrokes), CC0-1.0 (https://creativecommons.org/publicdomain/zero/1.0/).",
    "archiveMember": "Human Typing/human_vel-001.wav",
    "archiveBytes": 8515609,
    "archiveSha256": "935eae2fa5c3742eacdd38c4ea0e9047f3887faa0701996498492c256db1b351",
    "excerpt": {
      "startSeconds": 0,
      "durationSeconds": 9
    }
  },
  {
    "id": "windscreen-rubbing",
    "title": "Windscreen rubbing",
    "category": "tactile",
    "description": "A hand gently rubbing a recorder windscreen; the creator identifies a soft, fuzzy texture.",
    "filename": "windscreen-rubbing-hq-preview.mp3",
    "downloadUrl": "https://cdn.freesound.org/previews/621/621311_13228046-hq.mp3",
    "bytes": 708663,
    "sha256": "7532be64bc880818e8df1e866cff8510ebe40c97fdc7285fd85621e283a709b6",
    "durationSeconds": 30.901406,
    "sampleRate": 44100,
    "channels": 2,
    "creator": "Seth_Makes_Sounds",
    "creatorUrl": "https://freesound.org/people/Seth_Makes_Sounds/",
    "sourceUrl": "https://freesound.org/people/Seth_Makes_Sounds/sounds/621311/",
    "license": "CC0-1.0",
    "licenseUrl": "https://creativecommons.org/publicdomain/zero/1.0/",
    "licenseEvidenceUrl": "https://freesound.org/people/Seth_Makes_Sounds/sounds/621311/",
    "recordingKind": "real-recording",
    "sourceForm": "Public Freesound HQ MP3 preview; not the gated original file",
    "attribution": "Windscreen rubbing by Seth_Makes_Sounds (https://freesound.org/people/Seth_Makes_Sounds/sounds/621311/), CC0-1.0 (https://creativecommons.org/publicdomain/zero/1.0/).",
    "excerpt": {
      "startSeconds": 0,
      "durationSeconds": 30
    }
  },
  {
    "id": "makeup-brush-skin",
    "title": "Makeup brush on skin",
    "category": "tactile",
    "description": "A makeup brush moving on skin. The creator's original is a compressed M4A recording.",
    "filename": "makeup-brush-skin-hq-preview.mp3",
    "downloadUrl": "https://cdn.freesound.org/previews/575/575858_12995869-hq.mp3",
    "bytes": 338592,
    "sha256": "26bca381eed8638cba87013f41566a7422b4c3aa5e068eb06b219518b45684f5",
    "durationSeconds": 17.642667,
    "sampleRate": 48000,
    "channels": 2,
    "creator": "tea333",
    "creatorUrl": "https://freesound.org/people/tea333/",
    "sourceUrl": "https://freesound.org/people/tea333/sounds/575858/",
    "license": "CC0-1.0",
    "licenseUrl": "https://creativecommons.org/publicdomain/zero/1.0/",
    "licenseEvidenceUrl": "https://freesound.org/people/tea333/sounds/575858/",
    "recordingKind": "real-recording",
    "sourceForm": "Public Freesound HQ MP3 preview; not the gated original file",
    "attribution": "Makeup brush on skin by tea333 (https://freesound.org/people/tea333/sounds/575858/), CC0-1.0 (https://creativecommons.org/publicdomain/zero/1.0/).",
    "gainDb": 10,
    "excerpt": {
      "startSeconds": 0,
      "durationSeconds": 17
    }
  },
  {
    "id": "slow-fabric-petting",
    "title": "Slow fabric petting",
    "category": "tactile",
    "description": "Slow, close hand contact with fabric, as described by the creator.",
    "filename": "slow-fabric-petting-hq-preview.mp3",
    "downloadUrl": "https://cdn.freesound.org/previews/713/713009_41750-hq.mp3",
    "bytes": 180528,
    "sha256": "53c3e9e35d2fb47cbfb5e4d7cfc41392609234d274b00a34209a07a1fe28cdae",
    "durationSeconds": 9.948104,
    "sampleRate": 48000,
    "channels": 2,
    "creator": "conk0018",
    "creatorUrl": "https://freesound.org/people/conk0018/",
    "sourceUrl": "https://freesound.org/people/conk0018/sounds/713009/",
    "license": "CC0-1.0",
    "licenseUrl": "https://creativecommons.org/publicdomain/zero/1.0/",
    "licenseEvidenceUrl": "https://freesound.org/people/conk0018/sounds/713009/",
    "recordingKind": "real-recording",
    "sourceForm": "Public Freesound HQ MP3 preview; not the gated original file",
    "attribution": "Slow fabric petting by conk0018 (https://freesound.org/people/conk0018/sounds/713009/), CC0-1.0 (https://creativecommons.org/publicdomain/zero/1.0/).",
    "excerpt": {
      "startSeconds": 0,
      "durationSeconds": 9
    }
  },
  {
    "id": "slow-hand-rubbing",
    "title": "Slow hand rubbing",
    "category": "tactile",
    "description": "Slow hand friction recorded at close range. A fixed gain raises the unusually quiet source for playback.",
    "filename": "slow-hand-rubbing-hq-preview.mp3",
    "downloadUrl": "https://cdn.freesound.org/previews/766/766063_15688689-hq.mp3",
    "bytes": 470112,
    "sha256": "2bc2a65a9d06c9246c597d0adfcd058455711cd7c7cfcafc247252f065ec409d",
    "durationSeconds": 20.282875,
    "sampleRate": 48000,
    "channels": 1,
    "creator": "LizzBitzz",
    "creatorUrl": "https://freesound.org/people/LizzBitzz/",
    "sourceUrl": "https://freesound.org/people/LizzBitzz/sounds/766063/",
    "license": "CC0-1.0",
    "licenseUrl": "https://creativecommons.org/publicdomain/zero/1.0/",
    "licenseEvidenceUrl": "https://freesound.org/people/LizzBitzz/sounds/766063/",
    "recordingKind": "real-recording",
    "sourceForm": "Public Freesound HQ MP3 preview; not the gated original file",
    "attribution": "Slow hand rubbing by LizzBitzz (https://freesound.org/people/LizzBitzz/sounds/766063/), CC0-1.0 (https://creativecommons.org/publicdomain/zero/1.0/).",
    "gainDb": 42,
    "excerpt": {
      "startSeconds": 0,
      "durationSeconds": 20
    }
  },
  {
    id:'window-rain',title:'Window rain',category:'ambience',
    description:'Soft rain on a window, procedurally synthesized with Earshot and prepared for continuous looping.',
    filename:'window-rain.wav',
    downloadUrl:'https://github.com/zevarix/asmr-studio/releases/download/sounds-earshot-water-v1/window-rain.wav',
    bytes:3528044,sha256:'ae9f3dc1fac28f3f41087c41d50506da97d8a1934c89203e2ca684f1f7816035',
    durationSeconds:20,sampleRate:44100,channels:2,
    creator:'Earshot contributors',creatorUrl:'https://github.com/Leonxlnx/earshot',
    sourceUrl:earshotReadme,license:'Earshot output permission',licenseUrl:earshotReadme,
    licenseEvidenceUrl:earshotReadme,upstreamProject:'Earshot',upstreamRevision:earshotRevision,
    recordingKind:'procedural-synthesis',sourceForm:'Earshot rain/window procedural synthesis; prepared PCM16 WAV',
    attribution:`Window rain generated with Earshot rain/window (${earshotReadme}). Earshot code is MIT; its output permission allows any use, including commercial use, without attribution. No source recording is used for this procedural design.`,
    preparation:'preserve-wav',
    preparationNotes:`${earshotParameters} A fixed -7.5609548569773475 dB attenuation is already included. No baked loop crossfade or boundary fade.`,
    preferredLoop:{startSeconds:0,endSeconds:20,crossfadeSeconds:0},
    excerpt:{startSeconds:0,durationSeconds:20},
  },
  {
    id:'rain-on-wood',title:'Rain on wood',category:'ambience',
    description:'Rain reconstructed with Earshot from a CC0 wood-deck recording, with a short loop join.',
    filename:'rain-on-wood.wav',
    downloadUrl:'https://github.com/zevarix/asmr-studio/releases/download/sounds-earshot-water-v1/rain-on-wood.wav',
    bytes:3528044,sha256:'5049b51ea3b1b97a2630db181628686ce99a807b7deea1f480b482850ce99227',
    durationSeconds:20,sampleRate:44100,channels:2,
    creator:'Earshot contributors; source recording by cocaine',creatorUrl:'https://freesound.org/people/cocaine/',
    sourceUrl:'https://freesound.org/people/cocaine/sounds/611421/',
    license:'Earshot output permission',licenseUrl:earshotReadme,licenseEvidenceUrl:earshotReadme,
    upstreamLicenseEvidenceUrl:earshotCredits,
    upstreamProject:'Earshot',upstreamRevision:earshotRevision,
    recordingKind:'recording-reconstruction',sourceForm:'Earshot rain/wood recording-derived reconstruction; prepared PCM16 WAV',
    attribution:`Rain on wood generated with Earshot rain/wood (${earshotReadme}), using a model derived from “Rain On Wood Deck (Extreme Quality)” by cocaine (https://freesound.org/people/cocaine/sounds/611421/), CC0 1.0 (https://creativecommons.org/publicdomain/zero/1.0/). Earshot code is MIT; its output permission allows any use, including commercial use, without attribution.`,
    preparation:'preserve-wav',
    preparationNotes:`${earshotParameters} A fixed -6.0857056079240905 dB attenuation is already included. No baked loop crossfade or boundary fade.`,
    preferredLoop:{startSeconds:0,endSeconds:20,crossfadeSeconds:0.02},
    excerpt:{startSeconds:0,durationSeconds:20},
  },
  {
    id:'small-brook',title:'Small brook',category:'ambience',
    description:'A gently flowing brook reconstructed with Earshot from a CC0 stream recording, with a short loop join.',
    filename:'small-brook.wav',
    downloadUrl:'https://github.com/zevarix/asmr-studio/releases/download/sounds-earshot-water-v1/small-brook.wav',
    bytes:3528044,sha256:'69a50dc8dc98dc03904781730e66f0e4f127a852ea38eeb34074b9449a7523b8',
    durationSeconds:20,sampleRate:44100,channels:2,
    creator:'Earshot contributors; source recording by Joseph Sardin (BigSoundBank.com)',creatorUrl:'https://bigsoundbank.com/',
    sourceUrl:'https://bigsoundbank.com/small-stream-s0823.html',
    license:'Earshot output permission',licenseUrl:earshotReadme,licenseEvidenceUrl:earshotReadme,
    upstreamLicenseEvidenceUrl:earshotCredits,
    upstreamProject:'Earshot',upstreamRevision:earshotRevision,
    recordingKind:'recording-reconstruction',sourceForm:'Earshot stream/brook recording-derived reconstruction; prepared PCM16 WAV',
    attribution:`Small brook generated with Earshot stream/brook (${earshotReadme}), using a model derived from “Small Stream” by Joseph Sardin, BigSoundBank.com (https://bigsoundbank.com/small-stream-s0823.html), CC0 1.0 (https://creativecommons.org/publicdomain/zero/1.0/). Earshot code is MIT; its output permission allows any use, including commercial use, without attribution.`,
    preparation:'preserve-wav',
    preparationNotes:`${earshotParameters} No additional attenuation was applied after generation. No baked loop crossfade or boundary fade.`,
    preferredLoop:{startSeconds:0,endSeconds:20,crossfadeSeconds:0.02},
    excerpt:{startSeconds:0,durationSeconds:20},
  }
];
