import {useEffect,useRef,useState,type ReactNode} from 'react';
import type {Scene,SceneCommand,AssetRecord,Layer} from '@asmr-studio/contracts';
import type {PlaybackSnapshot} from '@asmr-studio/audio-engine';
import {LayerControls} from './LayerControls.js';
import {Transport} from './Transport.js';
import {NarrationPanel} from './NarrationPanel.js';
import {SoundLibrary} from './SoundLibrary.js';
import {RangeInput} from './RangeInput.js';
import {EqualizerControls} from './EqualizerControls.js';
import {OutputControls,type OutputMeterSource} from './OutputControls.js';
import {ListeningTimerControls} from './ListeningTimerControls.js';
import {useLoopEditorAudio} from './useLoopEditorAudio.js';
import type {LoopAudioService} from './loop-audio-service.js';
import IconVolume from '@tabler/icons-react/icons/IconVolume';
import {SessionName} from './SessionName.js';
import {AppearanceControls} from '../appearance/AppearanceControls.js';

export interface MixerViewProps {
  scene:Scene;
  playback:PlaybackSnapshot;
  onCommand:(command:SceneCommand)=>void;
  onStart:()=>void;
  onPause:()=>void;
  onStop:()=>void;
  assets?:AssetRecord[];
  libraryTools?:ReactNode;
  sessionTools?:ReactNode;
  exportTools?:ReactNode;
  onAddAsset?:(asset:AssetRecord,role:Layer['role'])=>void;
  onRename?:(title:string)=>void;
  onInstallStarterSounds?:()=>Promise<void>;
  previewStopToken?:number;
  canStart?:boolean;
  outputMeterSource?:OutputMeterSource|null;
  loopAudioService?:LoopAudioService|undefined;
}

export function MixerView({scene,playback,onCommand,onStart,onPause,onStop,assets=[],libraryTools,sessionTools,exportTools,
  onAddAsset,onRename,onInstallStarterSounds,previewStopToken=0,canStart=true,outputMeterSource=null,loopAudioService}:MixerViewProps){
  const byId=new Map(assets.map(asset=>[asset.id,asset]));
  const [openLoop,setOpenLoop]=useState<{sceneId:string;layerId:string}|null>(null);
  useEffect(()=>setOpenLoop(null),[scene.id]);
  const selectedLayer=openLoop?.sceneId===scene.id?scene.layers.find(layer=>layer.id===openLoop.layerId&&layer.loop&&!layer.occasional?.enabled):undefined;
  const libraryPreviewStop=useRef<(()=>void)|null>(null);
  const mixActive=playback.state==='playing'||playback.state==='loading';
  const loopAudio=useLoopEditorAudio(loopAudioService,selectedLayer?byId.get(selectedLayer.assetId):undefined,selectedLayer?.id??null,
    {mixActive,stopToken:previewStopToken,onPreviewStart:()=>libraryPreviewStop.current?.()});
  return <main className="listening-room">
    <header className="room-heading"><div><p className="eyebrow">Personal listening room</p><h1>ASMR Studio</h1>
      <p>Layer your favorite sounds. Make the room your own.</p></div><AppearanceControls/></header>
    <section className="session" aria-label="Current session">
      <div className="session-title"><SessionName key={scene.id} title={scene.title} onRename={onRename}/>{sessionTools}</div>
      <div className="session-playback"><Transport playback={playback} hasLayers={scene.layers.length>0&&canStart} onStart={onStart} onPause={onPause} onStop={onStop}/>
      <label className="level master"><span><IconVolume size={18} stroke={1.7} aria-hidden="true"/>Master volume</span>
        <RangeInput aria-label="Master volume" min="0" max="100" step="1" value={Math.round(scene.masterGain*100)}
          onChange={event=>onCommand({type:'setMasterGain',gain:Number(event.target.value)/100})}/>
        <span className="readout">{Math.round(scene.masterGain*100)}%</span>
      </label></div>
      <ListeningTimerControls key={scene.id} value={scene.listeningTimer} legacyDuration={scene.durationSeconds} playback={playback}
        onChange={timer=>onCommand({type:'setListeningTimer',timer})}/>
      <div className="master-equalizer"><EqualizerControls label="Master equalizer" value={scene.masterEqualizer}
        onChange={equalizer=>onCommand({type:'setMasterEqualizer',equalizer})}/></div>
      <OutputControls value={scene.outputLimiter} meterSource={outputMeterSource}
        onChange={limiter=>onCommand({type:'setOutputLimiter',limiter})}/>
      {exportTools}
    </section>
    <div className="workspace">
      <SoundLibrary assets={assets} layers={scene.layers} onAddAsset={onAddAsset} onCommand={onCommand}
        mixActive={mixActive} previewStopToken={previewStopToken} previewStopRef={libraryPreviewStop} onPreviewStart={loopAudio.stopPreview}
        importTools={libraryTools} onInstallStarterSounds={onInstallStarterSounds}/>
      <section className="mix panel" aria-label="Active mix">
        <div className="panel-head"><h2>Active mix</h2><span className="count-label">{scene.layers.length} {scene.layers.length===1?'layer':'layers'}</span></div>
        {scene.layers.length===0
          ? <p className="empty-copy">Your mix is empty. Choose a sound from your library to begin.</p>
          : <div className="layers">{scene.layers.map(layer=><LayerControls key={JSON.stringify([scene.id,layer.id])} layer={layer} assets={assets}
            label={byId.get(layer.assetId)?.displayName??layer.id} durationSeconds={byId.get(layer.assetId)?.durationSeconds} onCommand={onCommand}
            loopEditorOpen={selectedLayer?.id===layer.id} onLoopEditorOpenChange={open=>setOpenLoop(current=>open?{sceneId:scene.id,layerId:layer.id}:current?.layerId===layer.id?null:current)}
            waveform={selectedLayer?.id===layer.id?loopAudio.waveform:undefined} loopPreview={selectedLayer?.id===layer.id?loopAudio.preview:undefined}/>)}</div>}
        <NarrationPanel layers={scene.layers}/>
      </section>
    </div>
  </main>;
}
