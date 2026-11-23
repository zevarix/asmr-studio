#!/usr/bin/env python3
"""Reproducible listening comparisons; no app changes or source-file writes.

Requires Python 3.11+ and an existing FFmpeg installation. The fixed source
declarations are beside this script. All output is written to a new directory.
"""
import argparse
import array
import hashlib
import html
import json
import math
from pathlib import Path
import shutil
import struct
import subprocess
import sys
import wave

RATE = 48_000
CHANNELS = 2
EDGE_SECONDS = .02
CONDITIONS = {"original": "Original", "low-cut-40": "Low cut · 40 Hz",
              "low-cut-80": "Low cut · 80 Hz", "speed-085": "Slower · 0.85×"}


def sha256(path):
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def highpass(cutoff):
    # Web Audio highpass Q uses dB, unlike peaking EQ's linear Q.
    # Match the AudioParam's float32 representation before coefficient math.
    q_db = struct.unpack("<f", struct.pack("<f", 20 * math.log10(math.sqrt(.5))))[0]
    omega = 2 * math.pi * cutoff / RATE
    cosine = math.cos(omega)
    alpha = math.sin(omega) / (2 * 10 ** (q_db / 20))
    coefficients = {"b0": (1 + cosine) / 2, "b1": -(1 + cosine),
                    "b2": (1 + cosine) / 2, "a0": 1 + alpha,
                    "a1": -2 * cosine, "a2": 1 - alpha}
    return "biquad=" + ":".join(f"{key}={value:.17g}" for key, value in coefficients.items()) + \
        ":normalize=0:transform=di:precision=f64:blocksize=0"


def render_float(source, path, condition):
    start = source["startSeconds"]
    end = start + source["sourceDurationSeconds"]
    filters = [f"aresample={RATE}", "aformat=sample_fmts=flt:channel_layouts=stereo",
               f"atrim=start=0:end={end}", "asetpts=PTS-STARTPTS"]
    if condition.startswith("low-cut-"):
        # Warm the filter from the recording's beginning before selecting the excerpt.
        filters.append(highpass(int(condition.rsplit("-", 1)[1])))
    filters += [f"atrim=start={start}:end={end}", "asetpts=PTS-STARTPTS"]
    if condition == "speed-085":
        filters += ["asetrate=40800", f"aresample={RATE}"]
    filters.append(f"volume={source['commonGainDb']}dB:precision=double")
    raw = subprocess.check_output(["ffmpeg", "-nostdin", "-v", "error", "-i", str(path),
        "-af", ",".join(filters), "-ar", str(RATE), "-ac", str(CHANNELS),
        "-f", "f32le", "pipe:1"])
    values = array.array("f")
    values.frombytes(raw)
    if sys.byteorder != "little":
        values.byteswap()
    if len(values) % CHANNELS:
        raise ValueError("Incomplete output frame")
    expected = source["sourceDurationSeconds"] * RATE / (.85 if condition == "speed-085" else 1)
    if abs(len(values) / CHANNELS - expected) > 1:
        raise ValueError("Unexpected duration")
    if any(not math.isfinite(value) for value in values):
        raise ValueError("Non-finite output")
    peak = max(map(abs, values), default=0)
    if peak >= 1:
        raise ValueError("Comparison would clip; choose a lower common source gain")
    frames = len(values) // CHANNELS
    edge = round(EDGE_SECONDS * RATE)
    for frame in range(edge):
        gain = frame / (edge - 1)
        for channel in range(CHANNELS):
            values[frame * CHANNELS + channel] *= gain
            values[(frames - 1 - frame) * CHANNELS + channel] *= gain
    return values


def write_wav(path, values):
    integers = array.array("h", (round(value * 32767) for value in values))
    if sys.byteorder != "little":
        integers.byteswap()
    with wave.open(str(path), "wb") as output:
        output.setnchannels(CHANNELS)
        output.setsampwidth(2)
        output.setframerate(RATE)
        output.writeframes(integers.tobytes())
    return inspect_wav(path)


