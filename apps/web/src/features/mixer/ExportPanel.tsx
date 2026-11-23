import {useEffect,useRef,useState} from 'react';
import IconChevronRight from '@tabler/icons-react/icons/IconChevronRight';
import IconDownload from '@tabler/icons-react/icons/IconDownload';
import IconFileDescription from '@tabler/icons-react/icons/IconFileDescription';
import IconRefresh from '@tabler/icons-react/icons/IconRefresh';
import IconX from '@tabler/icons-react/icons/IconX';
import {EXPORT_SAMPLE_RATE,MAX_EXPORT_SECONDS,listeningFadeError,parseExportRequest,sceneLayerCount,type ExportJob,type ExportRequest,type Scene} from '@asmr-studio/contracts';
import {studioApi,StudioApiError} from '../../api.js';

interface Props {
  scene:Scene;
  dirty:boolean;
  busy:boolean;
  missingAssets:boolean;
  onSave:()=>Promise<boolean>;
  getScene:()=>Scene;
}
const pendingKey='asmr-studio-pending-export';
function storedRequest():ExportRequest|null {
  try {const value=localStorage.getItem(pendingKey);return value?parseExportRequest(JSON.parse(value)):null;}
  catch {return null;}
}
function rememberRequest(value:ExportRequest|null) {
  try {if(value)localStorage.setItem(pendingKey,JSON.stringify(value));else localStorage.removeItem(pendingKey);}
  catch {/* The in-memory request still protects this tab when storage is unavailable. */}
}
function duration(seconds:number):string {
  const total=Math.round(seconds);
  return Math.floor(total/60)+':'+String(total%60).padStart(2,'0');
}
function level(value:number):string {return value===0?'Silence':(20*Math.log10(value)).toFixed(1)+' dBFS';}
function megabytes(bytes:number):string {return (bytes/1024/1024).toFixed(1)+' MB';}
function fadeError(scene:Scene,seconds:number):string|null {
  // Captured timers keep their own endpoints, independently of the arrangement's WAV duration.
  if(scene.transition)return null;
  const error=listeningFadeError(scene.listeningTimer,Math.round(seconds*EXPORT_SAMPLE_RATE)/EXPORT_SAMPLE_RATE);
  return error?error+' Choose a longer export or shorten the fades in Listening timer.':null;
}
const labels:Record<ExportJob['status'],string>={queued:'Queued',rendering:'Rendering',complete:'Ready to download',cancelled:'Cancelled',failed:'Could not export',interrupted:'Interrupted'};
function mergeJobs(previous:ExportJob[],incoming:ExportJob[]):ExportJob[] {
  const byId=new Map(previous.map(job=>[job.id,job]));
  for(const job of incoming) {
    const old=byId.get(job.id);
    const oldTerminal=old&&!['queued','rendering'].includes(old.status);
    const nextActive=['queued','rendering'].includes(job.status);
    if(!old||(job.updatedAt>=old.updatedAt&&!(oldTerminal&&nextActive)))byId.set(job.id,job);
  }
  return [...byId.values()].sort((left,right)=>right.createdAt.localeCompare(left.createdAt));
}

