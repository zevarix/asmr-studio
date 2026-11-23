import {useState} from 'react';
import IconAdjustmentsHorizontal from '@tabler/icons-react/icons/IconAdjustmentsHorizontal';
import IconChevronRight from '@tabler/icons-react/icons/IconChevronRight';
import IconHeadphones from '@tabler/icons-react/icons/IconHeadphones';
import IconRepeat from '@tabler/icons-react/icons/IconRepeat';
import IconVolumeOff from '@tabler/icons-react/icons/IconVolumeOff';
import IconX from '@tabler/icons-react/icons/IconX';
import type {AssetRecord,Layer,SceneCommand} from '@asmr-studio/contracts';
import {defaultLoop,roleNames} from './sound-utils.js';
import {RangeInput} from './RangeInput.js';
import {SoundIcon} from './SoundIcon.js';
import {EqualizerControls} from './EqualizerControls.js';
import {MovementControls} from './MovementControls.js';
import {OccasionalControls} from './OccasionalControls.js';
import {LoopEditor,type LoopPreviewControls,type LoopWaveformState} from './LoopEditor.js';

interface Props {
  layer:Layer;
  assets?:AssetRecord[];
  label?:string;
  durationSeconds?:number|undefined;
  onCommand:(command:SceneCommand)=>void;
  loopEditorOpen?:boolean|undefined;
  onLoopEditorOpenChange?:((open:boolean)=>void)|undefined;
  waveform?:LoopWaveformState|undefined;
  loopPreview?:LoopPreviewControls|undefined;
}

function LoopControls({layer,durationSeconds,onCommand,loopEditorOpen,onLoopEditorOpenChange,waveform,loopPreview}:Omit<Props,'label'>) {
  const [localOpen,setLocalOpen] = useState(false);
  const open = loopEditorOpen ?? localOpen;
  const setOpen = (next:boolean) => {
    if (loopEditorOpen === undefined) setLocalOpen(next);
    onLoopEditorOpenChange?.(next);
  };
  return <div className="loop-controls">
    <div className="loop-mode"><label><input type="checkbox" aria-label="Loop" checked={layer.loop!==null}
      disabled={layer.loop===null&&durationSeconds===undefined}
      onChange={event=>{
        if (event.currentTarget.matches(':disabled')) return;
        if (!event.currentTarget.checked && open) setOpen(false);
        onCommand({type:'setLayerLoop',layerId:layer.id,loop:event.target.checked?defaultLoop(durationSeconds!):null});
      }}/>Loop continuously</label><span>{layer.loop?'Looping':'Play once'}</span></div>
    {layer.loop&&<details className="loop-details" open={open}>
      <summary onClick={event=>{event.preventDefault();setOpen(!open);}}>
        <span className="summary-label"><IconRepeat size={18} stroke={1.7} aria-hidden="true"/>Loop details</span>
        <IconChevronRight className="summary-chevron" size={18} stroke={1.7} aria-hidden="true"/>
      </summary>
      <LoopEditor key={JSON.stringify([layer.id,layer.assetId])} loop={layer.loop} open={open} durationSeconds={durationSeconds}
        waveform={waveform} loopPreview={loopPreview} onApply={loop=>onCommand({type:'setLayerLoop',layerId:layer.id,loop})}/>
    </details>}
  </div>;
}

export function LayerControls({layer,assets=[],label,durationSeconds,onCommand,loopEditorOpen,onLoopEditorOpenChange,waveform,loopPreview}:Props) {
  const equalizer=layer.equalizer;
  const toneState=equalizer?.bypassed?'Bypassed':equalizer&&(equalizer.bassDb!==0||equalizer.midDb!==0||equalizer.trebleDb!==0)?'Adjusted':'Flat';
  const panPercent=Math.round(layer.pan*100);
  const panText=layer.pan===0?'Center':layer.pan<0?'Left '+Math.round(-layer.pan*100)+'%':'Right '+Math.round(layer.pan*100)+'%';
  return <fieldset className="layer" aria-label={roleNames[layer.role]+': '+layer.id}>
    <div className="layer-heading"><SoundIcon name={label??layer.id} role={layer.role}/><span className="layer-title"><strong>{label??layer.id}</strong><span className="layer-kind">{roleNames[layer.role]}</span></span></div>
    <label className="level">
      <span>Volume</span>
      <RangeInput aria-label="Volume" min="0" max="100" step="1" value={Math.round(layer.gain*100)}
        onChange={event=>onCommand({type:'setLayerGain',layerId:layer.id,gain:Number(event.target.value)/100})}/>
      <span className="readout">{Math.round(layer.gain*100)}%</span>
    </label>
    <div className="layer-tools">
      <button type="button" aria-pressed={layer.muted} onClick={()=>onCommand({type:'setMuted',layerId:layer.id,muted:!layer.muted})}><IconVolumeOff size={18} stroke={1.7} aria-hidden="true"/>Mute</button>
      <button type="button" aria-pressed={layer.solo} onClick={()=>onCommand({type:'setSolo',layerId:layer.id,solo:!layer.solo})}><IconHeadphones size={18} stroke={1.7} aria-hidden="true"/>Solo</button>
      <button type="button" onClick={()=>onCommand({type:'removeLayer',layerId:layer.id})}><IconX size={18} stroke={1.7} aria-hidden="true"/>Remove</button>
    </div>
    <label className="level">
      <span>Stereo position</span>
      <span className="pan-control">
        <RangeInput variant="pan" aria-label="Stereo position" min="-100" max="100" step="1" value={panPercent}
          aria-valuetext={panText.replace('%',' percent')}
          onChange={event=>onCommand({type:'setLayerPan',layerId:layer.id,pan:Number(event.target.value)/100})}/>
        <span className="pan-scale" aria-hidden="true"><span>L</span><span>Center</span><span>R</span></span>
      </span>
      <span className="readout">{panText}</span>
    </label>
    <MovementControls value={layer.movement} center={layer.pan} label={(label??layer.id)+' movement'}
      onChange={movement=>onCommand({type:'setLayerMovement',layerId:layer.id,movement})}/>
    <details className="layer-equalizer"><summary><span className="summary-label"><IconAdjustmentsHorizontal size={18} stroke={1.7} aria-hidden="true"/>Equalizer</span>
      <span className="equalizer-state">{toneState}</span><IconChevronRight className="summary-chevron" size={18} stroke={1.7} aria-hidden="true"/></summary>
      <EqualizerControls compact hideTitle label={(label??layer.id)+' equalizer'} value={equalizer}
        onChange={next=>onCommand({type:'setLayerEqualizer',layerId:layer.id,equalizer:next})}/>
    </details>
    <OccasionalControls layer={layer} assets={assets} label={(label??layer.id)+' occasional playback'}
      onChange={occasional=>onCommand({type:'setLayerOccasional',layerId:layer.id,occasional})}/>
    {!layer.occasional?.enabled&&<LoopControls layer={layer} durationSeconds={durationSeconds} onCommand={onCommand} loopEditorOpen={loopEditorOpen}
      onLoopEditorOpenChange={onLoopEditorOpenChange} waveform={waveform} loopPreview={loopPreview}/>}
  </fieldset>;
}
