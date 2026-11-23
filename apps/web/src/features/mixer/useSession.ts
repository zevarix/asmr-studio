import {useEffect,useRef,useState} from 'react';
import {applyCommand,createEmptyScene,createEmptyTransition,parseScene,sceneAssetIds,sceneLayerCount,type AssetImportMetadata,type AssetRecord,type Layer,type Scene,type SceneCommand} from '@asmr-studio/contracts';
import {studioApi,StudioApiError,type SceneSummary} from '../../api.js';
import {defaultLoop} from './sound-utils.js';

export type SessionStatus='loading'|'ready'|'unsaved'|'saving'|'saved'|'conflict'|'error';
const selectedKey='asmr-studio-selected-scene';
function selectedSceneId():string {
  const direct=new URLSearchParams(window.location.search).get('scene');
  try {return direct?.trim() || localStorage.getItem(selectedKey) || 'local-session';}
  catch {return direct?.trim() || 'local-session';}
}
function remember(id:string):void {
  try {localStorage.setItem(selectedKey,id);}catch { /* Private browsing may disallow storage. */ }
  const current=new URL(window.location.href);
  if(current.searchParams.has('scene')){
    current.searchParams.set('scene',id);
    window.history.replaceState(null,'',current.pathname+current.search+current.hash);
  }
}
function summary(scene:Scene):SceneSummary {
  return {id:scene.id,title:scene.title,revision:scene.revision,durationSeconds:scene.durationSeconds,layerCount:sceneLayerCount(scene),kind:scene.transition?'transition':'mix'};
}

