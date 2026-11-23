import {useEffect,useId,useState,type CSSProperties} from 'react';
import IconPower from '@tabler/icons-react/icons/IconPower';
import IconRefresh from '@tabler/icons-react/icons/IconRefresh';
import {OUTPUT_LIMITER_MIN_DB,OUTPUT_LIMITER_MAX_DB,defaultOutputLimiter,type OutputLimiterSettings} from '@asmr-studio/contracts';
import {emptyOutputMeterSnapshot,type Mixer,type OutputMeterSnapshot} from '@asmr-studio/audio-engine';
import {RangeInput} from './RangeInput.js';
import './OutputControls.css';

export type OutputMeterSource=Pick<Mixer,'subscribeOutput'|'resetOutputPeaks'>;
export interface OutputControlsProps {
  value:OutputLimiterSettings|undefined;
  onChange:(value:OutputLimiterSettings)=>void;
  meterSource?:OutputMeterSource|null;
}

const floorDb=-60;

function decibels(value:number):number {
  return value>0&&Number.isFinite(value)?20*Math.log10(value):-Infinity;
}

function dbText(value:number):string {
  if(!Number.isFinite(value))return '−∞';
  const rounded=Number(value.toFixed(1));
  return (rounded<0?'−':rounded>0?'+':'')+Math.abs(rounded).toFixed(1);
}

function meterValue(value:number):number {
  return Math.max(floorDb,Math.min(0,decibels(value)));
}

function OutputChannel({name,letter,peak,heldPeak,clipped}:{
  name:'Left'|'Right';letter:'L'|'R';peak:number;heldPeak:number;clipped:boolean;
}) {
  const value=meterValue(peak);
  const held=decibels(heldPeak);
  const level=(value-floorDb)/-floorDb*100;
  const marker=(meterValue(heldPeak)-floorDb)/-floorDb*100;
  return <div className={'output-channel'+(clipped?' output-channel--full-scale':'')}>
    <span className="output-channel-letter" aria-hidden="true">{letter}</span>
    <div className="output-meter-well">
      <div className="output-meter-track">
        <meter min={floorDb} max={0} low={-12} high={-3} optimum={-24} value={value}
          aria-label={`${name} output level`}
          aria-valuetext={`${dbText(decibels(peak))} decibels full scale; held peak ${dbText(held)} decibels full scale`}/>
        <span className="output-meter-lights" aria-hidden="true" style={{'--meter-level':`${level}%`} as CSSProperties}/>
        {heldPeak>0&&<span className="output-held-marker" aria-hidden="true" style={{'--peak-position':`${marker}%`} as CSSProperties}/>}
      </div>
    </div>
    <span className="output-peak-value" aria-label={`${name} held peak`}>{dbText(held)}<span className="output-unit"> dBFS</span></span>
  </div>;
}

/** Meter subscription is local to this panel; no meter frame edits a scene or rerenders the app. */
export function OutputControls({value,onChange,meterSource=null}:OutputControlsProps) {
  const settings=value??defaultOutputLimiter();
  const [snapshot,setSnapshot]=useState<OutputMeterSnapshot>(emptyOutputMeterSnapshot);
  const ceilingId=useId();
  const helpId=useId();
  useEffect(()=>{
    let active=true;
    setSnapshot(emptyOutputMeterSnapshot());
    const unsubscribe=meterSource?.subscribeOutput(next=>{if(active)setSnapshot(next);});
    return()=>{active=false;unsubscribe?.();};
  },[meterSource]);
  const meter=snapshot.available?snapshot:emptyOutputMeterSnapshot();
  const clipped=meter.clipped.some(Boolean);

  return <fieldset className="output-controls" aria-label="Output levels">
    <div className="output-heading">
      <div><h3>Output</h3><p>Final stereo levels</p></div>
      <button type="button" className="output-reset" disabled={!meterSource||!snapshot.available}
        onClick={event=>{if(!event.currentTarget.matches(':disabled'))meterSource?.resetOutputPeaks();}}>
        <IconRefresh size={16} stroke={1.7} aria-hidden="true"/>Reset peaks
      </button>
    </div>
    <div className="output-body">
      <div className="output-levels" aria-live="off">
        <div className="output-meter-labels"><span>Stereo sample peaks</span><span>Held peak</span></div>
        <OutputChannel name="Left" letter="L" peak={meter.peak[0]} heldPeak={meter.heldPeak[0]} clipped={meter.clipped[0]}/>
        <OutputChannel name="Right" letter="R" peak={meter.peak[1]} heldPeak={meter.heldPeak[1]} clipped={meter.clipped[1]}/>
        <div className="output-meter-scale" aria-hidden="true"><span>−60</span><span>−36</span><span>−24</span><span>−12</span><span>0</span></div>
        <div className="output-reading-notes">
          <span className={clipped?'output-clipped':''}>{clipped?'Full scale reached':snapshot.available?'Below full scale':'Start listening to see levels.'}</span>
          <span>Reduction <span className="output-reduction-value" aria-label="Gain reduction">{Math.max(0,meter.gainReductionDb).toFixed(1)} dB</span></span>
        </div>
      </div>
      <div className="output-limiter">
        <button type="button" aria-label="Peak limiter" className="output-limiter-toggle" aria-pressed={settings.enabled} aria-describedby={helpId}
          onClick={event=>{if(!event.currentTarget.matches(':disabled'))onChange({...settings,enabled:!settings.enabled});}}>
          <IconPower size={17} stroke={1.7} aria-hidden="true"/>Peak limiter<span className="output-limiter-state" aria-hidden="true">{settings.enabled?'On':'Off'}</span>
        </button>
        <label className="output-ceiling" htmlFor={ceilingId}><span>Output ceiling</span><span className="output-ceiling-value" aria-hidden="true">{dbText(settings.ceilingDb)} dBFS</span></label>
        <RangeInput id={ceilingId} aria-label="Output ceiling" min={OUTPUT_LIMITER_MIN_DB} max={OUTPUT_LIMITER_MAX_DB}
          step={0.1} value={settings.ceilingDb} disabled={!settings.enabled} aria-valuetext={`${dbText(settings.ceilingDb)} decibels full scale`}
          onChange={event=>{
            if(event.currentTarget.matches(':disabled'))return;
            const next=event.currentTarget.valueAsNumber;
            if(Number.isFinite(next)&&next!==settings.ceilingDb)onChange({...settings,ceilingDb:next});
          }}/>
        <p className="output-help" id={helpId}>Sample-peak limiting. No makeup gain.</p>
      </div>
    </div>
    {snapshot.error&&<p className="error output-error" role="alert">{snapshot.error}</p>}
  </fieldset>;
}
