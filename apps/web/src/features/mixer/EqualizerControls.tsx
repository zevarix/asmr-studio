import {useEffect,useId,useRef,type PointerEvent} from 'react';
import IconPower from '@tabler/icons-react/icons/IconPower';
import IconRefresh from '@tabler/icons-react/icons/IconRefresh';
import {EQ_MAX_DB,EQ_MIN_DB,flatEqualizer,type EqualizerSettings} from '@asmr-studio/contracts';
import './EqualizerControls.css';

type BandKey = 'bassDb'|'midDb'|'trebleDb';
const bands = [
  {key:'bassDb',label:'Bass',hint:'Warmth'},
  {key:'midDb',label:'Mid',hint:'Detail'},
  {key:'trebleDb',label:'Treble',hint:'Air'},
] as const;
const STEP_DB = 0.5;
const SWEEP_DEGREES = 270;
const SWEEP_RADIANS = SWEEP_DEGREES * Math.PI / 180;
const CENTER_RADIUS = 6;

export interface EqualizerControlsProps {
  value:EqualizerSettings|undefined;
  onChange:(value:EqualizerSettings)=>void;
  label:string;
  disabled?:boolean;
  compact?:boolean;
  hideTitle?:boolean;
}

function unavailable(element:HTMLInputElement|HTMLButtonElement,disabled:boolean):boolean {
  return disabled || element.matches(':disabled');
}

function snappedDb(value:number):number {
  const next = Math.max(EQ_MIN_DB,Math.min(EQ_MAX_DB,Math.round(value / STEP_DB) * STEP_DB));
  return next === 0 ? 0 : next;
}

function signedValue(value:number):string {
  return (value > 0 ? '+' : '') + Number(value.toFixed(1));
}

interface Drag {
  pointerId:number;
  centerX:number;
  centerY:number;
  lastX:number;
  lastY:number;
  lastAngle:number|null;
  position:number;
  lastValue:number;
  element:HTMLInputElement;
}

function pointerAngle(event:PointerEvent<HTMLInputElement>,centerX:number,centerY:number):number|null {
  const x = event.clientX - centerX, y = event.clientY - centerY;
  // Near the center, tiny pointer movements would otherwise produce large turns.
  if (x * x + y * y < CENTER_RADIUS * CENTER_RADIUS) return null;
  return Math.atan2(x,-y);
}

function crossesCenter(current:Drag,event:PointerEvent<HTMLInputElement>):boolean {
  const x = current.lastX - current.centerX, y = current.lastY - current.centerY;
  const dx = event.clientX - current.lastX, dy = event.clientY - current.lastY;
  const distanceSquared = dx * dx + dy * dy;
  const along = distanceSquared === 0 ? 0 : Math.max(0,Math.min(1,-(x * dx + y * dy) / distanceSquared));
  return Math.hypot(x + along * dx,y + along * dy) < CENTER_RADIUS;
}

