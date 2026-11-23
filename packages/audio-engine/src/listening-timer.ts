import type {ListeningTimerSettings} from '@asmr-studio/contracts';

/** Fresh linear listening envelope, shared by audio-clock automation and WAV rendering. */
export function listeningEnvelopeGain(settings:ListeningTimerSettings|undefined,elapsedSeconds:number,endpointSeconds:number):number {
  if(!settings?.enabled)return 1;
  const elapsed=Math.max(0,elapsedSeconds);
  if(elapsed>=endpointSeconds)return 0;
  let gain=1;
  if(settings.fadeInSeconds>0&&elapsed<settings.fadeInSeconds)gain=elapsed/settings.fadeInSeconds;
  if(settings.fadeOutSeconds>0&&elapsed>endpointSeconds-settings.fadeOutSeconds)
    gain=Math.min(gain,(endpointSeconds-elapsed)/settings.fadeOutSeconds);
  return Math.fround(Math.max(0,Math.min(1,gain)));
}
