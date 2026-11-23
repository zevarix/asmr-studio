import {useEffect,useId,useState,type ReactNode} from 'react';
import {sceneLayerCount,transitionBlendAt,type CapturedMix,type Scene,type SceneCommand} from '@asmr-studio/contracts';
import type {PlaybackSnapshot} from '@asmr-studio/audio-engine';
import IconArrowRight from '@tabler/icons-react/icons/IconArrowRight';
import IconPlayerStop from '@tabler/icons-react/icons/IconPlayerStop';
import IconRefresh from '@tabler/icons-react/icons/IconRefresh';
import IconVolume from '@tabler/icons-react/icons/IconVolume';
import IconX from '@tabler/icons-react/icons/IconX';
import type {SceneSummary} from '../../api.js';
import {OutputControls,type OutputMeterSource} from './OutputControls.js';
import {RangeInput} from './RangeInput.js';
import {SessionName} from './SessionName.js';
import {Transport,formatTime} from './Transport.js';
import {AppearanceControls} from '../appearance/AppearanceControls.js';
import './TransitionView.css';

export type TransitionDeck='a'|'b';
export interface DeckLoadState {
  loading:boolean;
  requestedId:string|null;
  error:string|null;
}
export interface TransitionViewProps {
  scene:Scene;
  savedScenes:SceneSummary[];
  deckStates:Record<TransitionDeck,DeckLoadState>;
  playback:PlaybackSnapshot;
  outputMeterSource:OutputMeterSource|null;
  sessionTools:ReactNode;
  exportTools:ReactNode;
  canStart:boolean;
  persistenceBusy?:boolean;
  onChooseDeck:(deck:TransitionDeck,id:string)=>void|Promise<void>;
  onCancelDeckLoad:()=>void;
  onBlendChange:(blend:number)=>void;
  onDurationChange:(seconds:number)=>void;
  onTimedTransition:()=>void;
  onCancelTransition:()=>void;
  onCommand:(command:SceneCommand)=>void;
  onRename:(title:string)=>void;
  onStart:()=>void;
  onPause:()=>void;
  onStop:()=>void;
  onRestart:()=>void;
}

function CapturedDeck({deck,capture,scenes,state,otherLoading,persistenceBusy,onChoose,onCancel}: {
  deck:TransitionDeck;capture:CapturedMix|null;scenes:SceneSummary[];state:DeckLoadState;otherLoading:boolean;persistenceBusy:boolean;
  onChoose:(id:string)=>void;onCancel:()=>void;
}) {
  const letter=deck.toUpperCase();
  const selectId=useId();
  const helpId=useId();
  const selected=state.loading?state.requestedId??'':capture?.scene.id??'';
  const inList=scenes.some(item=>item.id===selected);
  const names=new Map(capture?.assets.map(asset=>[asset.id,asset.displayName])??[]);
  return <section className="transition-deck panel" aria-label={'Mix '+letter}>
    <div className="panel-head"><h2>Mix {letter}</h2><span className="count-label">{capture?capture.scene.layers.length+' layers':'Choose a saved mix'}</span></div>
    <label htmlFor={selectId} className="field-label">Saved mix {letter}</label>
    <select id={selectId} aria-label={'Choose mix '+letter} aria-describedby={helpId} aria-busy={state.loading} value={selected}
      disabled={persistenceBusy||otherLoading||scenes.length===0&&!capture}
      onChange={event=>{if(event.target.value)onChoose(event.target.value);}}>
      <option value="">{scenes.length===0?'No saved mixes':'Choose a saved mix…'}</option>
      {!inList&&capture&&selected===capture.scene.id&&<option value={capture.scene.id}>{capture.scene.title} · Captured revision {capture.scene.revision}</option>}
      {scenes.map(item=><option key={item.id} value={item.id}>{item.title} · Revision {item.revision}</option>)}
    </select>
    <p className="transition-deck-help" id={helpId}>Uses the latest saved revision when chosen. Later source edits keep this capture unchanged.</p>
    {capture&&<div className="transition-capture">
      <h3>{capture.scene.title}</h3><p>Captured revision {capture.scene.revision}</p>
      <ul>{capture.scene.layers.slice(0,5).map(layer=><li key={layer.id}>{names.get(layer.assetId)??layer.assetId}<span>{layer.role}</span></li>)}</ul>
      {capture.scene.layers.length>5&&<p>And {capture.scene.layers.length-5} more layers</p>}
      {capture.scene.layers.length===0&&<p>This saved mix has no layers.</p>}
      <button type="button" disabled={persistenceBusy||state.loading||otherLoading} onClick={()=>onChoose(capture.scene.id)}>Use latest saved revision for {letter}</button>
    </div>}
    {!capture&&!state.loading&&<p className="empty-copy">Save a mix in the session editor, then choose it here.</p>}
    {state.loading&&<div className="transition-loading"><p role="status">Loading mix {letter}… Your current mix remains available.</p>
      <button type="button" onClick={onCancel}><IconX size={16} aria-hidden="true"/>Cancel loading mix {letter}</button></div>}
    {state.error&&<p className="error" role="alert">{state.error}</p>}
  </section>;
}