function EqualizerKnob({band,value,onChange,label,disabled,helpId}:{
  band:typeof bands[number];value:number;onChange:(value:number)=>void;label:string;disabled:boolean;helpId:string;
}) {
  const id = useId();
  const input = useRef<HTMLInputElement>(null);
  const drag = useRef<Drag|null>(null);
  const rotation = -SWEEP_DEGREES / 2 + (value - EQ_MIN_DB) / (EQ_MAX_DB - EQ_MIN_DB) * SWEEP_DEGREES;

  const finishDrag = () => {
    const current = drag.current;
    drag.current = null;
    if (current?.element.hasPointerCapture(current.pointerId)) current.element.releasePointerCapture(current.pointerId);
  };

  useEffect(() => {
    const element = input.current;
    if (!element) return;
    // A native focused range can react to a wheel in some browsers. Leave it unchanged.
    const ignoreWheel = (event:WheelEvent) => {if (!element.matches(':disabled')) event.preventDefault();};
    element.addEventListener('wheel',ignoreWheel,{passive:false});
    return () => {element.removeEventListener('wheel',ignoreWheel); finishDrag();};
  },[]);

  useEffect(() => {
    // A containing fieldset may become disabled without changing this control's props.
    if (disabled || input.current?.matches(':disabled')) finishDrag();
  });

  const updateDrag = (event:PointerEvent<HTMLInputElement>) => {
    const current = drag.current;
    if (!current || current.pointerId !== event.pointerId) return;
    if (unavailable(event.currentTarget,disabled)) {finishDrag(); return;}
    const angle = pointerAngle(event,current.centerX,current.centerY);
    const previous = current.lastAngle;
    // Fast strokes can pass through the center without an event inside the dead zone.
    const crossedCenter = crossesCenter(current,event);
    current.lastAngle = angle;
    current.lastX = event.clientX; current.lastY = event.clientY;
    if (angle === null || previous === null || crossedCenter) return;
    let turn = angle - previous;
    // Crossing the bottom of the dial is a small turn, not a full revolution.
    if (turn > Math.PI) turn -= Math.PI * 2;
    if (turn < -Math.PI) turn += Math.PI * 2;
    // Keep fractional motion, but discard overshoot so reversing at a limit responds immediately.
    current.position = Math.max(EQ_MIN_DB,Math.min(EQ_MAX_DB,
      current.position + turn / SWEEP_RADIANS * (EQ_MAX_DB - EQ_MIN_DB)));
    const next = snappedDb(current.position);
    if (next !== current.lastValue) {current.lastValue = next; onChange(next);}
  };

  return <div className="eq-band">
    <label className="eq-band-label" htmlFor={id}>{band.label}</label>
    <div className="eq-knob">
      <input ref={input} id={id} className="eq-knob-input" type="range" min={EQ_MIN_DB} max={EQ_MAX_DB} step={STEP_DB}
        value={value} disabled={disabled} aria-label={`${label} ${band.label}`} aria-valuetext={`${signedValue(value)} decibels`}
        aria-describedby={`${id}-hint ${helpId}`}
        onChange={event => {
          if (unavailable(event.currentTarget,disabled)) return;
          finishDrag();
          const next = event.currentTarget.valueAsNumber;
          if (Number.isFinite(next) && next !== value) onChange(snappedDb(next));
        }}
        onPointerDown={event => {
          if (unavailable(event.currentTarget,disabled)) return;
          // Prevent the native horizontal track from jumping to the pointer's X position.
          event.preventDefault();
          if (event.button !== 0 || !event.isPrimary || drag.current) return;
          event.currentTarget.focus({preventScroll:true});
          event.currentTarget.setPointerCapture(event.pointerId);
          const bounds = event.currentTarget.getBoundingClientRect();
          const centerX = bounds.left + bounds.width / 2, centerY = bounds.top + bounds.height / 2;
          drag.current = {pointerId:event.pointerId,centerX,centerY,lastAngle:pointerAngle(event,centerX,centerY),
            lastX:event.clientX,lastY:event.clientY,position:value,lastValue:value,element:event.currentTarget};
        }}
        onPointerMove={updateDrag}
        onPointerUp={event => {
          if (drag.current?.pointerId !== event.pointerId) return;
          updateDrag(event); finishDrag();
        }}
        onPointerCancel={event => {if (drag.current?.pointerId === event.pointerId) finishDrag();}}
        onLostPointerCapture={event => {if (drag.current?.pointerId === event.pointerId) drag.current = null;}}
        onBlur={finishDrag}
        onDoubleClick={event => {
          if (unavailable(event.currentTarget,disabled)) return;
          event.preventDefault(); finishDrag();
          if (value !== 0) onChange(0);
        }}/>
      <svg className="eq-knob-visual" viewBox="0 0 72 72" aria-hidden="true" focusable="false" fill="none">
        <path className="eq-knob-arc" d="M 11.958 60.042 A 34 34 0 1 1 60.042 60.042"/>
        <path className="eq-knob-neutral" d="M 36 -4 V -1"/>
        <path className="eq-knob-indicator" d="M 36 32 V 7" transform={`rotate(${rotation} 36 36)`}/>
      </svg>
    </div>
    <output className="eq-value" htmlFor={id} aria-hidden="true">{signedValue(value)} dB</output>
    <span className="eq-band-hint" id={`${id}-hint`}>{band.hint}</span>
  </div>;
}

/** Controlled tone settings only; playback and persistence remain with the owning scene. */
export function EqualizerControls({value,onChange,label,disabled=false,compact=false,hideTitle=false}:EqualizerControlsProps) {
  const settings = value ?? flatEqualizer();
  const helpId = useId();
  const updateBand = (key:BandKey,next:number) => {
    if (settings[key] !== next) onChange({...settings,[key]:next});
  };

  return <fieldset className={'eq-controls' + (compact ? ' eq-controls--compact' : '') + (settings.bypassed ? ' eq-controls--bypassed' : '')}
    aria-label={label} disabled={disabled}>
    <div className={'eq-header' + (hideTitle ? ' eq-header--actions-only' : '')}>
      {!hideTitle && <div className="eq-heading"><h3 className="eq-title">{compact ? 'Equalizer' : 'Master equalizer'}</h3>
        {!compact && <p className="eq-subtitle">Tone for the whole mix</p>}</div>}
      <div className="eq-actions">
        <button type="button" onClick={event => {
          if (unavailable(event.currentTarget,disabled)) return;
          if (settings.bassDb !== 0 || settings.midDb !== 0 || settings.trebleDb !== 0 || settings.bypassed) onChange(flatEqualizer());
        }}><IconRefresh size={16} stroke={1.7} aria-hidden="true" focusable="false"/>Reset</button>
        <button type="button" aria-pressed={settings.bypassed} onClick={event => {
          if (!unavailable(event.currentTarget,disabled)) onChange({...settings,bypassed:!settings.bypassed});
        }}><IconPower size={16} stroke={1.7} aria-hidden="true" focusable="false"/>Bypass</button>
      </div>
    </div>
    <div className="eq-bands">{bands.map(band => <EqualizerKnob key={band.key} band={band} value={settings[band.key]}
      onChange={next => updateBand(band.key,next)} label={label} disabled={disabled || settings.bypassed} helpId={helpId}/>)}</div>
    <p className="eq-help" id={helpId}>Drag around the knob. Double-click to reset.
      <span className="eq-sr-only"> Use the arrow keys to adjust by 0.5 decibels. Home and End choose the limits.</span></p>
  </fieldset>;
}
