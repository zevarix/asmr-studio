import {randomUUID} from 'node:crypto';
import {expect,test,type Page} from '@playwright/test';
import type {AssetRecord,Scene} from '@asmr-studio/contracts';
import {wavFixture} from '../fixtures/audio.js';

async function seedScene(page:Page,origin:string){
  const title='Occasional fixture '+randomUUID().slice(0,8),assets:AssetRecord[]=[];
  for(const [index,suffix] of ['primary','neighbor','alternate'].entries()){
    const bytes=wavFixture({frames:24000+index*4800,channels:1});
    const samples=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);
    for(const [frame,character] of [...randomUUID()].entries())samples.setInt16(44+frame*2,character.charCodeAt(0),true);
    const response=await page.request.post('/api/assets',{headers:{origin,'content-type':'audio/wav','x-asmr-metadata':JSON.stringify({
      displayName:title+' '+suffix,roles:['texture'],provenance:{kind:'original',source:'Generated PCM for occasional playback UI tests'},
      rights:{privateUse:'permitted',redistribution:'permitted'}})},data:Buffer.from(bytes)});
    expect(response.status(),await response.text()).toBe(201);
    assets.push(await response.json() as AssetRecord);
  }
  const scene:Scene={schemaVersion:1,id:randomUUID(),title,revision:0,masterGain:.4,durationSeconds:null,layers:assets.slice(0,2).map((asset,index)=>({
    id:index?'neighbor':'selected',assetId:asset.id,role:'texture',gain:.3,pan:0,muted:false,solo:false,startSeconds:0,
    loop:{startSeconds:0,endSeconds:asset.durationSeconds,crossfadeSeconds:0}}))};
  const response=await page.request.post('/api/scenes',{headers:{origin},data:scene});
  expect(response.status(),await response.text()).toBe(201);
  return {scene:await response.json() as Scene,primary:assets[0]!,alternate:assets[2]!};
}

interface LoopStart {id:number;stops:number;ended:boolean}
async function observeLoops(page:Page){
  await page.addInitScript(()=>{
    const loops:LoopStart[]=[];
    Object.assign(window,{occasionalUiLoops:loops});
    const create=AudioContext.prototype.createBufferSource;
    AudioContext.prototype.createBufferSource=function(){
      const source=create.call(this),start=source.start.bind(source),stop=source.stop.bind(source);
      let record:LoopStart|null=null;
      source.start=(...args:Parameters<typeof start>)=>{
        if(source.loop){
          record={id:loops.length,stops:0,ended:false};loops.push(record);
          source.addEventListener('ended',()=>{if(record)record.ended=true;});
        }
        start(...args);
      };
      source.stop=(...args:Parameters<typeof stop>)=>{if(record)record.stops++;stop(...args);};
      return source;
    };
  });
}
const readLoops=(page:Page)=>page.evaluate(()=>(window as unknown as {occasionalUiLoops:LoopStart[]}).occasionalUiLoops);
async function readScene(page:Page,id:string):Promise<Scene>{
  const response=await page.request.get('/api/scenes/'+id);
  expect(response.status()).toBe(200);
  return await response.json() as Scene;
}

