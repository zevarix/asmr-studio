import {useEffect,useId,useRef,useState} from 'react';
import IconCheck from '@tabler/icons-react/icons/IconCheck';
import IconChevronRight from '@tabler/icons-react/icons/IconChevronRight';
import IconClock from '@tabler/icons-react/icons/IconClock';
import {defaultListeningTimer,listeningFadeError,type ListeningTimerSettings} from '@asmr-studio/contracts';
import type {PlaybackSnapshot} from '@asmr-studio/audio-engine';
import {formatTime} from './Transport.js';
import './ListeningTimerControls.css';

interface Props {
  value:ListeningTimerSettings|undefined;
  legacyDuration:number|null;
  playback:PlaybackSnapshot;
  onChange:(value:ListeningTimerSettings)=>void;
}
type Field='duration'|'fadeIn'|'fadeOut';
type Draft=Record<Field,string>;
const fields:Array<{key:Field;label:string}>=[
  {key:'duration',label:'Stop after (minutes)'},
  {key:'fadeIn',label:'Fade in (minutes)'},
  {key:'fadeOut',label:'Fade out (minutes)'},
];
function draftFor(settings:ListeningTimerSettings):Draft {
  return {duration:String(settings.durationSeconds/60),fadeIn:String(settings.fadeInSeconds/60),fadeOut:String(settings.fadeOutSeconds/60)};
}
function validate(draft:Draft,settings:ListeningTimerSettings):{value:ListeningTimerSettings|null;error:string;invalid:Field[]} {
  const seconds={} as Record<Field,number>;
  const accepted=draftFor(settings);
  const stored={duration:settings.durationSeconds,fadeIn:settings.fadeInSeconds,fadeOut:settings.fadeOutSeconds};
  for(const field of fields){
    // Converting an unchanged fractional second value to minutes and back can
    // change its last bit, turning a fade edit into an unintended duration edit.
    const value=draft[field.key]===accepted[field.key]?stored[field.key]:Number(draft[field.key])*60;
    if(!draft[field.key].trim()||!Number.isFinite(value))return {value:null,error:'Enter a number for '+field.label.toLowerCase()+'.',invalid:[field.key]};
    if(field.key==='duration'&&value<=0)return {value:null,error:'Stop after must be greater than zero.',invalid:['duration']};
    if(value<0)return {value:null,error:'Fade durations must be zero or more.',invalid:[field.key]};
    seconds[field.key]=value;
  }
  const value={...settings,durationSeconds:seconds.duration,fadeInSeconds:seconds.fadeIn,fadeOutSeconds:seconds.fadeOut};
  const error=listeningFadeError(value,value.durationSeconds);
  return error?{value:null,error,invalid:['duration','fadeIn','fadeOut']}:{value,error:'',invalid:[]};
}

/** Numeric drafts are applied together; playback updates never edit the saved recipe. */
export function ListeningTimerControls({value,legacyDuration,playback,onChange}:Props){
  const settings=value??(legacyDuration===null||!Number.isFinite(legacyDuration)||legacyDuration<=0?defaultListeningTimer():{
    enabled:true,durationSeconds:legacyDuration,fadeInSeconds:0,fadeOutSeconds:0,
  });
  const [draft,setDraft]=useState<Draft>(()=>draftFor(settings));
  const [error,setError]=useState('');
  const applyButton=useRef<HTMLButtonElement>(null);
  const id=useId(),helpId=id+'-help',errorId=id+'-error';
  useEffect(()=>{setDraft(draftFor(settings));setError('');},[settings.enabled,settings.durationSeconds,settings.fadeInSeconds,settings.fadeOutSeconds]);
  const accepted=draftFor(settings);
  const dirty=fields.some(field=>draft[field.key]!==accepted[field.key]);
  const checked=validate(draft,settings);
  const remaining=playback.listeningTimer?.remainingSeconds??Math.max(0,settings.durationSeconds-playback.positionSeconds);
  const phase=playback.listeningTimer?.phase;
  const phaseText=phase==='finished'?'Finished':playback.state==='paused'?'Paused':playback.state==='interrupted'?'Interrupted'
    :playback.state==='playing'&&phase==='fading-in'?'Fading in':playback.state==='playing'&&phase==='fading-out'?'Fading out':'';
  const apply=()=>{
    if(applyButton.current?.matches(':disabled')||!settings.enabled||!dirty)return;
    if(!checked.value){setError(checked.error);return;}
    setError('');onChange(checked.value);
  };
  return <details className="listening-timer">
    <summary><span className="summary-label"><IconClock size={18} stroke={1.7} aria-hidden="true"/>Listening timer</span>
      <span className="timer-summary" aria-live="off">{settings.enabled?<><span role="timer" aria-label="Time remaining" aria-live="off">{formatTime(Math.ceil(remaining))}</span> remaining{phaseText?' · '+phaseText:''}</>:'Off'}</span>
      <IconChevronRight className="summary-chevron" size={18} stroke={1.7} aria-hidden="true"/>
    </summary>
    <fieldset className="timer-settings" aria-label="Listening timer settings">
      <label className="timer-mode" htmlFor={id+'-mode'}><span>Timer</span><select id={id+'-mode'} aria-label="Listening timer mode" value={settings.enabled?'on':'off'}
        onChange={event=>{
          if(event.currentTarget.matches(':disabled'))return;
          const mode=event.currentTarget.value;
          if((mode==='on'||mode==='off')&&(mode==='on')!==settings.enabled)onChange({...settings,enabled:mode==='on'});
        }}><option value="off">Off</option><option value="on">On</option></select></label>
      <form noValidate onSubmit={event=>{event.preventDefault();apply();}}>
        <div className="timer-fields">{fields.map(field=><label key={field.key} htmlFor={id+'-'+field.key}>{field.label}
          <input id={id+'-'+field.key} type="number" step="any" min={0} value={draft[field.key]} disabled={!settings.enabled}
            aria-invalid={error&&checked.invalid.includes(field.key)?true:undefined} aria-describedby={error?helpId+' '+errorId:helpId}
            onChange={event=>{
              if(event.currentTarget.matches(':disabled'))return;
              const next=event.currentTarget.value;setDraft(previous=>({...previous,[field.key]:next}));setError('');
            }}
            onKeyDown={event=>{
              if(event.currentTarget.matches(':disabled'))return;
              if(event.key==='Enter'){event.preventDefault();apply();}
            }}/>
        </label>)}</div>
        <p className="timer-help" id={helpId}>Use fractions for shorter fades: 0.5 minutes is 30 seconds. Pause holds the timer; Stop starts it over on your next play.</p>
        <div className="timer-actions"><button ref={applyButton} type="submit" disabled={!settings.enabled||!dirty}><IconCheck size={18} stroke={1.7} aria-hidden="true"/>Apply timer</button>
          {dirty&&settings.enabled&&<span>Apply changes to update the timer.</span>}</div>
        {dirty&&checked.value&&playback.state==='playing'&&checked.value.durationSeconds<=playback.positionSeconds&&
          <p className="timer-help">That stop time has already passed. Applying it will end this playback with a short fade.</p>}
        {error&&<p className="error" id={errorId} role="alert">{error}</p>}
      </form>
    </fieldset>
  </details>;
}
