import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {act,fireEvent,render,screen,waitFor} from '@testing-library/react';
import {createEmptyTransition,parseCapturedMix,parseScene,type ExportJob,type Scene} from '@asmr-studio/contracts';
import {fixtureAsset,fixtureScene} from '../../../../../tests/fixtures/scene.js';
import {studioApi,StudioApiError} from '../../api.js';
import {ExportPanel} from './ExportPanel.js';

const scene:Scene={...fixtureScene(),revision:3};
function job(overrides:Partial<ExportJob>={}):ExportJob {
  return {id:'15dc3105-c67e-4caf-bd8d-95794329e870',sceneId:scene.id,sceneRevision:3,title:scene.title,
    createdAt:'2026-01-01T00:00:00.000Z',updatedAt:'2026-01-01T00:00:01.000Z',durationSeconds:600,
    status:'queued',progress:0,error:null,result:null,...overrides};
}
function completed(overrides:Partial<ExportJob>={}):ExportJob {
  return job({status:'complete',progress:1,result:{bytes:115200078,sha256:'a'.repeat(64),durationSeconds:600,
    sampleRate:48000,channels:2,peak:.1,rms:.02,clippedSamples:0},...overrides});
}
async function openPanel() {
  fireEvent.click(screen.getByText('Export mix',{exact:true}));
  await screen.findByRole('spinbutton',{name:'Duration (minutes)'});
}
beforeEach(()=>{
  localStorage.clear();
  vi.spyOn(studioApi,'listExports').mockResolvedValue([]);
  vi.spyOn(studioApi,'createExport').mockImplementation(async request=>completed({id:request.requestId}));
  vi.spyOn(studioApi,'getExport').mockResolvedValue(completed());
  vi.spyOn(studioApi,'cancelExport').mockResolvedValue(job({status:'cancelled',updatedAt:'2026-01-01T00:00:02.000Z'}));
});
afterEach(()=>vi.restoreAllMocks());