test('edits occasional playback during listening, preserves the neighboring loop and reopens the saved sequence',async({page,baseURL},testInfo)=>{
  test.setTimeout(60_000);
  await observeLoops(page);
  const {scene,primary,alternate}=await seedScene(page,new URL(baseURL!).origin);
  await page.goto('/?scene='+scene.id);
  await expect(page.getByRole('textbox',{name:'Session name'})).toHaveValue(scene.title);
  const layer=page.getByRole('group',{name:'Texture: selected',exact:true});
  const mode=layer.getByRole('combobox',{name:'Playback mode'});
  const panel=layer.getByRole('group',{name:primary.displayName+' occasional playback',exact:true});
  const minimum=panel.getByRole('spinbutton',{name:'Minimum pause'}),maximum=panel.getByRole('spinbutton',{name:'Maximum pause'});
  const apply=panel.getByRole('button',{name:'Apply pauses'}),add=panel.getByRole('button',{name:'Add',exact:true});
  const choice=panel.getByRole('combobox',{name:'Alternate recording',exact:true}),search=panel.getByRole('searchbox');
  const remove=panel.getByRole('button',{name:'Remove alternate '+alternate.displayName,exact:true});
  const level=panel.getByRole('slider',{name:/Level variation/}),position=panel.getByRole('slider',{name:/Position variation/});
  const save=async(revision:number)=>{
    await page.getByRole('button',{name:'Save session',exact:true}).click();
    await expect(page.getByText('Saved revision '+revision,{exact:true})).toBeVisible();
    return readScene(page,scene.id);
  };
  await expect(mode).toHaveValue('standard');await mode.selectOption('occasional');
  await expect(minimum).toHaveValue('4');await expect(maximum).toHaveValue('12');
  const initial=(await save(2)).layers[0]!.occasional!;
  await page.getByRole('button',{name:'Start listening',exact:true}).click();
  await expect.poll(()=>readLoops(page)).toEqual([{id:0,stops:0,ended:false}]);
  await minimum.fill('20');await expect(minimum).toHaveAttribute('aria-invalid','true');await expect(apply).toBeDisabled();
  await expect(page.getByText('Unsaved changes',{exact:true})).not.toBeVisible();
  expect((await readScene(page,scene.id)).layers[0]!.occasional).toEqual(initial);
  await minimum.fill('.25');await maximum.fill('.5');await apply.click();
  await search.fill(alternate.displayName);await choice.selectOption(alternate.id);await add.click();
  await expect(remove).toBeVisible();await remove.click();await expect(remove).toHaveCount(0);
  await choice.selectOption(alternate.id);await add.click();
  await level.fill('15');await position.fill('11');
  await panel.getByRole('button',{name:'New variation',exact:true}).click();
  const edited=await save(3),settings=edited.layers[0]!.occasional!;
  expect(settings).toEqual({...initial,enabled:true,minPauseSeconds:.25,maxPauseSeconds:.5,levelVariation:.15,panVariation:.11,
    alternateAssetIds:[alternate.id],seed:expect.any(Number)});
  expect(settings.seed).not.toBe(initial.seed);expect(edited.layers[0]!.loop).toEqual(scene.layers[0]!.loop);
  expect(edited.layers[1]).toEqual(scene.layers[1]);expect(await readLoops(page)).toEqual([{id:0,stops:0,ended:false}]);
  const transport=page.getByRole('region',{name:'Playback controls'});
  await expect(transport.getByRole('status')).toHaveText('Playing');
  await transport.getByRole('button',{name:'Stop',exact:true}).click();
  const copied=page.waitForResponse(response=>response.request().method()==='POST'&&new URL(response.url()).pathname==='/api/scenes');
  await page.getByRole('button',{name:'Save a copy',exact:true}).click();
  const copyResponse=await copied;expect(copyResponse.status()).toBe(201);
  const copy=await copyResponse.json() as Scene;expect(copy.id).not.toBe(scene.id);expect(copy.layers).toEqual(edited.layers);
  await page.goto('/?scene='+copy.id);await expect(mode).toHaveValue('occasional');await expect(remove).toBeVisible();
  await expect(minimum).toHaveValue('0.25');await expect(maximum).toHaveValue('0.5');
  await expect(level).toHaveValue('15');await expect(position).toHaveValue('11');
  const wrapper=layer.locator('.occasional-playback');
  for(const width of [1280,390,320]){
    await page.setViewportSize({width,height:900});await wrapper.scrollIntoViewIfNeeded();
    const geometry=await wrapper.evaluate(element=>{
      const box=element.getBoundingClientRect();
      return {viewport:innerWidth,pageWidth:document.documentElement.scrollWidth,left:box.left,right:box.right,
        client:element.clientWidth,scroll:element.scrollWidth,controls:[...element.querySelectorAll('input,select,button,summary')].map(el=>{
          const r=el.getBoundingClientRect();return {name:el.getAttribute('aria-label')??el.textContent,left:r.left,right:r.right,height:r.height,width:r.width};
        })};
    });
    expect(geometry.pageWidth).toBeLessThanOrEqual(width);expect(geometry.left).toBeGreaterThanOrEqual(0);
    expect(geometry.right).toBeLessThanOrEqual(width+1);expect(geometry.scroll).toBeLessThanOrEqual(geometry.client+1);
    for(const control of geometry.controls){
      expect(control.left,control.name??'').toBeGreaterThanOrEqual(geometry.left-1);
      expect(control.right,control.name??'').toBeLessThanOrEqual(geometry.right+1);
      if(width<700){expect(control.width,control.name??'').toBeGreaterThanOrEqual(42);expect(control.height,control.name??'').toBeGreaterThanOrEqual(42);}
    }
    await testInfo.attach('occasional-controls-'+width,{body:await wrapper.screenshot(),contentType:'image/png'});
  }
  await mode.selectOption('standard');await expect(panel).toHaveCount(0);
  await page.getByRole('button',{name:'Save session',exact:true}).click();
  await expect(page.getByText('Saved revision 2',{exact:true})).toBeVisible();
  const disabled=await readScene(page,copy.id);
  expect(disabled.layers[0]).toEqual({...edited.layers[0],occasional:{...settings,enabled:false}});
  await page.reload();await expect(mode).toHaveValue('standard');
  await mode.selectOption('occasional');await expect(remove).toBeVisible();await expect(level).toHaveValue('15');
});