def inspect_wav(path):
    with wave.open(str(path), "rb") as source:
        assert source.getnchannels() == CHANNELS and source.getsampwidth() == 2
        assert source.getframerate() == RATE
        frames = source.getnframes()
        raw = source.readframes(frames)
        assert len(raw) == frames * CHANNELS * 2
    values = array.array("h")
    values.frombytes(raw)
    if sys.byteorder != "little":
        values.byteswap()
    peak = max(map(abs, values), default=0)
    rms = math.sqrt(sum(value * value for value in values) / len(values))
    assert peak < 32767
    return {"filename": path.name, "frames": frames, "durationSeconds": frames / RATE,
            "sampleRate": RATE, "channels": CHANNELS, "peakDbfs": 20 * math.log10(max(peak, 1) / 32768),
            "rmsDbfs": 20 * math.log10(max(rms, 1) / 32768), "clippedSamples": 0,
            "sha256": sha256(path)}


def concatenate(path, sources, recordings, conditions):
    content = bytearray(b"\0" * round(.25 * RATE) * CHANNELS * 2)
    segments = []
    for source in sources:
        for index, condition in enumerate(conditions):
            if segments:
                gap = .75 if index == 0 else .5
                content.extend(b"\0" * round(gap * RATE) * CHANNELS * 2)
            filename = recordings[(source["id"], condition)]
            with wave.open(str(filename), "rb") as recording:
                start = len(content) / (CHANNELS * 2 * RATE)
                content.extend(recording.readframes(recording.getnframes()))
                segments.append({"sourceId": source["id"], "title": source["title"],
                    "condition": condition, "label": CONDITIONS[condition], "startSeconds": start,
                    "durationSeconds": recording.getnframes() / RATE})
    content.extend(b"\0" * round(.25 * RATE) * CHANNELS * 2)
    with wave.open(str(path), "wb") as output:
        output.setnchannels(CHANNELS)
        output.setsampwidth(2)
        output.setframerate(RATE)
        output.writeframes(content)
    return {**inspect_wav(path), "segments": segments}


def timecode(seconds):
    return f"{int(seconds // 60)}:{seconds % 60:05.2f}"