export function TransitionView({scene,savedScenes,deckStates,playback,outputMeterSource,sessionTools,exportTools,canStart,persistenceBusy=false,
  onChooseDeck,onCancelDeckLoad,onBlendChange,onDurationChange,onTimedTransition,onCancelTransition,onCommand,onRename,onStart,onPause,onStop,onRestart}:TransitionViewProps) {
  const transition=scene.transition;
  const [duration,setDuration]=useState(String(transition?.durationSeconds??30));
  useEffect(()=>setDuration(String(transition?.durationSeconds??30)),[scene.id,transition?.durationSeconds]);
  const timingId=useId();
  const playheadHelp=useId();
  if(!transition)return null;
  const preparing=deckStates.a.loading||deckStates.b.loading;
  const both=Boolean(transition.a&&transition.b);
  const seconds=Number(duration);
  const validDuration=Boolean(duration.trim())&&Number.isFinite(seconds)&&seconds>=.1&&seconds<=3600;
  // Manual controls show the requested setting even while the audio clock is suspended.
  // Timed progress follows the engine's actual audio-clock blend.
  const blend=transition.mode==='manual'?transition.blend:playback.transition?.blend??transitionBlendAt(transition,playback.positionSeconds);
  const percent=Math.round(blend*100);
  const phase=playback.transition?.phase;
  const moving=transition.mode==='timed'&&(phase==='running'||phase==='waiting');
  const sources=savedScenes.filter(item=>item.kind!=='transition');
  return <main className="listening-room transition-room">
    <header className="room-heading"><div><p className="eyebrow">Personal listening room</p><h1>ASMR Studio</h1><p>Move gently between two saved mixes.</p></div><AppearanceControls/></header>
    <section className="session" aria-label="Current transition arrangement">
      <div className="session-title"><SessionName key={scene.id} title={scene.title} onRename={onRename}/>{sessionTools}</div>
      <div className="session-playback"><Transport playback={playback} hasLayers={sceneLayerCount(scene)>0&&canStart}
        onStart={onStart} onPause={onPause} onStop={onStop}/>
        <label className="level master"><span><IconVolume size={18} stroke={1.7} aria-hidden="true"/>Master volume</span>
          <RangeInput aria-label="Master volume" min={0} max={100} step={1} value={Math.round(scene.masterGain*100)}
            onChange={event=>onCommand({type:'setMasterGain',gain:Number(event.target.value)/100})}/>
          <span className="readout">{Math.round(scene.masterGain*100)}%</span>
        </label>
      </div>
      <div className="transition-restart"><button type="button" disabled={!canStart||sceneLayerCount(scene)===0||playback.state==='loading'} onClick={onRestart} aria-describedby={playheadHelp}>
        <IconRefresh size={18} stroke={1.7} aria-hidden="true"/>Restart arrangement</button>
        <p id={playheadHelp}>Both mixes share one playhead. A mix chosen while listening joins the current position. Restart begins both at 0:00.</p>
      </div>
      <OutputControls value={scene.outputLimiter} meterSource={outputMeterSource} onChange={limiter=>onCommand({type:'setOutputLimiter',limiter})}/>
      {exportTools}
    </section>
    <div className="transition-decks">
      {(['a','b'] as const).map(deck=><CapturedDeck key={deck} deck={deck} capture={transition[deck]} scenes={sources} state={deckStates[deck]} persistenceBusy={persistenceBusy}
        otherLoading={deckStates[deck==='a'?'b':'a'].loading} onChoose={id=>{void onChooseDeck(deck,id);}} onCancel={onCancelDeckLoad}/>)}
    </div>
    <section className="transition-blend panel" aria-label="Mix transition controls">
      <div className="panel-head"><h2>Crossfader</h2><span className="count-label">Linear blend</span></div>
      <div className="transition-blend-labels" aria-hidden="true"><span>A <strong>{100-percent}%</strong></span><span>B <strong>{percent}%</strong></span></div>
      <RangeInput variant="crossfader" aria-label="Crossfader" min={0} max={100} step={1} value={percent} disabled={!both||preparing}
        aria-valuetext={`A ${100-percent} percent, B ${percent} percent`}
        onChange={event=>onBlendChange(Number(event.target.value)/100)}/>
      <p className="transition-help">Move the slider for a manual blend. A manual adjustment holds the new blend and ends a timed transition.</p>
      {!both&&<p className="transition-help">Choose both mixes to blend or export. You can listen to and save one captured mix while preparing the other.</p>}
      <div className="transition-timing">
        <label htmlFor={timingId}>Transition duration (seconds)
          <input id={timingId} type="number" min={.1} max={3600} step="any" value={duration} disabled={preparing}
            onChange={event=>{const value=event.target.value;setDuration(value);const next=Number(value);if(value.trim()&&Number.isFinite(next)&&next>=.1&&next<=3600)onDurationChange(next);}}/>
        </label>
        <button type="button" className="primary" disabled={!both||!canStart||sceneLayerCount(scene)===0||preparing||!validDuration||playback.state==='loading'} onClick={onTimedTransition}>
          <IconArrowRight size={18} stroke={1.7} aria-hidden="true"/>Transition to B{validDuration?' in '+seconds+' seconds':''}
        </button>
        <button type="button" disabled={transition.mode!=='timed'||preparing||playback.state==='loading'} onClick={onCancelTransition}>
          <IconPlayerStop size={18} stroke={1.7} aria-hidden="true"/>Cancel transition
        </button>
      </div>
      {!validDuration&&<p className="error" role="alert">Choose a transition duration from 0.1 to 3,600 seconds.</p>}
      <p className="transition-progress" role="status" aria-live="polite">{transition.mode==='manual'?'Manual blend':phase==='complete'?'Transition complete · Holding B':playback.state==='paused'?'Timed transition paused':moving?(phase==='waiting'?'Waiting for the saved transition':'Moving to B'):'Timed transition saved'}</p>
      {moving&&<p className="transition-remaining" aria-live="off">{Math.ceil(playback.transition?.remainingSeconds??0)} seconds remaining</p>}
      <p className="transition-help">{transition.mode==='manual'
        ? 'Saving and exporting keeps this constant blend. Slider movements are not recorded.'
        : `Restart and export begin with A ${Math.round((1-transition.blend)*100)}% / B ${Math.round(transition.blend*100)}%, wait ${formatTime(transition.startSeconds)}, then move to B over ${transition.durationSeconds} seconds.`}</p>
      <p className="transition-help">Each mix keeps its saved levels, tone, limiter, and listening timer. An ended mix contributes silence.</p>
    </section>
  </main>;
}
