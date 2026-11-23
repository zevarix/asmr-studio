import type {PlaybackSnapshot} from '@asmr-studio/audio-engine';
import IconPlayerPause from '@tabler/icons-react/icons/IconPlayerPause';
import IconPlayerPlay from '@tabler/icons-react/icons/IconPlayerPlay';
import IconPlayerStop from '@tabler/icons-react/icons/IconPlayerStop';
const friendly = {idle:'Idle',loading:'Loading audio',ready:'Ready',playing:'Playing',paused:'Paused',interrupted:'Interrupted',error:'Error'} as const;
export function formatTime(seconds:number) {
  const total=Math.floor(Math.max(0,seconds));
  return Math.floor(total/60)+':'+String(total%60).padStart(2,'0');
}
interface Props {
  playback:PlaybackSnapshot;
  hasLayers:boolean;
  onStart:()=>void;
  onPause:()=>void;
  onStop:()=>void;
}
export function Transport({playback,hasLayers,onStart,onPause,onStop}:Props){
  const phase=playback.listeningTimer?.phase;
  const label=phase==='finished'?'Timer finished':friendly[playback.state];
  const fade=playback.state==='playing'?(phase==='fading-in'?'Fading in':phase==='fading-out'?'Fading out':''):'';
  return <section className="transport" data-playback={playback.state} aria-label="Playback controls">
    <div className="transport-buttons">
      <button type="button" className="primary" disabled={!hasLayers||playback.state==='loading'||playback.state==='playing'}
        onClick={onStart}><IconPlayerPlay size={18} stroke={1.7} aria-hidden="true"/>Start listening</button>
      <button type="button" disabled={playback.state!=='playing'} onClick={onPause}><IconPlayerPause size={18} stroke={1.7} aria-hidden="true"/>Pause</button>
      <button type="button" disabled={!['playing','paused','interrupted','loading'].includes(playback.state)&&phase!=='finished'} onClick={onStop}><IconPlayerStop size={18} stroke={1.7} aria-hidden="true"/>Stop</button>
    </div>
    <div className="status-line"><span role="status" aria-live="polite">{label}{fade?' · '+fade:''}</span>
      <span aria-live="off"> · <span aria-label="Elapsed time">{formatTime(playback.positionSeconds)}</span></span></div>
    {playback.error&&<p className="error" role="alert">{playback.error}</p>}
  </section>;
}