export function useSession(){
  const [scene,setScene]=useState<Scene>(()=>createEmptyScene(selectedSceneId(),'Untitled session'));
  const sceneRef=useRef(scene);
  const pendingWrite=useRef(false);
  const loadGeneration=useRef(0);
  const starterRequest=useRef<Promise<void>|null>(null);
  const [assets,setAssets]=useState<AssetRecord[]>([]);
  const [savedScenes,setSavedScenes]=useState<SceneSummary[]>([]);
  const [saved,setSaved]=useState<Scene|null>(null);
  const [status,setStatus]=useState<SessionStatus>('loading');
  const [message,setMessage]=useState<string>('');
  const [conflict,setConflict]=useState<number|null>(null);

  useEffect(()=>{
    let active=true;
    const generation=++loadGeneration.current;
    const load=async()=>{
      try {
        const loadSelected=async()=>{
          try {return await studioApi.getScene(sceneRef.current.id);}
          catch(error){if(error instanceof StudioApiError&&error.status===404)return null;throw error;}
        };
        const [list,stored,scenes]=await Promise.all([studioApi.listAssets(),loadSelected(),studioApi.listScenes()]);
        if(!active||generation!==loadGeneration.current)return;
        setAssets(list);setSavedScenes(scenes);
        if(stored){sceneRef.current=stored;setScene(stored);setSaved(stored);setStatus('saved');}
        else setStatus('ready');
        setMessage('');
      }catch{
        if(active&&generation===loadGeneration.current){setStatus('error');setMessage('Could not load saved media or sessions. Local changes are still available.');}
      }
    };
    void load();
    return()=>{active=false;};
  },[]);

  const replaceDraft=(next:Scene):Scene=>{
    sceneRef.current=next;setScene(next);setStatus(pendingWrite.current?'saving':'unsaved');setMessage('');setConflict(null);
    return next;
  };
  const edit=(command:SceneCommand):Scene=>{
    const next=applyCommand(sceneRef.current,command);
    if(command.type==='setTransition'){
      // A capture may include a recording imported in another tab after our catalog loaded.
      const captured=[command.transition.a,command.transition.b].flatMap(side=>side?.assets??[]);
      setAssets(previous=>{
        const known=new Set(previous.map(asset=>asset.id));
        return [...previous,...captured.filter(asset=>{if(known.has(asset.id))return false;known.add(asset.id);return true;})];
      });
      setSavedScenes(previous=>{
        const byId=new Map(previous.map(item=>[item.id,item]));let changed=false;
        for(const capture of [command.transition.a,command.transition.b]){
          if(!capture)continue;
          const known=byId.get(capture.scene.id);
          if(!known||known.revision<capture.scene.revision){byId.set(capture.scene.id,summary(capture.scene));changed=true;}
        }
        return changed?[...byId.values()]:previous;
      });
    }
    return replaceDraft(next);
  };
  const rename=(title:string):Scene=>replaceDraft(parseScene({...sceneRef.current,title:title.trim()}));
  const addAsset=(asset:AssetRecord,role:Layer['role']):Scene=>{
    const layer:Layer={id:'layer-'+crypto.randomUUID(),assetId:asset.id,role,gain:0.5,pan:0,muted:false,solo:false,startSeconds:0,
      loop:role==='narration'?null:defaultLoop(asset.durationSeconds)};
    return edit({type:'addLayer',layer});
  };
  const importFile=async(file:File,metadata:AssetImportMetadata):Promise<void>=>{
    const record=await studioApi.importAsset(file,metadata);
    setAssets(previous=>[...previous.filter(asset=>asset.id!==record.id),record]);
  };
  const installStarterSounds=():Promise<void>=>{
    if(starterRequest.current)return starterRequest.current;
    const request=studioApi.installStarterSounds().then(list=>{
      // A local import can finish during the download; retain those new records.
      setAssets(previous=>{
        const merged=new Map(list.map(asset=>[asset.id,asset]));
        for(const asset of previous)if(!merged.has(asset.id))merged.set(asset.id,asset);
        return [...merged.values()];
      });
    });
    starterRequest.current=request;
    void request.then(()=>{if(starterRequest.current===request)starterRequest.current=null;},()=>{if(starterRequest.current===request)starterRequest.current=null;});
    return request;
  };
  const commitSaved=(persisted:Scene,submitted:Scene)=>{
    setSaved(persisted);
    const changed=JSON.stringify(sceneRef.current)!==JSON.stringify(submitted);
    const current=changed?parseScene({...sceneRef.current,id:persisted.id,revision:persisted.revision}):persisted;
    sceneRef.current=current;setScene(current);
    setSavedScenes(previous=>[summary(persisted),...previous.filter(item=>item.id!==persisted.id)]);
    setStatus(changed?'unsaved':'saved');setConflict(null);
    setMessage(changed?'Some edits were made during saving. Save again to include them.':'');
    remember(persisted.id);
    return !changed;
  };
  const save=async():Promise<boolean>=>{
    if(pendingWrite.current)return false;
    pendingWrite.current=true;
    const submitted=sceneRef.current;
    setStatus('saving');setMessage('');
    try{
      const persisted=submitted.revision===0?await studioApi.createScene(submitted):await studioApi.saveScene(submitted,submitted.revision);
      return commitSaved(persisted,submitted);
    }catch(error){
      if(error instanceof StudioApiError&&error.status===409){
        setStatus('conflict');setConflict(error.currentRevision);
        setMessage('Another editor saved a newer revision. Your changes are still here.');
      }else{setStatus('error');setMessage('Save failed. Your unsaved changes are still here.');}
      return false;
    }finally{pendingWrite.current=false;}
  };
  const openScene=async(id:string):Promise<Scene|null>=>{
    if(pendingWrite.current)return null;
    const generation=++loadGeneration.current;
    setStatus('loading');setMessage('');
    try{
      const [fresh,list,scenes]=await Promise.all([studioApi.getScene(id),studioApi.listAssets(),studioApi.listScenes()]);
      if(generation!==loadGeneration.current)return null;
      sceneRef.current=fresh;setScene(fresh);setSaved(fresh);setAssets(list);setSavedScenes(scenes);
      setStatus('saved');setMessage('');setConflict(null);remember(fresh.id);
      return fresh;
    }catch{
      if(generation===loadGeneration.current){setStatus('error');setMessage('Could not open that session. Your current session and unsaved changes are still here.');}
      return null;
    }
  };
  const reload=():Promise<Scene|null>=>openScene(sceneRef.current.id);
  const newDraft=(transition:boolean):Scene|null=>{
    if(pendingWrite.current)return null;
    loadGeneration.current++;
    const id='scene-'+crypto.randomUUID();
    const empty=transition?createEmptyTransition(id,'Untitled transition'):createEmptyScene(id,'Untitled session');
    sceneRef.current=empty;setScene(empty);setSaved(null);setStatus('ready');setMessage('');setConflict(null);remember(empty.id);
    return empty;
  };
  const newScene=():Scene|null=>newDraft(false);
  const newTransition=():Scene|null=>newDraft(true);
  const saveAsNew=async():Promise<boolean>=>{
    if(pendingWrite.current)return false;
    const original=sceneRef.current;
    const copy=parseScene({...original,id:'scene-'+crypto.randomUUID(),revision:0});
    pendingWrite.current=true;setStatus('saving');setMessage('');
    try{return commitSaved(await studioApi.createScene(copy),original);}
    catch{setStatus('error');setMessage('Save a copy failed. Your original draft is still here.');return false;}
    finally{pendingWrite.current=false;}
  };
  const assetIds=new Set(assets.map(asset=>asset.id));
  const missingAssets=sceneAssetIds(scene).filter(id=>!assetIds.has(id));
  const dirty=saved===null
    ? JSON.stringify(scene)!==JSON.stringify(scene.transition?createEmptyTransition(scene.id,'Untitled transition'):createEmptyScene(scene.id,'Untitled session'))
    : JSON.stringify(scene)!==JSON.stringify(saved);
  return {scene,assets,savedScenes,status,message,conflict,dirty,missingAssets,edit,rename,addAsset,importFile,
    installStarterSounds,save,reload,saveAsNew,newScene,newTransition,openScene,getScene:()=>sceneRef.current};
}