describe('finished mix controls',()=>{
  it('requires both captured mixes for export while an incomplete arrangement remains saveable',async()=>{
    const capture=parseCapturedMix({id:'capture-a',scene:fixtureScene(),assets:[fixtureAsset(),{...fixtureAsset(),id:'asset-voice'}]});
    const empty=createEmptyTransition('arrangement','Saved transition');
    const partial=parseScene({...empty,revision:2,transition:{...empty.transition!,a:capture}});
    const configured={dirty:false,busy:false,missingAssets:false,onSave:vi.fn()};
    const {rerender}=render(<ExportPanel {...configured} scene={partial} getScene={()=>partial}/>);
    await openPanel();
    expect(screen.getByRole('button',{name:'Export WAV'})).toBeDisabled();
    expect(screen.getByText('Choose both mixes before exporting this arrangement.')).toBeVisible();
    const complete=parseScene({...partial,transition:{...partial.transition!,b:capture,blend:.3}});
    rerender(<ExportPanel {...configured} scene={complete} getScene={()=>complete}/>);
    expect(screen.getByRole('button',{name:'Export WAV'})).toBeEnabled();
    expect(screen.getByText(/Slider movements are not recorded/)).toBeVisible();
    fireEvent.click(screen.getByRole('button',{name:'Export WAV'}));
    await waitFor(()=>expect(studioApi.createExport).toHaveBeenCalledWith(expect.objectContaining({sceneId:'arrangement',expectedRevision:2})));
  });

  it('explains the independent WAV endpoint and rejects fades that do not fit before saving',async()=>{
    const current={...scene,listeningTimer:{enabled:true,durationSeconds:2700,fadeInSeconds:30,fadeOutSeconds:180}};
    const save=vi.fn().mockResolvedValue(true);
    render(<ExportPanel scene={current} dirty busy={false} missingAssets={false} onSave={save} getScene={()=>current}/>);
    await openPanel();
    expect(screen.getByText(/export duration sets the file.s ending/i)).toBeVisible();
    fireEvent.change(screen.getByRole('spinbutton',{name:'Duration (minutes)'}),{target:{value:'2'}});
    fireEvent.click(screen.getByRole('button',{name:'Save & export WAV'}));
    expect(await screen.findByRole('alert')).toHaveTextContent(/fade/i);
    expect(save).not.toHaveBeenCalled();expect(studioApi.createExport).not.toHaveBeenCalled();
  });

  it('checks the final saved scene again when fade settings change during saving',async()=>{
    let current={...scene,listeningTimer:{enabled:true,durationSeconds:2700,fadeInSeconds:0,fadeOutSeconds:60}};
    const save=vi.fn(async()=>{current={...current,revision:4,listeningTimer:{...current.listeningTimer,fadeOutSeconds:900}};return true;});
    render(<ExportPanel scene={current} dirty busy={false} missingAssets={false} onSave={save} getScene={()=>current}/>);
    await openPanel();fireEvent.click(screen.getByRole('button',{name:'Save & export WAV'}));
    expect(await screen.findByRole('alert')).toHaveTextContent(/fade/i);
    expect(save).toHaveBeenCalledOnce();expect(studioApi.createExport).not.toHaveBeenCalled();
  });

  it('uses the selected WAV duration even when the listening timer is shorter',async()=>{
    const current={...scene,listeningTimer:{enabled:true,durationSeconds:120,fadeInSeconds:15,fadeOutSeconds:30}};
    render(<ExportPanel scene={current} dirty={false} busy={false} missingAssets={false} onSave={vi.fn()} getScene={()=>current}/>);
    await openPanel();fireEvent.change(screen.getByRole('spinbutton',{name:'Duration (minutes)'}),{target:{value:'3'}});
    fireEvent.click(screen.getByRole('button',{name:'Export WAV'}));
    await waitFor(()=>expect(studioApi.createExport).toHaveBeenCalledWith(expect.objectContaining({durationSeconds:180})));
  });

  it('ignores retained Off fades for a short export',async()=>{
    const current={...scene,listeningTimer:{enabled:false,durationSeconds:2700,fadeInSeconds:30,fadeOutSeconds:180}};
    render(<ExportPanel scene={current} dirty={false} busy={false} missingAssets={false} onSave={vi.fn()} getScene={()=>current}/>);
    await openPanel();fireEvent.change(screen.getByRole('spinbutton',{name:'Duration (minutes)'}),{target:{value:'0.02'}});
    fireEvent.click(screen.getByRole('button',{name:'Export WAV'}));
    await waitFor(()=>expect(studioApi.createExport).toHaveBeenCalledWith(expect.objectContaining({durationSeconds:1.2})));
  });

  it('validates fades against the actual rounded PCM endpoint',async()=>{
    const current={...scene,listeningTimer:{enabled:true,durationSeconds:60,fadeInSeconds:0,fadeOutSeconds:1+.4/48000}};
    render(<ExportPanel scene={current} dirty={false} busy={false} missingAssets={false} onSave={vi.fn()} getScene={()=>current}/>);
    await openPanel();fireEvent.change(screen.getByRole('spinbutton',{name:'Duration (minutes)'}),{target:{value:String((1+.49/48000)/60)}});
    fireEvent.click(screen.getByRole('button',{name:'Export WAV'}));
    expect(await screen.findByRole('alert')).toHaveTextContent(/fade/i);expect(studioApi.createExport).not.toHaveBeenCalled();
  });

  it('saves first and exports the resulting exact revision',async()=>{
    let current=scene;
    const save=vi.fn(async()=>{current={...current,revision:4};return true;});
    render(<ExportPanel scene={scene} dirty busy={false} missingAssets={false} onSave={save} getScene={()=>current}/>);
    await openPanel();
    fireEvent.change(screen.getByRole('spinbutton',{name:'Duration (minutes)'}),{target:{value:'.5'}});
    fireEvent.click(screen.getByRole('button',{name:'Save & export WAV'}));
    await waitFor(()=>expect(studioApi.createExport).toHaveBeenCalledOnce());
    expect(save).toHaveBeenCalledOnce();
    expect(studioApi.createExport).toHaveBeenCalledWith(expect.objectContaining({sceneId:scene.id,expectedRevision:4,durationSeconds:30}));
    expect(await screen.findByRole('link',{name:'Download WAV'})).toHaveAttribute('download');
  });

  it('keeps the draft and does not export when a save leaves unsaved changes',async()=>{
    render(<ExportPanel scene={scene} dirty busy={false} missingAssets={false} onSave={vi.fn().mockResolvedValue(false)} getScene={()=>scene}/>);
    await openPanel();
    fireEvent.click(screen.getByRole('button',{name:'Save & export WAV'}));
    expect(await screen.findByRole('alert')).toHaveTextContent(/not been fully saved/);
    expect(studioApi.createExport).not.toHaveBeenCalled();
  });

  it('reconciles a lost submission response using exactly the same request identity',async()=>{
    vi.mocked(studioApi.createExport).mockRejectedValueOnce(new StudioApiError('NETWORK_ERROR',0,'Disconnected'));
    vi.mocked(studioApi.getExport).mockRejectedValueOnce(new StudioApiError('NOT_FOUND',404,'Not found'));
    render(<ExportPanel scene={scene} dirty={false} busy={false} missingAssets={false} onSave={vi.fn()} getScene={()=>scene}/>);
    await openPanel();
    fireEvent.click(screen.getByRole('button',{name:'Export WAV'}));
    const check=await screen.findByRole('button',{name:'Check export request'});
    await waitFor(()=>expect(check).toBeEnabled());
    const submitted=vi.mocked(studioApi.createExport).mock.calls[0]![0];
    expect(JSON.parse(localStorage.getItem('asmr-studio-pending-export')!)).toEqual(submitted);
    fireEvent.click(check);
    await screen.findByRole('link',{name:'Download WAV'});
    expect(studioApi.getExport).toHaveBeenCalledWith(submitted.requestId);
    expect(vi.mocked(studioApi.createExport).mock.calls).toEqual([[submitted],[submitted]]);
    expect(localStorage.getItem('asmr-studio-pending-export')).toBeNull();
  });

  it('does not erase a newly accepted job when an earlier empty poll arrives late',async()=>{
    let resolvePoll!:(jobs:ExportJob[])=>void;
    let resolvePost!:(result:ExportJob)=>void;
    vi.mocked(studioApi.listExports).mockResolvedValueOnce([]).mockImplementationOnce(()=>new Promise(resolve=>{resolvePoll=resolve;}));
    vi.mocked(studioApi.createExport).mockImplementationOnce(()=>new Promise(resolve=>{resolvePost=resolve;}));
    render(<ExportPanel scene={scene} dirty={false} busy={false} missingAssets={false} onSave={vi.fn()} getScene={()=>scene}/>);
    await openPanel();
    await waitFor(()=>expect(screen.getByRole('button',{name:'Refresh exports'})).toBeEnabled());
    fireEvent.click(screen.getByRole('button',{name:'Export WAV'}));
    await waitFor(()=>expect(studioApi.listExports).toHaveBeenCalledTimes(2));
    const submitted=vi.mocked(studioApi.createExport).mock.calls[0]![0];
    await act(async()=>resolvePost(job({id:submitted.requestId})));
    await act(async()=>resolvePoll([]));
    expect(screen.getByRole('status')).toHaveTextContent('Queued');
    expect(screen.getByRole('button',{name:'Cancel export'})).toBeEnabled();
  });

  it('shows recovered exports for the selected scene and no download for incomplete files',async()=>{
    vi.mocked(studioApi.listExports).mockResolvedValue([
      job({status:'interrupted',error:'The studio stopped before this export finished.'}),
      completed({id:'8d7e0750-9758-444a-a8fd-f6fe2d10ca56',sceneId:'another-session',title:'Another mix'}),
    ]);
    render(<ExportPanel scene={scene} dirty={false} busy={false} missingAssets={false} onSave={vi.fn()} getScene={()=>scene}/>);
    await openPanel();
    await screen.findByText('Interrupted',{exact:true});
    expect(screen.queryByRole('link',{name:'Download WAV'})).not.toBeInTheDocument();
    expect(screen.queryByText('Another mix')).not.toBeInTheDocument();
    expect(studioApi.createExport).not.toHaveBeenCalled();
  });
});
