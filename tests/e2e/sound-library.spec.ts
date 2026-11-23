import {test,expect,type Page} from '@playwright/test';
import {wavFixture} from '../fixtures/audio.js';
import {openAudioImport} from './import-controls.js';

interface SourceEvidence {id:number;source:AudioBufferSourceNode;stopped:boolean}
interface AudioEvidence {meter:AnalyserNode|null;sources:SourceEvidence[]}

async function observeNativeAudio(page:Page) {
  await page.addInitScript(()=>{
    const evidence:{meter:AnalyserNode|null;sources:{id:number;source:AudioBufferSourceNode;stopped:boolean}[]}={meter:null,sources:[]};
    Object.assign(window,{asmrLibraryAudio:evidence});
    const createMeter=AudioContext.prototype.createAnalyser;
    AudioContext.prototype.createAnalyser=function(){
      const meter=createMeter.call(this);evidence.meter=meter;return meter;
    };
    const createSource=AudioContext.prototype.createBufferSource;
    AudioContext.prototype.createBufferSource=function(){
      const source=createSource.call(this);
      const record={id:evidence.sources.length,source,stopped:false};
      evidence.sources.push(record);
      const stop=source.stop.bind(source);
      source.stop=(when?:number)=>{record.stopped=true;stop(when);};
      return source;
    };
  });
}
async function outputPeak(page:Page):Promise<number> {
  return page.evaluate(()=>{
    const meter=(window as unknown as {asmrLibraryAudio:AudioEvidence}).asmrLibraryAudio.meter;
    if(!meter)return 0;
    const samples=new Float32Array(meter.fftSize);meter.getFloatTimeDomainData(samples);
    return Math.max(...Array.from(samples,value=>Math.abs(value)));
  });
}
async function position(page:Page):Promise<number> {
  const text=await page.getByLabel('Elapsed time',{exact:true}).textContent();
  const clock=/(\d+):(\d{2})/.exec(text??'');
  if(!clock)throw new Error('Transport clock is not rendered');
  return Number(clock[1])*60+Number(clock[2]);
}
async function importSound(page:Page,name:string,role:'ambience'|'texture') {
  await openAudioImport(page);
  await page.getByLabel('Audio file').setInputFiles({name,mimeType:'audio/wav',buffer:Buffer.from(wavFixture({frames:48000,channels:2}))});
  await page.getByRole('combobox',{name:'Sound role'}).selectOption(role);
  await page.getByRole('combobox',{name:'Source declaration'}).selectOption('original');
  await page.getByRole('textbox',{name:'Source or attribution'}).fill('Generated PCM fixture for browser tests');
  await page.getByRole('checkbox',{name:/permission to listen privately/i}).check();
  await page.getByRole('button',{name:'Import audio',exact:true}).click();
  await expect(page.getByRole('button',{name:'Add '+name+' as '+role})).toBeVisible();
}