def make_page(output, manifest):
    sections = []
    for audition in manifest["auditions"]:
        title = "Linked speed and pitch" if "speed" in audition["filename"] else "Low-cut comparison"
        rows = "".join(f"<tr><td>{timecode(item['startSeconds'])}</td><td>{html.escape(item['title'])}</td><td>{html.escape(item['label'])}</td></tr>" for item in audition["segments"])
        sections.append(f"<section><h2>{title}</h2><audio controls preload='metadata' src='{audition['filename']}'></audio><table><thead><tr><th>Starts</th><th>Recording</th><th>Setting</th></tr></thead><tbody>{rows}</tbody></table></section>")
    credits = "".join(f"<li><a href='{source['sourceUrl']}'>{html.escape(source['title'])}</a> by {html.escape(source['creator'])} — CC0; public MP3 preview. Excerpt {source['startSeconds']}–{source['startSeconds'] + source['sourceDurationSeconds']} seconds; common gain {source['commonGainDb']:+} dB.</li>" for source in manifest["sources"])
    page = """<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>ASMR Studio — audio candidates</title>
<style>:root{color-scheme:dark;font-family:system-ui,sans-serif;background:#151e19;color:#e5eee7}body{max-width:54rem;margin:3rem auto;padding:0 1rem;line-height:1.6}h1{line-height:1.15}section{padding:1.25rem;margin:1.5rem 0;border:1px solid #506657;border-radius:1rem;background:#202d25}audio{width:100%;margin:.75rem 0}table{border-collapse:collapse;width:100%;font-size:.95rem}td,th{text-align:left;border-bottom:1px solid #506657;padding:.6rem .25rem}a{color:#bad6b7}p,li{max-width:70ch}.note{color:#c0cdc3}@media(max-width:420px){body{margin:1.5rem auto}td,th{font-size:.8rem;padding:.6rem .2rem}}</style>
<h1>Listen before choosing the next effect</h1><p>Two studio recordings, repeated with different settings. These are experiments; the app has not applied either effect to your saved mixes.</p>
<p class="note">Every version of a recording uses the same gain. The low-cut versions have no compensating volume boost. The slower version changes pitch with speed. A 20 ms fade only at each clip's outer edges avoids abrupt cut-in/out.</p>""" + "".join(sections) + f"<section><h2>Credits and source details</h2><ul>{credits}</ul><p>Unchanged downloaded MP3s are in <code>originals/</code>. Individual comparisons are in <code>clips/</code>. See <code>manifest.json</code> for exact timings, hashes, and processing details, and <code>README.md</code> for reproduction.</p></section></html>"
    (output / "index.html").write_text(page, encoding="utf-8")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source-dir", required=True, type=Path)
    parser.add_argument("--output-dir", required=True, type=Path)
    args = parser.parse_args()
    config = Path(__file__).with_name("sources.json")
    sources = json.loads(config.read_text())["sources"]
    for source in sources:
        path = args.source_dir / source["filename"]
        if sha256(path) != source["sha256"]:
            raise ValueError("Source hash mismatch: " + source["filename"])
    output = args.output_dir.resolve()
    output.mkdir(parents=True, exist_ok=False)
    (output / "clips").mkdir()
    (output / "originals").mkdir()
    recordings, files = {}, []
    for source in sources:
        path = args.source_dir / source["filename"]
        shutil.copyfile(path, output / "originals" / source["filename"])
        for condition in CONDITIONS:
            destination = output / "clips" / (source["id"] + "-" + condition + ".wav")
            values = render_float(source, path, condition)
            files.append({**write_wav(destination, values), "sourceId": source["id"], "condition": condition})
            recordings[(source["id"], condition)] = destination
    auditions = [concatenate(output / "asmr-speed-audition.wav", sources, recordings, ["original", "speed-085"]),
                 concatenate(output / "asmr-low-cut-audition.wav", sources, recordings, ["original", "low-cut-40", "low-cut-80"])]
    manifest = {"schemaVersion": 1, "purpose": "Listening comparison, not product acceptance",
        "sourceCommit": "d9ff89b48bcf4da6935e7905f6af61adf4c12148", "sources": sources,
        "processing": {"output": "48 kHz stereo PCM16", "edgeFadeSeconds": EDGE_SECONDS,
            "gain": "Fixed per source, identical across conditions; no normalization or limiting",
            "lowCut": "Two-pole Butterworth high-pass, W3C highpass coefficients with float32 Q in dB; filter warmed before excerpt",
            "speed": "FFmpeg asetrate=40800, aresample=48000; linked pitch; no pitch preservation",
            "ffmpeg": subprocess.check_output(["ffmpeg", "-version"], text=True).splitlines()[0]},
        "clips": files, "auditions": auditions, "listeningAccepted": False}
    (output / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    make_page(output, manifest)
    shutil.copyfile(Path(__file__), output / "make-auditions.py")
    shutil.copyfile(config, output / "sources.json")
    readme = "# ASMR Studio audio candidate auditions\n\nOpen index.html or play the WAV comparisons directly. The app is unchanged.\n\n"
    for audition in auditions:
        readme += "## " + audition["filename"] + "\n\n| Starts | Recording | Setting |\n| --- | --- | --- |\n"
        for item in audition["segments"]:
            readme += f"| {timecode(item['startSeconds'])} | {item['title']} | {item['label']} |\n"
        readme += "\n"
    readme += "## Processing and reproduction\n\nSame gain within each recording: brushing 0 dB, tapping +6 dB. No per-condition normalization, compression, or limiting. Every clip receives a 20 ms outer-edge fade. Source previews remain unchanged under originals/.\n\nThe low cut is a non-resonant two-pole filter at 40 or 80 Hz. It can remove desirable body as well as rumble. Slower playback uses 0.85× speed and lowers pitch by about 2.81 semitones. Six source seconds become about 7.06 output seconds.\n\nPython 3.11+ and an existing FFmpeg installation are sufficient. Run from this extracted folder:\n\n```sh\npython3 make-auditions.py --source-dir originals --output-dir ../regenerated-auditions\n```\n\nThe output directory must be new. Original preview hashes are checked before writing. No downloads, installation, source changes, or app changes are performed. Exact bytes can vary with FFmpeg versions; manifest.json records the generating version, timings, processing, and output hashes.\n\n## Credits\n\n"
    for source in sources:
        readme += f"- {source['title']} by {source['creator']}: {source['sourceUrl']} — CC0 ({source['licenseUrl']}). Public HQ MP3 preview; excerpt {source['startSeconds']}–{source['startSeconds'] + source['sourceDurationSeconds']} seconds.\n"
    (output / "README.md").write_text(readme, encoding="utf-8")
    print(json.dumps({"directory": str(output), "auditions": auditions, "clips": len(files)}, indent=2))


if __name__ == "__main__":
    main()