/** A saved-revision export is independent of the live player and of later edits. */
export function ExportPanel({scene,dirty,busy,missingAssets,onSave,getScene}:Props) {
  const [expanded,setExpanded]=useState(false);
  const [minutes,setMinutes]=useState('10');
  const [jobs,setJobs]=useState<ExportJob[]>([]);
  const [loading,setLoading]=useState(false);
  const [requesting,setRequesting]=useState(false);
  const [message,setMessage]=useState('');
  const [listError,setListError]=useState('');
  const [refresh,setRefresh]=useState(0);
  const [pending,setPending]=useState<ExportRequest|null>(storedRequest);
  const pendingRef=useRef(pending);
  const action=useRef(false);
  const mounted=useRef(true);
  useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;};},[]);
  const setRequest=(value:ExportRequest|null)=>{
    pendingRef.current=value;rememberRequest(value);
    if(mounted.current)setPending(value);
  };
  const accept=(job:ExportJob)=>{
    if(pendingRef.current?.requestId===job.id)setRequest(null);
    if(mounted.current)setJobs(previous=>mergeJobs(previous,[job]));
  };
  const active=jobs.some(job=>job.status==='queued'||job.status==='rendering')||pending!==null;
  useEffect(()=>{
    if(!expanded)return;
    let current=true;
    let fetching=false;
    const fetchJobs=async()=>{
      if(fetching)return;
      fetching=true;
      try {
        const list=await studioApi.listExports();
        if(!current)return;
        // A poll started before a POST/cancel response must not erase its newer result.
        setJobs(previous=>mergeJobs(previous,list));setListError('');
        if(pendingRef.current&&list.some(job=>job.id===pendingRef.current!.requestId))setRequest(null);
      } catch {if(current)setListError('Finished mixes could not be loaded. Your mix and existing exports are still saved.');}
      finally {fetching=false;if(current)setLoading(false);}
    };
    setLoading(true);void fetchJobs();
    const timer=active?setInterval(()=>{void fetchJobs();},1000):null;
    return()=>{current=false;if(timer!==null)clearInterval(timer);};
  },[expanded,active,refresh]);

  const submit=async(request:ExportRequest)=>{
    setRequest(request);
    try {accept(await studioApi.createExport(request));}
    catch(error) {
      // A response may be lost after the server accepts a job. Keep its identity
      // until a read or the same idempotent request resolves that uncertainty.
      if(error instanceof StudioApiError && error.status>=400 && error.status<500) {
        setRequest(null);
        setMessage(error.code==='REVISION_CONFLICT'
          ? 'The saved session changed before export. Save your current mix and try again.'
          : error.message);
      } else setMessage('The export request could not be confirmed. Check the request below before starting another export.');
    }
  };
  const create=async()=>{
    if(action.current||pendingRef.current)return;
    const draft=getScene();
    if(draft.transition&&(!draft.transition.a||!draft.transition.b)){
      setMessage('Choose both mixes before exporting this arrangement.');return;
    }
    const seconds=Number(minutes)*60;
    if(!minutes.trim()||!Number.isFinite(seconds)||seconds<1||seconds>MAX_EXPORT_SECONDS) {
      setMessage('Choose at least 1 second and no more than '+Math.floor(MAX_EXPORT_SECONDS/60)+' minutes for this WAV format.');return;
    }
    const initialError=fadeError(getScene(),seconds);
    if(initialError){setMessage(initialError);return;}
    action.current=true;setRequesting(true);setMessage('');
    try {
      const selected=getScene().id;
      if(dirty||getScene().revision===0) {
        if(!await onSave()) {setMessage('The current mix has not been fully saved. Save all your changes before exporting.');return;}
      }
      const saved=getScene();
      if(saved.id!==selected) {setMessage('The selected session changed. Start an export from the session you want.');return;}
      if(saved.transition&&(!saved.transition.a||!saved.transition.b)) {setMessage('Choose both mixes before exporting this arrangement.');return;}
      const savedError=fadeError(saved,seconds);
      if(savedError){setMessage(savedError);return;}
      await submit({requestId:crypto.randomUUID(),sceneId:saved.id,expectedRevision:saved.revision,durationSeconds:seconds});
    } catch {if(mounted.current)setMessage('The current mix could not be prepared for export. Your edits are still here.');}
    finally {action.current=false;if(mounted.current)setRequesting(false);}
  };
  const reconcile=async()=>{
    const request=pendingRef.current;
    if(!request||action.current)return;
    action.current=true;setRequesting(true);setMessage('');
    try {
      try {accept(await studioApi.getExport(request.requestId));}
      catch(error) {
        if(error instanceof StudioApiError && error.status===404)await submit(request);
        else setMessage('The local studio could not confirm this request yet. Check again when it is available.');
      }
    } finally {action.current=false;if(mounted.current)setRequesting(false);}
  };
  const cancel=async(id:string)=>{
    if(action.current)return;
    action.current=true;setRequesting(true);setMessage('');
    try {accept(await studioApi.cancelExport(id));}
    catch {setMessage('Cancellation could not be confirmed. Refresh the export status before trying again.');setRefresh(value=>value+1);}
    finally {action.current=false;if(mounted.current)setRequesting(false);}
  };
  const visible=jobs.filter(job=>job.sceneId===scene.id);
  const seconds=Number(minutes)*60;
  const incomplete=Boolean(scene.transition&&(!scene.transition.a||!scene.transition.b));
  return <details className="export-panel" onToggle={event=>setExpanded(event.currentTarget.open)}>
    <summary><span className="summary-label"><IconDownload size={18} stroke={1.7} aria-hidden="true"/>Export mix</span><IconChevronRight className="summary-chevron" size={18} stroke={1.7} aria-hidden="true"/></summary>
    {expanded&&<div className="export-content">
      {scene.transition?<>
        <p>Make a WAV from the beginning of this saved arrangement. Both captured mixes start at 0:00 and keep their saved listening timers and envelopes.</p>
        <p>{scene.transition.mode==='manual'
          ? 'Manual export keeps the saved A/B blend for the whole file. Slider movements are not recorded.'
          : `The export holds the saved starting blend for ${scene.transition.startSeconds.toFixed(1)} seconds, then moves to B over ${scene.transition.durationSeconds} seconds.`}</p>
        {incomplete&&<p>Choose both mixes before exporting this arrangement.</p>}
      </>:<p>Make a WAV from the beginning of this saved mix. Looping sounds repeat for the chosen duration; recordings set to play once finish naturally.</p>}
      {scene.listeningTimer?.enabled&&<p>The export duration sets the file's ending. Saved fade-in and fade-out apply at the beginning and end of that file.</p>}
      <div className="export-controls">
        <label>Duration (minutes)
          <input type="number" min={1/60} max={MAX_EXPORT_SECONDS/60} step="any" value={minutes}
            onChange={event=>setMinutes(event.target.value)}/>
        </label>
        <button type="button" disabled={busy||requesting||pending!==null||missingAssets||sceneLayerCount(scene)===0||incomplete}
          onClick={()=>{void create();}}><IconDownload size={18} stroke={1.7} aria-hidden="true"/>{requesting?'Working…':dirty||scene.revision===0?'Save & export WAV':'Export WAV'}</button>
        {Number.isFinite(seconds)&&seconds>0&&seconds<=MAX_EXPORT_SECONDS&&
          <span className="export-size">About {megabytes(seconds*48000*4)} · Stereo WAV</span>}
      </div>
      {pending&&<div className="export-pending">
        <p>An export request is awaiting confirmation. Checking it will keep the same request and saved mix.</p>
        <button type="button" disabled={requesting} onClick={()=>{void reconcile();}}><IconRefresh size={18} stroke={1.7} aria-hidden="true"/>Check export request</button>
      </div>}
      {message&&<p role="alert" className="error">{message}</p>}
      <div className="export-heading"><h3>Finished mixes for this session</h3>
        <button type="button" disabled={loading} onClick={()=>setRefresh(value=>value+1)}><IconRefresh size={18} stroke={1.7} aria-hidden="true"/>Refresh exports</button>
      </div>
      {listError&&<p role="alert" className="error">{listError}</p>}
      {visible.length===0&&<p className="export-empty">{loading?'Loading finished mixes…':'No exports yet. You can keep listening and editing while a file renders.'}</p>}
      <ul className="export-list">{visible.map(job=><li key={job.id} aria-label={job.title+' export'}>
        <div className="export-job-heading"><strong>{job.title}</strong><span>{duration(job.durationSeconds)} · Saved revision {job.sceneRevision}</span></div>
        <p className="export-status" role="status">{labels[job.status]}{job.status==='rendering'?' · '+Math.round(job.progress*100)+'%':''}</p>
        {(job.status==='queued'||job.status==='rendering')&&<div className="export-progress">
          <progress aria-label={'Export progress for '+job.title} value={job.progress} max={1}/>
          <button type="button" disabled={requesting} onClick={()=>{void cancel(job.id);}}><IconX size={18} stroke={1.7} aria-hidden="true"/>Cancel export</button>
        </div>}
        {job.status==='complete'&&job.result&&<>
          <div className="export-links"><a href={'/api/exports/'+encodeURIComponent(job.id)+'/content'} download><IconDownload size={18} stroke={1.7} aria-hidden="true"/>Download WAV</a>
            <a href={'/api/exports/'+encodeURIComponent(job.id)+'/recipe'} download><IconFileDescription size={18} stroke={1.7} aria-hidden="true"/>Recipe & credits</a></div>
          <p className="export-measurements">{megabytes(job.result.bytes)} · 48 kHz / 16-bit · Peak {level(job.result.peak)}</p>
          {job.result.clippedSamples>0&&<p className="error">This file reaches full scale. Lower the master volume and export again if it sounds distorted.</p>}
          {job.result.peak===0&&<p>This file is silent. Check the layer and master volumes before exporting again.</p>}
        </>}
        {job.error&&<p className="error">{job.error}</p>}
        {(job.status==='interrupted'||job.status==='failed')&&<p>The saved mix is available above. Start a new export when ready.</p>}
      </li>)}</ul>
    </div>}
  </details>;
}
