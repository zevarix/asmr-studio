import {useEffect,useId,useMemo,useRef,useState,type CSSProperties} from 'react';
import IconPlayerPlay from '@tabler/icons-react/icons/IconPlayerPlay';
import IconPlayerStop from '@tabler/icons-react/icons/IconPlayerStop';
import IconRepeat from '@tabler/icons-react/icons/IconRepeat';
import type {Loop} from '@asmr-studio/contracts';
import {getLoopFrames} from '@asmr-studio/audio-engine';
import type {LoopWaveform} from './loop-audio-service.js';
import {formatDuration} from './sound-utils.js';
import './LoopEditor.css';

export interface LoopWaveformState {
  status:'idle'|'loading'|'ready'|'error';
  waveform?:LoopWaveform;
  sampleRate?:number;
  frameCount?:number;
  error?:string;
}

export interface LoopPreviewState {
  status:'idle'|'loading'|'playing'|'error';
  error?:string;
}

export interface LoopPreviewControls {
  state:LoopPreviewState;
  disabled:boolean;
  requiresPause?:boolean;
  onPlay:(loop:Loop)=>void;
  onStop:()=>void;
}

interface LoopEditorProps {
  loop:Loop;
  open:boolean;
  durationSeconds?:number|undefined;
  waveform?:LoopWaveformState|undefined;
  loopPreview?:LoopPreviewControls|undefined;
  onApply:(loop:Loop)=>void;
}

type Draft = Record<keyof Loop,string>;
type Boundary = 'startSeconds'|'endSeconds';
type DecodedBounds = {sampleRate:number;length:number};

function toDraft(startSeconds:number,endSeconds:number,crossfadeSeconds:number):Draft {
  return {startSeconds:String(startSeconds),endSeconds:String(endSeconds),crossfadeSeconds:String(crossfadeSeconds)};
}

function validateDraft(draft:Draft,durationSeconds:number|undefined,decoded:DecodedBounds|undefined):Loop|string {
  const startSeconds = Number(draft.startSeconds);
  const endSeconds = Number(draft.endSeconds);
  const crossfadeSeconds = Number(draft.crossfadeSeconds);
  if (Object.values(draft).some(value=>!value.trim()) ||
    ![startSeconds,endSeconds,crossfadeSeconds].every(Number.isFinite) ||
    startSeconds < 0 || endSeconds <= startSeconds || crossfadeSeconds < 0) {
    return 'Use a start of zero or more, an end after the start, and a nonnegative crossfade.';
  }
  if (durationSeconds !== undefined && endSeconds > durationSeconds) return 'The loop must end within the recording.';
  if (crossfadeSeconds > (endSeconds - startSeconds) / 2) return 'Crossfade must be no more than half the loop length.';
  const loop = {startSeconds,endSeconds,crossfadeSeconds};
  if (decoded) {
    try {
      getLoopFrames(decoded,loop);
    } catch {
      return 'The loop must span at least one decoded sample and the crossfade must fit within half the decoded loop.';
    }
  }
  return loop;
}

function frameAt(value:string,decoded:DecodedBounds,fallback:number):number {
  const seconds = value.trim() ? Number(value) : NaN;
  return Number.isFinite(seconds) ? Math.max(0,Math.min(decoded.length,Math.round(seconds * decoded.sampleRate))) : fallback;
}

const PLOT_WIDTH = 1000;
const PLOT_HEIGHT = 100;

function peakPath({min,max}:LoopWaveform):string {
  const segments:string[] = [];
  for (let bin = 0; bin < min.length; bin++) {
    const x = ((bin + .5) / min.length * PLOT_WIDTH).toFixed(2);
    const top = ((1 - Math.min(1,max[bin]!)) * 48 + 2).toFixed(2);
    const bottom = ((1 - Math.max(-1,min[bin]!)) * 48 + 2).toFixed(2);
    segments.push(`M${x} ${top}V${bottom}`);
  }
  return segments.join(' ');
}

