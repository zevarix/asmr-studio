import {useEffect,useId,useState} from 'react';
import IconArrowsLeftRight from '@tabler/icons-react/icons/IconArrowsLeftRight';
import IconChevronRight from '@tabler/icons-react/icons/IconChevronRight';
import {defaultStereoMovement,STEREO_MOVEMENT_MIN_CYCLE_SECONDS,STEREO_MOVEMENT_MAX_CYCLE_SECONDS,type StereoMovementSettings} from '@asmr-studio/contracts';
import {RangeInput} from './RangeInput.js';
import './MovementControls.css';

export interface MovementControlsProps {
  value:StereoMovementSettings|undefined;
  center:number;
  label:string;
  onChange:(value:StereoMovementSettings)=>void;
  disabled?:boolean;
}

function percent(value:number):string {return Number((value*100).toFixed(1))+'%';}
function position(value:number):string {
  const amount=Number((Math.abs(value)*100).toFixed(1));
  return amount===0?'Center':(value<0?'Left ':'Right ')+amount+'%';
}

/** Saved controls only. The audio engine owns movement timing. */
export function MovementControls({value,center,label,onChange,disabled=false}:MovementControlsProps) {
  const settings=value??defaultStereoMovement();
  const [cycleDraft,setCycleDraft]=useState(String(settings.cycleSeconds));
  const modeId=useId(),widthId=useId(),cycleId=useId(),travelId=useId(),cycleHintId=useId();
  useEffect(()=>setCycleDraft(String(settings.cycleSeconds)),[settings.cycleSeconds,settings.enabled]);
  const cycle=Number(cycleDraft);
  const cycleValid=cycleDraft.trim()!==''&&Number.isFinite(cycle)
    &&cycle>=STEREO_MOVEMENT_MIN_CYCLE_SECONDS&&cycle<=STEREO_MOVEMENT_MAX_CYCLE_SECONDS;
  const radius=Math.min(settings.width,Math.max(0,1-Math.abs(center)));
  const constrained=radius+1e-9<settings.width;
  const summary=settings.enabled?`Sway · ${percent(settings.width)} · ${Number(settings.cycleSeconds.toFixed(2))} s`:'Off';
  const travel=!settings.enabled?'Sway moves around the stereo position.'
    :settings.width===0?'Width is zero; the stereo position stays fixed.'
    :radius===0?'Move the stereo position away from the edge to hear sway.'
    :`Travel: ${position(center-radius)} to ${position(center+radius)}.`;

  return <details className="layer-movement">
    <summary><span className="summary-label"><IconArrowsLeftRight size={18} stroke={1.7} aria-hidden="true"/>Movement</span>
      <span className="movement-state">{summary}</span><IconChevronRight className="summary-chevron" size={18} stroke={1.7} aria-hidden="true"/>
    </summary>
    <fieldset className="movement-controls" aria-label={label} disabled={disabled}>
      <label className="movement-choice" htmlFor={modeId}><span>Mode</span>
        <select id={modeId} aria-label="Movement mode" value={settings.enabled?'sway':'off'}
          onChange={event=>{
            if(event.currentTarget.matches(':disabled'))return;
            const next=event.currentTarget.value;
            if((next==='sway'||next==='off')&&(next==='sway')!==settings.enabled)onChange({...settings,enabled:next==='sway'});
          }}><option value="off">Off</option><option value="sway">Sway</option></select>
      </label>
      <div className="movement-width">
        <label className="movement-setting-label" htmlFor={widthId}><span>Width</span><span aria-hidden="true">{percent(settings.width)}</span></label>
        <RangeInput id={widthId} aria-label="Width" aria-valuetext={`${Number((settings.width*100).toFixed(1))} percent width`}
          aria-describedby={travelId} min={0} max={100} step={1} value={settings.width*100} disabled={!settings.enabled}
          onChange={event=>{
            if(event.currentTarget.matches(':disabled'))return;
            const next=event.currentTarget.valueAsNumber/100;
            if(Number.isFinite(next)&&next!==settings.width)onChange({...settings,width:next});
          }}/>
      </div>
      <div className="movement-cycle">
        <label htmlFor={cycleId}>Cycle time</label>
        <div className="movement-cycle-input"><input id={cycleId} type="number" aria-label="Cycle time"
          min={STEREO_MOVEMENT_MIN_CYCLE_SECONDS} max={STEREO_MOVEMENT_MAX_CYCLE_SECONDS} step="any"
          value={cycleDraft} disabled={!settings.enabled} aria-invalid={cycleDraft!==''&&!cycleValid?true:undefined}
          aria-valuetext={cycleValid?`${cycle} seconds per cycle`:undefined} aria-describedby={cycleHintId}
          onChange={event=>{
            if(event.currentTarget.matches(':disabled'))return;
            const draft=event.currentTarget.value,next=event.currentTarget.valueAsNumber;
            setCycleDraft(draft);
            if(Number.isFinite(next)&&next>=STEREO_MOVEMENT_MIN_CYCLE_SECONDS&&next<=STEREO_MOVEMENT_MAX_CYCLE_SECONDS&&next!==settings.cycleSeconds)
              onChange({...settings,cycleSeconds:next});
          }}
          onBlur={()=>setCycleDraft(String(settings.cycleSeconds))}
          onKeyDown={event=>{
            if(event.currentTarget.matches(':disabled'))return;
            // step="any" keeps saved fractional cycles valid. Give arrow keys a one-second edit.
            if(event.key==='ArrowUp'||event.key==='ArrowDown'){
              event.preventDefault();
              const next=Math.max(STEREO_MOVEMENT_MIN_CYCLE_SECONDS,Math.min(STEREO_MOVEMENT_MAX_CYCLE_SECONDS,
                (cycleValid?cycle:settings.cycleSeconds)+(event.key==='ArrowUp'?1:-1)));
              setCycleDraft(String(next));
              if(next!==settings.cycleSeconds)onChange({...settings,cycleSeconds:next});
            }else if(event.key==='Enter'){event.preventDefault();event.currentTarget.blur();}
          }}/>
          <span aria-hidden="true">seconds</span>
        </div>
      </div>
      <p className="movement-hint" id={cycleHintId}>{STEREO_MOVEMENT_MIN_CYCLE_SECONDS}–{STEREO_MOVEMENT_MAX_CYCLE_SECONDS} seconds for one round trip.</p>
      <p className="movement-travel" id={travelId}>{travel}</p>
      {settings.enabled&&radius>0&&constrained&&<p className="movement-hint">Width is limited by the stereo position.</p>}
    </fieldset>
  </details>;
}
