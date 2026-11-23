import {useEffect,useRef,useState} from 'react';
import {applyCommand,transitionBlendAt,type AssetRecord,type Layer,type Scene,type SceneCommand} from '@asmr-studio/contracts';
import {createMixer,createWorkletOutputStage,type Mixer,type PlaybackSnapshot} from '@asmr-studio/audio-engine';
import outputWorkletUrl from '../../../packages/audio-engine/src/output-worklet.ts?worker&url';
import {MixerView} from './features/mixer/MixerView.js';
import {AssetImportForm} from './features/mixer/AssetImportForm.js';
import {SessionLibraryControls} from './features/mixer/SessionLibraryControls.js';
import {useSession} from './features/mixer/useSession.js';
import {ExportPanel} from './features/mixer/ExportPanel.js';
import {createLoopAudioService,type LoopAudioService} from './features/mixer/loop-audio-service.js';
import IconDeviceFloppy from '@tabler/icons-react/icons/IconDeviceFloppy';
import {studioApi,StudioApiError} from './api.js';
import {TransitionView,type DeckLoadState,type TransitionDeck} from './features/mixer/TransitionView.js';
interface Player {
  context: AudioContext;
  engine: Mixer;
  unsubscribe: () => void;
  ready: boolean;
  loadGeneration: number;
  editGeneration: number;
  sceneId: string | null;
  queuedCommands: SceneCommand[];
  wantsPlayback: boolean;
  starting: boolean;
  snapshot: PlaybackSnapshot;
  pendingUpdate: {done:Promise<void>;supersede:()=>void} | null;
}
const idle:PlaybackSnapshot={state:'idle',positionSeconds:0,loadedAssetIds:[],error:null};
const emptyDeckStates=():Record<TransitionDeck,DeckLoadState>=>({a:{loading:false,requestedId:null,error:null},b:{loading:false,requestedId:null,error:null}});
export function App(){
  const session=useSession();
  const assetCatalog=useRef(session.assets);
  assetCatalog.current=session.assets;
  const [playback,setPlayback]=useState<PlaybackSnapshot>(idle);
  const [audioError,setAudioError]=useState<string|null>(null);
  const [previewStopToken,setPreviewStopToken]=useState(0);
  const [outputMeterSource,setOutputMeterSource]=useState<Mixer|null>(null);
  const player=useRef<Player|null>(null);
  const deckRequest=useRef(0);
  const preparingDeck=useRef<TransitionDeck|null>(null);
  const [deckStates,setDeckStates]=useState(emptyDeckStates);
  useEffect(()=>{deckRequest.current++;preparingDeck.current=null;setDeckStates(emptyDeckStates());},[session.scene.id]);
  const [loopAudioService,setLoopAudioService]=useState<LoopAudioService>();
  useEffect(()=>{
    const service=createLoopAudioService({getDecodedAsset:id=>player.current?.engine.getDecodedAsset(id)});
    setLoopAudioService(service);
    return()=>service.dispose();
  },[]);
  const pendingStart=useRef<Promise<void>|null>(null);
  const startGeneration=useRef(0);
  useEffect(()=>()=>{const owned=player.current;player.current=null;
    deckRequest.current++;preparingDeck.current=null;
    startGeneration.current++;pendingStart.current=null;
    if(owned){owned.unsubscribe();owned.engine.dispose();void owned.context.close();}
  },[]);
  const showPlayback=(owned:Player)=>{
    if(player.current!==owned)return;
    const snapshot=owned.snapshot;
    setPlayback(owned.starting && owned.wantsPlayback && !['playing','interrupted','error'].includes(snapshot.state)
      ? {...snapshot,state:'loading'} : snapshot);
  };
  const trackUpdate=(owned:Player,update:Promise<unknown>):Promise<void>=>{
    let supersede!:()=>void;
    const obsolete=new Promise<void>(resolve=>{supersede=resolve;});
    const pending={done:Promise.race([update.then(()=>{}),obsolete]),supersede};
    const previous=owned.pendingUpdate;
    owned.pendingUpdate=pending;
    // A removed slow asset must not keep Start waiting after its replacement is ready.
    previous?.supersede();
    const clear=()=>{if(owned.pendingUpdate===pending)owned.pendingUpdate=null;};
    void pending.done.then(clear,clear);
    return pending.done;
  };
  const loadScene = async (owned: Player, scene: Scene): Promise<boolean> => {
    const generation = ++owned.loadGeneration;
    owned.ready = false;
    owned.queuedCommands = [];
    try {
      await owned.engine.setScene(scene);
      if (player.current !== owned || owned.loadGeneration !== generation) return false;
      // Edits made while decoding must reach the graph before playback resumes.
      for (const command of owned.queuedCommands) owned.engine.apply(command);
      owned.queuedCommands = [];
      owned.ready = true;
      owned.sceneId = scene.id;
      return true;
    } catch (error) {
      if (player.current !== owned || owned.loadGeneration !== generation) return false;
      owned.wantsPlayback = false;
      throw error;
    }
  };
  const updatePlayingScene = (scene: Scene) => {
    const owned = player.current;
    if (!owned) return;
    const generation = ++owned.editGeneration;
    // Saving a copy changes persistence identity, while its live audio graph stays in place.
    const update = trackUpdate(owned,owned.ready
      ? owned.engine.updateScene({...scene,id:owned.sceneId ?? scene.id})
      : loadScene(owned,scene));
    void update.catch(() => {
      if(player.current===owned && owned.editGeneration===generation)
        setAudioError('Playback could not apply the revised mix. Your edits remain here; remove the unavailable sound or stop and start to retry.');
    });
  };
  const edit=(command:SceneCommand)=>{
    try{
      const next=session.edit(command);
      setAudioError(null);
      const owned=player.current;
      if(!owned)return;
      if(command.type==='addLayer')updatePlayingScene(next);
      else if(command.type==='removeLayer'){
        if(owned.ready){
          try{owned.engine.apply(command);}
          catch{/* Reconcile the current draft below if the live graph cannot apply it. */}
        }
        // Remove audible playback immediately, then supersede any obsolete decoding wait.
        updatePlayingScene(next);
      }
      else if(owned.ready){
        try{owned.engine.apply(command);}
        catch{updatePlayingScene(next);}
      }else if(command.type==='setLayerLoop'||command.type==='setLayerOccasional')updatePlayingScene(next);
      else owned.queuedCommands.push(command);
    }catch{setAudioError('The adjustment could not be applied. Check its settings and try again.');}
  };
  const addAsset=(asset:AssetRecord,role:Layer['role'])=>{
    try{const next=session.addAsset(asset,role);setAudioError(null);updatePlayingScene(next);}
    catch{setAudioError('This recording could not be added to the mix.');}
  };
  const ensurePlayer=():Player=>{
    if(player.current)return player.current;
    const context=new AudioContext();
    const engine=createMixer({context,decodedBudgetBytes:256*1024*1024,
      assetDurationSeconds:id=>assetCatalog.current.find(asset=>asset.id===id)?.durationSeconds,
      createOutputStage:audioContext=>createWorkletOutputStage(audioContext,outputWorkletUrl),loadAsset:async id=>{
        const editing=loopAudioService?.peek(id);
        if(editing)return editing;
        const response=await fetch('/api/assets/'+encodeURIComponent(id)+'/content',{credentials:'same-origin'});
        if(!response.ok)throw new Error('The recording is unavailable');
        return context.decodeAudioData(await response.arrayBuffer());
      }});
    const created:Player={context,engine,unsubscribe:()=>{},ready:false,loadGeneration:0,editGeneration:0,
      sceneId:null,queuedCommands:[],wantsPlayback:false,starting:false,snapshot:idle,pendingUpdate:null};
    player.current=created;setOutputMeterSource(engine);
    created.unsubscribe=engine.subscribe(snapshot=>{
      const wasPlaying=created.snapshot.state==='playing';
      created.snapshot=snapshot;
      if(snapshot.state==='interrupted'||snapshot.state==='ready'&&wasPlaying)created.wantsPlayback=false;
      showPlayback(created);
    });
    return created;
  };
  const samplePlayback=():PlaybackSnapshot=>{
    const owned=player.current;
    if(!owned)return idle;
    let snapshot=owned.snapshot;
    // subscribe reports synchronously from the audio clock, not the last display tick.
    const unsubscribe=owned.engine.subscribe(value=>{snapshot=value;});unsubscribe();
    return snapshot;
  };
  const restoreCommittedTransition=()=>{
    const owned=player.current;
    if(!owned?.ready||!session.getScene().transition)return;
    const scene=session.getScene();
    const update=owned.engine.updateScene({...scene,id:owned.sceneId??scene.id});
    void trackUpdate(owned,update).catch(()=>{
      if(player.current===owned&&session.getScene().id===scene.id)setAudioError('The previous arrangement could not be restored. Stop and start to retry.');
    });
  };
  const cancelDeckLoad=()=>{
    deckRequest.current++;preparingDeck.current=null;
    setDeckStates(previous=>({a:{...previous.a,loading:false,requestedId:null},b:{...previous.b,loading:false,requestedId:null}}));
    restoreCommittedTransition();
  };
  const chooseDeck=async(deck:TransitionDeck,id:string):Promise<void>=>{
    const original=session.getScene();
    if(!original.transition||session.status==='saving'||session.status==='loading')return;
    const generation=++deckRequest.current;
    const current=()=>deckRequest.current===generation&&session.getScene().id===original.id&&Boolean(session.getScene().transition);
    if(preparingDeck.current)restoreCommittedTransition();
    preparingDeck.current=deck;
    setDeckStates(previous=>({
      a:{...previous.a,loading:deck==='a',requestedId:deck==='a'?id:null,error:deck==='a'?null:previous.a.error},
      b:{...previous.b,loading:deck==='b',requestedId:deck==='b'?id:null,error:deck==='b'?null:previous.b.error},
    }));
    try{
      // Read current authority before capture; list summaries may be stale or another editor may have saved.
      const saved=await studioApi.getScene(id);
      if(!current())return;
      if(saved.transition)throw new Error('A transition cannot be used as a source mix');
      const capture=await studioApi.captureScene(saved.id,saved.revision);
      if(!current())return;
      const owned=ensurePlayer();
      if(!owned.ready){
        await trackUpdate(owned,loadScene(owned,session.getScene()));
        if(!current()||player.current!==owned)return;
        if(!owned.ready)throw new Error('The arrangement could not be prepared');
      }
      const draft=session.getScene();
      const candidate=applyCommand(draft,{type:'setTransition',transition:{...draft.transition!,[deck]:capture}});
      const update=owned.engine.updateScene({...candidate,id:owned.sceneId??candidate.id});
      void trackUpdate(owned,update).catch(()=>{});
      // Only an accepted graph becomes part of the editable/saved arrangement.
      await update;
      if(!current()||player.current!==owned)return;
      session.edit({type:'setTransition',transition:{...session.getScene().transition!,[deck]:capture}});
      setAudioError(null);
    }catch(error){
      if(!current())return;
      const conflict=error instanceof StudioApiError&&error.status===409;
      setDeckStates(previous=>({...previous,[deck]:{...previous[deck],error:conflict
        ? `Mix ${deck.toUpperCase()} changed before it could be captured. Choose it again to use the latest saved revision. Your current audio is still here.`
        : `Mix ${deck.toUpperCase()} could not be loaded. Your previous capture and current audio are still here. Choose another mix or try again.`}}));
    }finally{
      if(current()){
        preparingDeck.current=null;
        setDeckStates(previous=>({...previous,[deck]:{...previous[deck],loading:false,requestedId:null}}));
      }
    }
  };
  const start=()=>{
    if(pendingStart.current) return;
    setPreviewStopToken(value=>value+1);
    const generation=++startGeneration.current;
    const current=(owned:Player)=>player.current===owned && startGeneration.current===generation && owned.wantsPlayback;
    let owned=player.current;
    const task=(async()=>{
      try{
        setAudioError(null);
        owned=ensurePlayer();
        owned.wantsPlayback=true;owned.starting=true;showPlayback(owned);
        // Resume begins within this click gesture, including while B is still preparing.
        const resumed=owned.context.resume();
        await resumed;
        while(current(owned)){
          // Re-read after every await: another edit may have superseded the update we waited for.
          if(owned.pendingUpdate&&!(session.getScene().transition&&owned.ready&&preparingDeck.current)){await owned.pendingUpdate.done;continue;}
          if(!owned.ready){trackUpdate(owned,loadScene(owned,session.getScene()));continue;}
          break;
        }
        if(current(owned))await owned.engine.play();
      }catch{
        if(startGeneration.current===generation && (!owned||player.current===owned)){
          if(owned)owned.wantsPlayback=false;
          setAudioError('Audio could not start. Check the recordings and try again.');
        }
      }finally{
        if(owned && player.current===owned && startGeneration.current===generation){owned.starting=false;showPlayback(owned);}
      }
    })();
    pendingStart.current=task;
    void task.finally(()=>{if(pendingStart.current===task)pendingStart.current=null;});
  };
  const cancelStart=()=>{
    startGeneration.current++;pendingStart.current=null;
    const owned=player.current;
    if(owned){owned.wantsPlayback=false;owned.starting=false;showPlayback(owned);}
  };
  const clearPlayer=()=>{
    const owned=player.current;
    cancelStart();player.current=null;
    deckRequest.current++;preparingDeck.current=null;setDeckStates(emptyDeckStates());
    if(owned){
      owned.loadGeneration++;owned.editGeneration++;
      owned.unsubscribe();owned.engine.dispose();void owned.context.close();
    }
    setOutputMeterSource(null);setPlayback(idle);setAudioError(null);setPreviewStopToken(value=>value+1);
  };
  const reload=async()=>{clearPlayer();await session.reload();};
  const openSession=async(id:string)=>{clearPlayer();await session.openScene(id);};
  const newSession=()=>{if(session.newScene())clearPlayer();};
  const newTransition=()=>{if(session.newTransition())clearPlayer();};
  const stop=()=>{
    setPreviewStopToken(value=>value+1);
    const owned=player.current;
    cancelStart();
    if(owned){
      owned.loadGeneration++;owned.queuedCommands=[];
      owned.engine.stop();
      // Force the next explicit start to retry a previously failed addition.
      if(audioError||playback.error)owned.ready=false;
    }
    setAudioError(null);
  };
  const setBlend=(blend:number)=>{
    const transition=session.getScene().transition;
    if(transition&&!preparingDeck.current)edit({type:'setTransition',transition:{...transition,mode:'manual',blend,startSeconds:0}});
  };
  const timedTransition=()=>{
    const transition=session.getScene().transition;
    if(!transition?.a||!transition.b||preparingDeck.current)return;
    const snapshot=samplePlayback();
    const blend=transition.mode==='manual'&&snapshot.state!=='playing'
      ? transition.blend
      : snapshot.transition?.blend??transitionBlendAt(transition,snapshot.positionSeconds);
    // A completed arrangement replays from zero. Rewind before the new timed recipe extends its endpoint.
    const replay=snapshot.state==='ready'&&snapshot.positionSeconds>0;
    if(replay)stop();
    edit({type:'setTransition',transition:{...transition,mode:'timed',blend,startSeconds:replay?0:snapshot.positionSeconds}});
    start();
  };
  const cancelTransition=()=>{
    const transition=session.getScene().transition;
    if(!transition||preparingDeck.current)return;
    const snapshot=samplePlayback();
    setBlend(snapshot.transition?.blend??transitionBlendAt(transition,snapshot.positionSeconds));
  };
  const deckBusy=deckStates.a.loading||deckStates.b.loading;
  const sessionBusy=session.status==='saving'||session.status==='loading'||deckBusy;
  const sessionTools=<div className="session-actions">
    <SessionLibraryControls sceneId={session.scene.id} savedScenes={session.savedScenes}
      busy={sessionBusy} dirty={session.dirty}
      onNew={newSession} onNewTransition={newTransition} onOpen={openSession} onSave={session.save} onSaveCopy={session.saveAsNew}/>
    <button type="button" className="save-session primary" disabled={sessionBusy} onClick={()=>{void session.save();}}><IconDeviceFloppy size={18} stroke={1.7} aria-hidden="true"/>{session.scene.transition?'Save arrangement':'Save session'}</button>
    {session.status==='saved'&&<p>Saved revision {session.scene.revision}</p>}
    {session.dirty&&session.status!=='loading'&&session.status!=='saving'&&session.status!=='conflict'&&<p>Unsaved changes</p>}
    {session.status==='saving'&&<p>Saving…</p>}
    {session.message&&<p className={session.status==='error'?'error':''}>{session.message}</p>}
    {session.status==='conflict'&&<div className="conflict">
      <button type="button" disabled={deckBusy} onClick={()=>{void reload();}}>Reload saved version</button>
    </div>}
  </div>;
  const missing=session.missingAssets.length>0;
  const exportTools=<ExportPanel scene={session.scene} dirty={session.dirty} busy={sessionBusy} missingAssets={missing}
    onSave={session.save} getScene={session.getScene}/>;
  const shownPlayback=audioError?{...playback,error:audioError}:playback;
  return <>
    <fieldset className="session-editor" aria-label="Session editor" disabled={session.status==='loading'}>
    {session.scene.transition?<TransitionView scene={session.scene} savedScenes={session.savedScenes} deckStates={deckStates}
      playback={shownPlayback} outputMeterSource={outputMeterSource} sessionTools={sessionTools} exportTools={exportTools}
      canStart={!missing&&session.status!=='loading'} persistenceBusy={session.status==='saving'} onChooseDeck={chooseDeck} onCancelDeckLoad={cancelDeckLoad}
      onBlendChange={setBlend} onDurationChange={durationSeconds=>{
        const transition=session.getScene().transition;
        if(transition&&!preparingDeck.current)edit({type:'setTransition',transition:{...transition,durationSeconds}});
      }} onTimedTransition={timedTransition} onCancelTransition={cancelTransition} onCommand={edit} onRename={session.rename}
      onStart={start} onPause={()=>{cancelStart();player.current?.engine.pause();}} onStop={stop} onRestart={()=>{stop();start();}}/>
    :<MixerView scene={session.scene} playback={shownPlayback} outputMeterSource={outputMeterSource}
      loopAudioService={loopAudioService}
      assets={session.assets} libraryTools={<AssetImportForm onImport={session.importFile}/>}
      sessionTools={sessionTools} onAddAsset={addAsset} canStart={!missing && session.status!=='loading'}
      exportTools={exportTools}
      onRename={session.rename} onInstallStarterSounds={session.installStarterSounds} previewStopToken={previewStopToken}
      onCommand={edit} onStart={start}
      onPause={()=>{cancelStart();player.current?.engine.pause();}}
      onStop={stop}/>}
    </fieldset>
    {missing&&<p role="alert" className="missing-asset">Some recordings are missing from the library. Restore them before listening.</p>}
  </>;
}