function WaveformHandle({label,frame,decoded,onChange,helpId}: {
  label:'Start'|'End';frame:number;decoded:DecodedBounds;onChange:(frame:number)=>void;helpId:string;
}) {
  const position = `${frame / decoded.length * 100}%`;
  const seconds = Number((frame / decoded.sampleRate).toFixed(6));
  return <div className="loop-waveform-handle">
    <input type="range" min={0} max={decoded.length} step={1} value={frame}
      aria-label={`Waveform ${label.toLowerCase()}`} aria-valuetext={`${seconds} seconds`} aria-describedby={helpId}
      onChange={event=>{
        if (!event.currentTarget.matches(':disabled')) onChange(event.currentTarget.valueAsNumber);
      }}/>
    <div className="loop-waveform-grip-track" aria-hidden="true">
      <span className="loop-waveform-grip" style={{'--handle-position':position} as CSSProperties}>{label}</span>
    </div>
  </div>;
}

function WaveformEditor({waveform,decoded,draft,onEdit}: {
  waveform:LoopWaveform;decoded:DecodedBounds;draft:Draft;onEdit:(draft:Draft)=>void;
}) {
  const helpId = useId();
  const path = useMemo(()=>peakPath(waveform),[waveform]);
  const startFrame = frameAt(draft.startSeconds,decoded,0);
  const endFrame = frameAt(draft.endSeconds,decoded,decoded.length);
  const fadeFrames = Math.min(frameAt(draft.crossfadeSeconds,decoded,0),Math.max(0,Math.floor((endFrame - startFrame) / 2)));
  const startX = startFrame / decoded.length * PLOT_WIDTH;
  const endX = endFrame / decoded.length * PLOT_WIDTH;
  const fadeWidth = fadeFrames / decoded.length * PLOT_WIDTH;

  const moveBoundary = (boundary:Boundary,frame:number) => {
    const nextFrame = boundary === 'startSeconds'
      ? Math.max(0,Math.min(frame,endFrame - 1))
      : Math.min(decoded.length,Math.max(frame,startFrame + 1));
    const next = {...draft,[boundary]:String(nextFrame / decoded.sampleRate)};
    const startSeconds = Number(next.startSeconds);
    const endSeconds = Number(next.endSeconds);
    const span = boundary === 'startSeconds' ? endFrame - nextFrame : nextFrame - startFrame;
    if (draft.startSeconds.trim() && draft.endSeconds.trim() && endSeconds > startSeconds && span > 0) {
      const limit = Math.min((endSeconds - startSeconds) / 2,Math.floor(span / 2) / decoded.sampleRate);
      if (Number(next.crossfadeSeconds) > limit) next.crossfadeSeconds = String(limit);
    }
    onEdit(next);
  };

  return <>
    <div className="loop-waveform" role="group" aria-label="Loop waveform">
      <svg viewBox={`0 0 ${PLOT_WIDTH} ${PLOT_HEIGHT}`} preserveAspectRatio="none" aria-hidden="true" focusable="false">
        <rect className="loop-waveform-selection" x={startX} width={Math.max(0,endX - startX)} height={PLOT_HEIGHT}/>
        <rect className="loop-waveform-overlap" x={startX} width={fadeWidth} height={PLOT_HEIGHT}/>
        <rect className="loop-waveform-overlap" x={endX - fadeWidth} width={fadeWidth} height={PLOT_HEIGHT}/>
        <path className="loop-waveform-axis" d={`M0 50H${PLOT_WIDTH}`} vectorEffect="non-scaling-stroke"/>
        <path className="loop-waveform-peaks" d={path} vectorEffect="non-scaling-stroke"/>
        <path className="loop-waveform-marker" d={`M${startX} 0V${PLOT_HEIGHT}M${endX} 0V${PLOT_HEIGHT}`} vectorEffect="non-scaling-stroke"/>
      </svg>
      <WaveformHandle label="Start" frame={startFrame} decoded={decoded} helpId={helpId} onChange={frame=>moveBoundary('startSeconds',frame)}/>
      <WaveformHandle label="End" frame={endFrame} decoded={decoded} helpId={helpId} onChange={frame=>moveBoundary('endSeconds',frame)}/>
    </div>
    <p className="loop-waveform-help" id={helpId}>Drag the handles to set the loop. Shaded edges show the crossfade.</p>
  </>;
}

