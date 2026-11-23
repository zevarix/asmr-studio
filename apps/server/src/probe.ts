import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { StudioError } from './errors.js';
const run = promisify(execFile);
export interface AudioProbe { durationSeconds:number; sampleRate:number; channels:number; format:string; mime:string; extension:string }
const formats: Record<string, {mime:string; extension:string; aliases:string[]}> = {
  wav: {mime:'audio/wav', extension:'wav', aliases:['audio/wav','audio/x-wav','audio/wave','audio/vnd.wave']},
  flac: {mime:'audio/flac', extension:'flac', aliases:['audio/flac','audio/x-flac']},
  mp3: {mime:'audio/mpeg', extension:'mp3', aliases:['audio/mpeg','audio/mp3']},
  ogg: {mime:'audio/ogg', extension:'ogg', aliases:['audio/ogg','application/ogg']},
  m4a: {mime:'audio/mp4', extension:'m4a', aliases:['audio/mp4','audio/x-m4a']},
};
export async function probeAudio(path: string, acceptedFormats: readonly string[], declaredType: string): Promise<AudioProbe> {
  let value: {streams?:Array<{codec_type?:string; sample_rate?:string; channels?:number; duration?:string}>; format?:{format_name?:string; duration?:string}};
  try {
    const result = await run('ffprobe', ['-v','error','-protocol_whitelist','file','-format_whitelist','wav,flac,mp3,ogg,mov',
      '-show_streams','-show_format','-of','json',path], {encoding:'utf8',timeout:15000,maxBuffer:1024*1024,windowsHide:true});
    value = JSON.parse(result.stdout) as typeof value;
  } catch { throw new StudioError('INVALID_AUDIO', 'The upload is not a supported readable audio file', 422); }
  const names = value.format?.format_name?.split(',') ?? [];
  const format = names.includes('mov') ? 'm4a' : names[0];
  const stream = value.streams?.[0];
  const durationSeconds = Number(value.format?.duration ?? stream?.duration);
  const sampleRate = Number(stream?.sample_rate);
  const channels = stream?.channels ?? 0;
  const definition = format ? formats[format] : undefined;
  if (!format || !definition || !acceptedFormats.includes(format) || value.streams?.length !== 1 || stream?.codec_type !== 'audio'
    || !Number.isFinite(durationSeconds) || durationSeconds <= 0 || !Number.isSafeInteger(sampleRate) || sampleRate <= 0
    || !Number.isSafeInteger(channels) || channels <= 0) {
    throw new StudioError('INVALID_AUDIO', 'The upload must contain one supported audio stream with valid measured properties', 422);
  }
  const declared = declaredType.split(';')[0]?.trim().toLowerCase();
  if (declared && declared !== 'application/octet-stream' && !definition.aliases.includes(declared)) {
    throw new StudioError('MIME_MISMATCH', 'Declared content type does not match the audio content', 422);
  }
  return {durationSeconds,sampleRate,channels,format,mime:definition.mime,extension:definition.extension};
}