test('sound tiles preserve live playback and a named mix reopens with its layer settings',async({page})=>{
  await observeNativeAudio(page);
  const sceneId='library-live-save-open';
  await page.goto('/?scene='+sceneId);
  await importSound(page,'Library rain.wav','ambience');
  await importSound(page,'Library brush.wav','texture');
  await page.getByRole('searchbox',{name:'Search sounds'}).fill('Library');
  const library=page.getByRole('region',{name:'Sound library'});
  await library.getByRole('button',{name:'Add Library rain.wav as ambience'}).click();
  await library.getByRole('slider',{name:'Library rain.wav volume'}).fill('30');
  await page.getByRole('button',{name:'Start listening'}).click();
  await expect(page.getByRole('status').first()).toContainText('Playing');
  await expect.poll(()=>outputPeak(page)).toBeGreaterThan(.0001);
  await expect.poll(()=>position(page)).toBeGreaterThanOrEqual(2);
  const before=await position(page);
  const initialPeak=await outputPeak(page);
  const firstLoopId=await page.evaluate(()=>{
    const evidence=(window as unknown as {asmrLibraryAudio:AudioEvidence}).asmrLibraryAudio;
    const loop=evidence.sources.find(record=>record.source.loop&&!record.stopped);
    if(!loop)throw new Error('No native loop source was created');
    return loop.id;
  });
  const firstLoopStillRunning=()=>page.evaluate(id=>{
    const evidence=(window as unknown as {asmrLibraryAudio:AudioEvidence}).asmrLibraryAudio;
    return evidence.sources.some(record=>record.id===id&&!record.stopped&&record.source.buffer!==null);
  },firstLoopId);

  await library.getByRole('button',{name:'Add Library brush.wav as texture'}).click();
  await expect.poll(()=>outputPeak(page)).toBeGreaterThan(initialPeak*1.5);
  expect(await firstLoopStillRunning()).toBe(true);
  expect(await position(page)).toBeGreaterThanOrEqual(before);
  await library.getByRole('button',{name:'Remove Library brush.wav from mix'}).click();
  await expect.poll(()=>outputPeak(page)).toBeLessThan(initialPeak*1.1);
  expect(await firstLoopStillRunning()).toBe(true);
  expect(await position(page)).toBeGreaterThanOrEqual(before);
  await expect(page.getByRole('status').first()).toContainText('Playing');

  await library.getByRole('button',{name:'Add Library brush.wav as texture'}).click();
  const brush=page.getByRole('region',{name:'Active mix'}).getByRole('group',{name:/Texture:/});
  await brush.getByRole('slider',{name:'Stereo position'}).fill('60');
  await brush.getByText('Loop details',{exact:true}).click();
  await brush.getByRole('spinbutton',{name:'Loop start'}).fill('0.1');
  await brush.getByRole('spinbutton',{name:'Loop end'}).fill('0.8');
  await brush.getByRole('spinbutton',{name:'Loop crossfade'}).fill('0.05');
  await brush.getByRole('button',{name:'Apply loop'}).click();
  expect(await firstLoopStillRunning()).toBe(true);
  await page.getByRole('textbox',{name:'Session name'}).fill('Evening layers');
  await page.getByRole('textbox',{name:'Session name'}).press('Tab');
  await page.getByRole('button',{name:'Save session',exact:true}).click();
  await expect(page.getByText('Saved revision 1',{exact:true})).toBeVisible();
  const saved=await(await page.request.get('/api/scenes/'+sceneId)).json();
  expect(saved.title).toBe('Evening layers');
  expect(saved.layers).toHaveLength(2);
  expect(saved.layers.find((layer:{role:string})=>layer.role==='texture')).toMatchObject({pan:.6,loop:{startSeconds:.1,endSeconds:.8,crossfadeSeconds:.05}});

  await page.getByRole('button',{name:'Stop',exact:true}).click();
  await page.getByRole('button',{name:'New session',exact:true}).click();
  await expect(page.getByRole('textbox',{name:'Session name'})).toHaveValue('Untitled session');
  await expect(page.getByRole('button',{name:'Start listening'})).toBeDisabled();
  await page.getByRole('combobox',{name:'Open saved session'}).selectOption(sceneId);
  await expect(page.getByRole('textbox',{name:'Session name'})).toHaveValue('Evening layers');
  await expect(page.getByRole('region',{name:'Active mix'}).getByRole('group',{name:/Texture:/}).getByRole('slider',{name:'Stereo position'})).toHaveValue('60');
  await expect(library.getByRole('slider',{name:'Library rain.wav volume'})).toHaveValue('30');
  await expect(page.getByRole('status').first()).not.toContainText('Playing');
  await page.getByRole('button',{name:'Start listening'}).click();
  await expect.poll(()=>outputPeak(page)).toBeGreaterThan(.0001);
  await expect(page.getByRole('status').first()).toContainText('Playing');
});