export function LoopEditor({loop,open,durationSeconds,waveform,loopPreview,onApply}:LoopEditorProps) {
  const {startSeconds,endSeconds,crossfadeSeconds} = loop;
  const [draft,setDraft] = useState(()=>toDraft(startSeconds,endSeconds,crossfadeSeconds));
  const [error,setError] = useState('');
  const stopRef = useRef<(()=>void)|undefined>(undefined);
  const previewActive = loopPreview?.state.status === 'loading' || loopPreview?.state.status === 'playing';
  const recording = waveform?.status === 'ready' ? waveform.waveform : undefined;
  const sampleRate = waveform?.sampleRate ?? recording?.sampleRate;
  const frameCount = waveform?.frameCount ?? recording?.frameCount;
  const decoded = sampleRate && frameCount ? {sampleRate,length:frameCount} : undefined;
  const duration = decoded ? decoded.length / decoded.sampleRate : durationSeconds;

  useEffect(()=>{
    setDraft(toDraft(startSeconds,endSeconds,crossfadeSeconds));
    setError('');
  },[startSeconds,endSeconds,crossfadeSeconds]);

  useEffect(()=>{
    if (open) stopRef.current = previewActive ? loopPreview?.onStop : undefined;
  },[open,previewActive,loopPreview?.onStop]);

  useEffect(()=>{
    if (!open) return;
    return ()=>{stopRef.current?.();};
  },[open]);

  const edit = (next:Draft) => {
    if (previewActive) loopPreview?.onStop();
    setDraft(next);
    setError('');
  };

  const submit = (callback:(loop:Loop)=>void) => {
    const result = validateDraft(draft,duration,decoded);
    if (typeof result === 'string') setError(result);
    else {
      setError('');
      callback(result);
    }
  };

  return <div className="loop-editor" hidden={!open}>
    <p>{duration === undefined ? 'Recording duration unavailable.' : `Recording length: ${formatDuration(duration)}.`} Times below are in seconds.</p>
    {open && recording && decoded && <WaveformEditor waveform={recording} decoded={decoded} draft={draft} onEdit={edit}/>}
    {waveform?.status === 'loading' && <p role="status">Loading waveform…</p>}
    {waveform?.status === 'error' && <p role="status">Waveform unavailable. You can still enter loop times below.</p>}
    <div className="loop-fields">
      <label>Start<input aria-label="Loop start" type="number" inputMode="decimal" min="0" step="any" value={draft.startSeconds}
        onChange={event=>{if (!event.currentTarget.matches(':disabled')) edit({...draft,startSeconds:event.currentTarget.value});}}/></label>
      <label>End<input aria-label="Loop end" type="number" inputMode="decimal" min="0" max={duration} step="any" value={draft.endSeconds}
        onChange={event=>{if (!event.currentTarget.matches(':disabled')) edit({...draft,endSeconds:event.currentTarget.value});}}/></label>
      <label>Crossfade<input aria-label="Loop crossfade" type="number" inputMode="decimal" min="0" step="any" value={draft.crossfadeSeconds}
        onChange={event=>{if (!event.currentTarget.matches(':disabled')) edit({...draft,crossfadeSeconds:event.currentTarget.value});}}/></label>
    </div>
    <div className="loop-editor-actions">
      {loopPreview && <button type="button"
        disabled={!previewActive && (loopPreview.disabled || !decoded)}
        onClick={event=>{
          if (event.currentTarget.matches(':disabled')) return;
          if (previewActive) loopPreview.onStop();
          else submit(loopPreview.onPlay);
        }}>
        {previewActive ? <IconPlayerStop size={18} stroke={1.7} aria-hidden="true"/> : <IconPlayerPlay size={18} stroke={1.7} aria-hidden="true"/>}
        {previewActive ? 'Stop preview' : 'Preview join'}
      </button>}
      <button type="button" onClick={event=>{if (!event.currentTarget.matches(':disabled')) submit(onApply);}}>
        <IconRepeat size={18} stroke={1.7} aria-hidden="true"/>Apply loop
      </button>
    </div>
    {error && <p className="error loop-editor-error" role="alert">{error}</p>}
    {loopPreview?.state.status === 'loading' && <p role="status">Preparing join preview…</p>}
    {loopPreview?.state.status === 'error' && <p className="error loop-editor-error" role="alert">{loopPreview.state.error ?? 'Join preview unavailable.'}</p>}
    {loopPreview?.requiresPause && <p>Pause the mix to preview the join.</p>}
    <p>{loopPreview ? 'Preview uses the draft. ' : ''}Apply loop updates this layer. Save session keeps it for later.</p>
  </div>;
}
