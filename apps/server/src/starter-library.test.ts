import { afterEach, describe, expect, it } from 'vitest';
import { copyFile, readFile, rename, rmdir, writeFile } from 'node:fs/promises';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { createEmptyScene, type AssetImportMetadata } from '@asmr-studio/contracts';
import { AssetStore } from './assets.js';
import { openStore } from './store.js';
import { starterCatalog, type StarterSound } from './starter-catalog.js';
import { StarterLibrary } from './starter-library.js';
import { wavFixture } from '../../../tests/fixtures/audio.js';
import { fixtureLayer } from '../../../tests/fixtures/scene.js';

const roots:string[]=[];
const stores:ReturnType<typeof openStore>[]=[];
function openAssets(root:string) {
  const store = openStore(join(root,'studio.sqlite'));stores.push(store);
  const assets = new AssetStore({root:join(root,'media'),repository:store.assets,maxUploadBytes:1024*1024,decodedBudgetBytes:1024*1024,acceptedFormats:['wav']});
  return {store,assets};
}
function fixture(id='rain',frames=4410):{sound:StarterSound;bytes:Uint8Array} {
  const bytes = wavFixture({frames,sampleRate:44100});
  return {bytes,sound:{...structuredClone(starterCatalog[0]!),id,title:`Recording ${id}`,filename:`${id}.wav`,downloadUrl:`https://example.test/${id}.wav`,bytes:bytes.byteLength,sha256:createHash('sha256').update(bytes).digest('hex'),durationSeconds:frames/44100,sampleRate:44100,excerpt:{startSeconds:0,durationSeconds:frames/44100}}};
}
function preparedFixture():{sound:StarterSound;bytes:Uint8Array} {
  const source=fixture('window-rain');
  return {...source,sound:{...source.sound,preparation:'preserve-wav',recordingKind:'procedural-synthesis',
    downloadUrl:'https://github.com/zevarix/asmr-studio/releases/download/sounds-earshot-water-v1/window-rain.wav',
    preparationNotes:'Fixed attenuation already included.',preferredLoop:{startSeconds:0,endSeconds:source.sound.durationSeconds,crossfadeSeconds:0}}};
}
async function* content(bytes:Uint8Array){yield bytes;}
const licensedImport:AssetImportMetadata={displayName:'My imported water loop',roles:['ambience'],
  provenance:{kind:'licensed',source:'Previously imported Earshot output, with its source credits.'},
  rights:{privateUse:'permitted',redistribution:'permitted'}};
function fresh() {
  const root=mkdtempSync(join(tmpdir(),'asmr-starters-'));roots.push(root);
  return {root,...openAssets(root)};
}
const prepare = async (source:string,destination:string) => { await copyFile(source,destination); };
function response(bytes:Uint8Array):Response { return new Response(Buffer.from(bytes),{headers:{'content-length':String(bytes.byteLength)}}); }
function attributionFiles(root:string):string[] { return readdirSync(join(root,'starters','attribution')).sort().map(name=>join(root,'starters','attribution',name)); }
afterEach(()=>{stores.splice(0).forEach(store=>store.close());roots.splice(0).forEach(root=>rmSync(root,{recursive:true,force:true}));});

describe('fixed starter library installation',()=>{
  it('coalesces installation, preserves attribution and originals, and resumes from persisted assets',async()=>{
    const {root,assets,store}=fresh();const source=fixture();let fetches=0;
    const fetchSource:typeof fetch=async input=>{expect(String(input)).toBe(source.sound.downloadUrl);fetches++;return response(source.bytes);};
    const library=new StarterLibrary({root,assets,catalog:[source.sound],fetch:fetchSource,prepare});
    expect(library.catalog()[0]?.assetId).toBeNull();
    const [first,second]=await Promise.all([library.install(),library.install()]);
    expect(first[0]?.id).toBe(second[0]?.id);expect(fetches).toBe(1);expect(assets.list()).toHaveLength(1);
    expect(first[0]?.provenance.source).toContain(source.sound.attribution);
    expect(first[0]?.provenance.source).toContain('ASMR Studio excerpt: 0–0.1 seconds');
    expect(first[0]?.provenance.source).toContain(source.sound.sha256);
    expect(first[0]?.rights).toEqual({privateUse:'permitted',redistribution:'permitted'});
    expect(await readFile(join(root,'starters','originals',source.sound.filename))).toEqual(Buffer.from(source.bytes));
    const snapshots=attributionFiles(root);expect(snapshots).toHaveLength(1);
    const creditBytes=await readFile(snapshots[0]!);
    expect(snapshots[0]).toBe(join(root,'starters','attribution',`${createHash('sha256').update(creditBytes).digest('hex')}.json`));
    const credits=JSON.parse(creditBytes.toString('utf8'));
    expect(credits.sounds[0].creator).toBe(source.sound.creator);
    expect(credits.sounds[0].licenseUrl).toBe(source.sound.licenseUrl);
    expect(credits.sounds[0].upstreamEditor).toBe(source.sound.upstreamEditor);
    expect(credits.sounds[0].modifications).toContain('No loudness normalization');
    store.close();const reopened=openAssets(root);
    const afterRestart=new StarterLibrary({root,assets:reopened.assets,catalog:[source.sound],fetch:async()=>{throw new Error('Network must not be needed');},prepare});
    expect((await afterRestart.install())[0]?.id).toBe(first[0]?.id);
    expect(afterRestart.catalog()[0]?.assetId).toBe(first[0]?.id);
    expect(reopened.assets.list()).toHaveLength(1);expect(readdirSync(join(root,'starters','tmp'))).toEqual([]);
    expect(attributionFiles(root)).toEqual(snapshots);expect(await readFile(snapshots[0]!)).toEqual(creditBytes);
  });
  it('expands a legacy installation without changing existing sounds, private imports, saved sessions, or attribution',async()=>{
    const {root,assets,store}=fresh();const first=fixture('first'),second=fixture('second',8820);
    const initial=new StarterLibrary({root,assets,catalog:[first.sound],fetch:async()=>response(first.bytes),prepare});
    const [existing]=await initial.install();
    const legacy=join(root,'starters','attribution.json');
    // Reproduce the old on-disk layout using the installed sound and its original credits.
    await rename(attributionFiles(root)[0]!,legacy);await rmdir(join(root,'starters','attribution'));
    const legacyBytes=await readFile(legacy);
    async function* userRecording(){yield wavFixture({frames:13230,sampleRate:44100});}
    const imported=await assets.ingest(userRecording(),{displayName:'My recording',roles:['texture'],provenance:{kind:'original',source:null},rights:{privateUse:'permitted',redistribution:'unknown'}},'audio/wav');
    const scene=store.scenes.create({...createEmptyScene('saved-mix','Keep my mix'),layers:[fixtureLayer({assetId:existing!.id}),fixtureLayer({id:'my-recording',assetId:imported.id,role:'texture'})]});
    const previousAssets=assets.list();
    store.close();const reopened=openAssets(root);const downloads:string[]=[];
    const expanded=new StarterLibrary({root,assets:reopened.assets,catalog:[first.sound,second.sound],fetch:async input=>{downloads.push(String(input));return response(second.bytes);},prepare});
    const result=await expanded.install();
    expect(result[0]).toEqual(existing);expect(result).toHaveLength(2);
    expect(reopened.assets.list()).toEqual([...previousAssets,result[1]]);
    expect(reopened.store.scenes.get(scene.id)).toEqual(scene);
    expect(await readFile(legacy)).toEqual(legacyBytes);
    expect(await readFile(join(root,'starters','originals',first.sound.filename))).toEqual(Buffer.from(first.bytes));
    const snapshots=attributionFiles(root);expect(snapshots).toHaveLength(1);
    const credits=JSON.parse(await readFile(snapshots[0]!,'utf8'));
    expect(credits.sounds.map((sound:StarterSound)=>sound.id)).toEqual(['first','second']);
    expect(await expanded.install()).toEqual(result);
    expect(downloads).toEqual([second.sound.downloadUrl]);expect(attributionFiles(root)).toEqual(snapshots);
    expect(reopened.assets.list()).toEqual([...previousAssets,result[1]]);expect(reopened.store.scenes.get(scene.id)).toEqual(scene);
    expect(await readFile(legacy)).toEqual(legacyBytes);
  });
  it('rejects a wrong source hash before preparation or ingestion and leaves no partial source',async()=>{
    const {root,assets}=fresh();const source=fixture();const corrupt=source.bytes.slice();corrupt[corrupt.length-1]=corrupt[corrupt.length-1]!^1;let preparations=0;
    const library=new StarterLibrary({root,assets,catalog:[source.sound],fetch:async()=>response(corrupt),prepare:async()=>{preparations++;}});
    await expect(library.install()).rejects.toMatchObject({code:'STARTER_SOURCE_INTEGRITY'});
    expect(preparations).toBe(0);expect(assets.list()).toEqual([]);
    expect(readdirSync(join(root,'starters','originals'))).toEqual([]);expect(readdirSync(join(root,'starters','tmp'))).toEqual([]);
  });
  it('bounds streamed bytes and preserves a conflicting existing cache file',async()=>{
    const {root,assets}=fresh();const source=fixture();let fetches=0;
    const tooMuch=new Uint8Array(source.bytes.byteLength+1);
    const library=new StarterLibrary({root,assets,catalog:[source.sound],fetch:async()=>{fetches++;return new Response(tooMuch);},prepare});
    await expect(library.install()).rejects.toMatchObject({code:'STARTER_SOURCE_INTEGRITY'});
    expect(assets.list()).toEqual([]);expect(readdirSync(join(root,'starters','tmp'))).toEqual([]);
    const cache=join(root,'starters','originals',source.sound.filename);const unrelated=Buffer.from('Keep these existing bytes');await writeFile(cache,unrelated);
    await expect(library.install()).rejects.toMatchObject({code:'STARTER_CACHE_CONFLICT'});
    expect(fetches).toBe(1);expect(await readFile(cache)).toEqual(unrelated);expect(assets.list()).toEqual([]);
  });
  it('retains earlier attribution snapshots and resumes only unfinished preparation after a catalog expansion fails',async()=>{
    const {root,assets}=fresh();const first=fixture('first'),second=fixture('second',8820);let fail=true;
    const downloads:string[]=[];const prepared:string[]=[];
    const initial=new StarterLibrary({root,assets,catalog:[first.sound],fetch:async()=>response(first.bytes),prepare});
    const [retained]=await initial.install();const originalSnapshot=attributionFiles(root)[0]!;
    const originalCredits=await readFile(originalSnapshot);
    const library=new StarterLibrary({root,assets,catalog:[first.sound,second.sound],fetch:async input=>{downloads.push(String(input));return response(String(input)===first.sound.downloadUrl?first.bytes:second.bytes);},prepare:async(source,destination,sound)=>{
      prepared.push(sound.id);if(sound.id==='second'&&fail)throw new Error('Preparation interrupted');await copyFile(source,destination);
    }});
    await expect(library.install()).rejects.toThrow('Preparation interrupted');
    expect(assets.list()).toEqual([retained]);expect(attributionFiles(root)).toHaveLength(2);
    expect(library.catalog().map(sound=>sound.assetId)).toEqual([retained!.id,null]);
    fail=false;const result=await library.install();
    expect(result[0]).toEqual(retained);expect(result).toHaveLength(2);expect(assets.list()).toHaveLength(2);
    expect(downloads).toEqual([second.sound.downloadUrl]);expect(prepared).toEqual(['second','second']);
    expect(attributionFiles(root)).toHaveLength(2);expect(await readFile(originalSnapshot)).toEqual(originalCredits);
    expect(readdirSync(join(root,'starters','tmp'))).toEqual([]);
  });
  it('rejects a modified attribution snapshot without replacing it or changing installed assets',async()=>{
    const {root,assets}=fresh();const source=fixture();let fetches=0;
    const library=new StarterLibrary({root,assets,catalog:[source.sound],fetch:async()=>{fetches++;return response(source.bytes);},prepare});
    const installed=await library.install();const snapshot=attributionFiles(root)[0]!;
    const changed=await readFile(snapshot);changed[changed.length-1]=changed[changed.length-1]!^1;await writeFile(snapshot,changed);
    await expect(library.install()).rejects.toMatchObject({code:'STARTER_CACHE_CONFLICT'});
    expect(await readFile(snapshot)).toEqual(changed);expect(assets.list()).toEqual(installed);expect(fetches).toBe(1);
    expect(readdirSync(join(root,'starters','tmp'))).toEqual([]);
  });
  it('retains AssetStore audio validation for prepared output',async()=>{
    const {root,assets}=fresh();const source=fixture();
    const library=new StarterLibrary({root,assets,catalog:[source.sound],fetch:async()=>response(source.bytes),prepare:async(_source,destination)=>{await writeFile(destination,'not a WAV');}});
    await expect(library.install()).rejects.toThrow();expect(assets.list()).toEqual([]);
    expect(await readFile(join(root,'starters','originals',source.sound.filename))).toEqual(Buffer.from(source.bytes));
    expect(readdirSync(join(root,'starters','tmp'))).toEqual([]);
  });
  it('prepares actual mono and stereo excerpts with ffmpeg while retaining full source bytes',async()=>{
    const {root,assets}=fresh();
    const sources=([1,2] as const).map(channels=>{
      const bytes=wavFixture({channels,sampleRate:48000,frames:24000});
      return {bytes,sound:{...fixture(`channels-${channels}`).sound,channels,sampleRate:48000,durationSeconds:0.5,bytes:bytes.byteLength,sha256:createHash('sha256').update(bytes).digest('hex'),excerpt:{startSeconds:0.1,durationSeconds:0.25}}};
    });
    const library=new StarterLibrary({root,assets,catalog:sources.map(source=>source.sound),fetch:async input=>response(sources.find(source=>source.sound.downloadUrl===String(input))!.bytes)});
    const records=await library.install();
    expect(records.map(record=>record.channels)).toEqual([1,2]);
    for(const [index,record] of records.entries()){
      expect(record.sampleRate).toBe(44100);expect(record.durationSeconds).toBeCloseTo(0.25,5);expect(record.format).toBe('wav');
      expect(await readFile(join(root,'starters','originals',sources[index]!.sound.filename))).toEqual(Buffer.from(sources[index]!.bytes));
    }
  });
  it.each([12,-6])('applies %s dB with ffmpeg only to playback while zero gain preserves an existing asset',async gainDb=>{
    const {root,assets}=fresh();const source=fixture();let fetches=0;
    const fetchSource:typeof fetch=async()=>{fetches++;return response(source.bytes);};
    const original=new StarterLibrary({root,assets,catalog:[source.sound],fetch:fetchSource});
    const [unmodified]=await original.install();
    const zero=new StarterLibrary({root,assets,catalog:[{...source.sound,gainDb:0}],fetch:fetchSource});
    expect(await zero.install()).toEqual([unmodified]);
    expect(zero.catalog()[0]?.modifications).not.toContain('Fixed playback gain');
    const amplified=new StarterLibrary({root,assets,catalog:[{...source.sound,gainDb}],fetch:fetchSource});
    const [record]=await amplified.install();
    expect(record!.id).not.toBe(unmodified!.id);
    expect(record!.provenance.source).toContain(`Fixed playback gain: ${gainDb>0?'+':''}${gainDb} dB`);
    expect(record!.provenance.source).toContain('No loudness normalization');
    const chunks:Buffer[]=[];
    for await(const chunk of assets.openContent(record!.id).stream)chunks.push(Buffer.from(chunk));
    const wav=Buffer.concat(chunks);let pcm:Buffer|undefined;
    for(let offset=12;offset+8<=wav.length;){
      const size=wav.readUInt32LE(offset+4);
      if(wav.toString('ascii',offset,offset+4)==='data'){pcm=wav.subarray(offset+8,offset+8+size);break;}
      offset+=8+size+(size%2);
    }
    expect(pcm).toBeDefined();expect(pcm!.length).toBe(source.bytes.length-44);
    for(let offset=0;offset<pcm!.length;offset+=2){
      const input=offset%4===0?1200:-600;
      expect(Math.abs(pcm!.readInt16LE(offset)-input*10**(gainDb/20))).toBeLessThanOrEqual(1);
    }
    expect(await readFile(join(root,'starters','originals',source.sound.filename))).toEqual(Buffer.from(source.bytes));
    expect(assets.get(unmodified!.id)).toEqual(unmodified);expect(fetches).toBe(1);
  });
  it('rejects malformed or out-of-range gain before installation',()=>{
    const {root,assets}=fresh();const source=fixture();
    for(const gainDb of [-61,61,NaN,Infinity,-Infinity,null,'10',true,{}]){
      const sound={...source.sound,gainDb} as unknown as StarterSound;
      expect(()=>new StarterLibrary({root,assets,catalog:[sound]})).toThrow('Starter playback gain must be finite and between -60 and 60 dB');
    }
    for(const gainDb of [-60,60])expect(()=>new StarterLibrary({root,assets,catalog:[{...source.sound,gainDb}]})).not.toThrow();
    expect(assets.list()).toEqual([]);
  });
});

describe('prepared starter loops',()=>{
  it('publishes three prepared water entries with their distinct loop defaults alongside the original recordings',()=>{
    const {root,assets}=fresh();const library=new StarterLibrary({root,assets});
    const catalog=library.catalog();expect(catalog).toHaveLength(19);
    expect(catalog.filter(sound=>sound.preparation==='preserve-wav').map(sound=>({id:sound.id,kind:sound.recordingKind,loop:sound.preferredLoop}))).toEqual([
      {id:'window-rain',kind:'procedural-synthesis',loop:{startSeconds:0,endSeconds:20,crossfadeSeconds:0}},
      {id:'rain-on-wood',kind:'recording-reconstruction',loop:{startSeconds:0,endSeconds:20,crossfadeSeconds:0.02}},
      {id:'small-brook',kind:'recording-reconstruction',loop:{startSeconds:0,endSeconds:20,crossfadeSeconds:0.02}},
    ]);
    expect(catalog.slice(0,16).every(sound=>sound.preparation===undefined&&sound.preferredLoop===undefined)).toBe(true);
  });
  it('installs prepared WAV bytes unchanged and reuses them without another preparation or download',async()=>{
    const {root,assets}=fresh();const source=preparedFixture();let fetches=0;
    const library=new StarterLibrary({root,assets,catalog:[source.sound],fetch:async()=>{fetches++;return response(source.bytes);},
      prepare:async()=>{throw new Error('Prepared WAVs must bypass conversion');}});
    const [record]=await library.install();expect(record!.sha256).toBe(source.sound.sha256);
    expect(record!.durationSeconds).toBe(source.sound.durationSeconds);expect(record!.sampleRate).toBe(44100);
    const chunks:Buffer[]=[];for await(const chunk of assets.openContent(record!.id).stream)chunks.push(Buffer.from(chunk));
    expect(Buffer.concat(chunks)).toEqual(Buffer.from(source.bytes));
    expect(record!.provenance.source).toContain('installed byte-for-byte');
    expect(record!.provenance.source).toContain('Fixed attenuation already included');
    expect(await library.install()).toEqual([record]);expect(fetches).toBe(1);expect(assets.list()).toHaveLength(1);
    expect(library.catalog()[0]).toMatchObject({assetId:record!.id,preferredLoop:source.sound.preferredLoop});
    expect(await readFile(join(root,'starters','originals',source.sound.filename))).toEqual(Buffer.from(source.bytes));
    expect(readdirSync(join(root,'starters','tmp'))).toEqual([]);
  });
  it('recognizes an earlier licensed import by exact content without changing its name, provenance or saved mix',async()=>{
    const {root,assets,store}=fresh();const source=preparedFixture();
    const imported=await assets.ingest(content(source.bytes),licensedImport,'audio/wav');
    const scene=store.scenes.create({...createEmptyScene('existing-water','My existing mix'),layers:[fixtureLayer({assetId:imported.id,loop:{startSeconds:0.01,endSeconds:0.08,crossfadeSeconds:0.005}})]});
    const library=new StarterLibrary({root,assets,catalog:[source.sound],fetch:async()=>{throw new Error('Recognized imports must not download');}});
    expect(library.catalog()[0]?.assetId).toBe(imported.id);
    expect(await library.install()).toEqual([imported]);expect(assets.list()).toEqual([imported]);
    expect(store.scenes.get(scene.id)).toEqual(scene);
    expect(imported.displayName).not.toBe(source.sound.title);
    expect(library.catalog()[0]?.preferredLoop).toEqual(source.sound.preferredLoop);
  });
  it.each(['different-bytes','unknown-rights','wrong-role','unlicensed'] as const)('does not adopt an existing import with %s',async mismatch=>{
    const {root,assets}=fresh();const source=preparedFixture();const bytes=source.bytes.slice();
    const metadata=structuredClone(licensedImport);metadata.displayName=source.sound.title;
    if(mismatch==='different-bytes')bytes[bytes.length-1]=bytes[bytes.length-1]!^1;
    if(mismatch==='unknown-rights')metadata.rights.redistribution='unknown';
    if(mismatch==='wrong-role')metadata.roles=['texture'];
    if(mismatch==='unlicensed')metadata.provenance={kind:'original',source:null};
    const imported=await assets.ingest(content(bytes),metadata,'audio/wav');
    const library=new StarterLibrary({root,assets,catalog:[source.sound],fetch:async()=>response(source.bytes)});
    expect(library.catalog()[0]?.assetId).toBeNull();
    const [installed]=await library.install();expect(installed!.id).not.toBe(imported.id);
    expect(assets.get(imported.id)).toEqual(imported);expect(assets.list()).toHaveLength(2);
  });
  it('rejects invalid preferred loops and requests to process prepared files again',()=>{
    const {root,assets}=fresh();const source=preparedFixture();
    for(const preferredLoop of [null,{startSeconds:-1,endSeconds:0.1,crossfadeSeconds:0},
      {startSeconds:0,endSeconds:0.1,crossfadeSeconds:0.06},{startSeconds:0,endSeconds:0.2,crossfadeSeconds:0},
      {startSeconds:0,endSeconds:NaN,crossfadeSeconds:0}]){
      expect(()=>new StarterLibrary({root,assets,catalog:[{...source.sound,preferredLoop} as StarterSound]})).toThrow('Invalid starter preferred loop');
    }
    for(const changes of [{gainDb:0},{sampleRate:48000},{excerpt:{startSeconds:0.01,durationSeconds:0.09}},
      {filename:'water.flac'},{bytes:source.sound.bytes+2},{preparation:'convert'}]){
      expect(()=>new StarterLibrary({root,assets,catalog:[{...source.sound,...changes,preferredLoop:{startSeconds:0,endSeconds:0.05,crossfadeSeconds:0}} as StarterSound]})).toThrow('Prepared starter sounds require');
    }
  });
  it('rejects a pinned prepared file with an unexpected PCM format before ingestion',async()=>{
    const {root,assets}=fresh();const source=preparedFixture();const bytes=source.bytes.slice();
    new DataView(bytes.buffer).setUint16(34,24,true);
    const sound={...source.sound,sha256:createHash('sha256').update(bytes).digest('hex')};
    const library=new StarterLibrary({root,assets,catalog:[sound],fetch:async()=>response(bytes)});
    await expect(library.install()).rejects.toMatchObject({code:'STARTER_PREPARATION_FAILED'});
    expect(assets.list()).toEqual([]);expect(readdirSync(join(root,'starters','tmp'))).toEqual([]);
  });
});

describe('fixed release asset downloads',()=>{
  const assetUrl='https://release-assets.githubusercontent.com/github-production-release-asset/example?signature=fixture';
  it('follows one approved signed asset redirect using the same bounded transfer signal',async()=>{
    const {root,assets}=fresh();const source=preparedFixture();const calls:Array<{url:string;options:RequestInit|undefined}>=[];
    const library=new StarterLibrary({root,assets,catalog:[source.sound],fetch:async(input,options)=>{
      calls.push({url:String(input),options});
      return calls.length===1?new Response(null,{status:302,headers:{location:assetUrl}}):response(source.bytes);
    }});
    const [installed]=await library.install();expect(installed!.sha256).toBe(source.sound.sha256);
    expect(calls.map(call=>[call.url,call.options?.redirect])).toEqual([[source.sound.downloadUrl,'manual'],[assetUrl,'error']]);
    expect(calls[0]!.options?.signal).toBeInstanceOf(AbortSignal);
    expect(calls[1]!.options?.signal).toBe(calls[0]!.options?.signal);
  });
  it.each([
    'http://release-assets.githubusercontent.com/file.wav','https://example.test/file.wav',
    'https://release-assets.githubusercontent.com.evil.test/file.wav','https://user:secret@release-assets.githubusercontent.com/file.wav',
    'https://release-assets.githubusercontent.com:443/file.wav','https://release-assets.githubusercontent.com:444/file.wav',
    'https://release-assets.githubusercontent.com/file.wav#fragment','/relative.wav',
  ])('rejects an unapproved release redirect to %s',async location=>{
    const {root,assets}=fresh();const source=preparedFixture();let calls=0;
    const library=new StarterLibrary({root,assets,catalog:[source.sound],fetch:async()=>{calls++;return new Response(null,{status:302,headers:{location}});}});
    await expect(library.install()).rejects.toMatchObject({code:'STARTER_DOWNLOAD_FAILED'});
    expect(calls).toBe(1);expect(assets.list()).toEqual([]);expect(readdirSync(join(root,'starters','tmp'))).toEqual([]);
  });
  it('rejects a second redirect and retains redirect rejection for other fixed sources',async()=>{
    const {root,assets}=fresh();const source=preparedFixture();let calls=0;
    const library=new StarterLibrary({root,assets,catalog:[source.sound],fetch:async()=>{calls++;return new Response(null,{status:302,headers:{location:assetUrl}});}});
    await expect(library.install()).rejects.toMatchObject({code:'STARTER_DOWNLOAD_FAILED'});expect(calls).toBe(2);
    let mode:RequestRedirect|undefined;
    const normal=fixture();const ordinary=new StarterLibrary({root,assets,catalog:[normal.sound],fetch:async(_input,options)=>{
      mode=options?.redirect;return new Response(null,{status:302,headers:{location:assetUrl}});
    }});
    await expect(ordinary.install()).rejects.toMatchObject({code:'STARTER_DOWNLOAD_FAILED'});expect(mode).toBe('error');
    expect(assets.list()).toEqual([]);
  });
  it('still verifies exact bytes after a permitted redirect',async()=>{
    const {root,assets}=fresh();const source=preparedFixture();const corrupt=source.bytes.slice();corrupt[corrupt.length-1]=corrupt[corrupt.length-1]!^1;let calls=0;
    const library=new StarterLibrary({root,assets,catalog:[source.sound],fetch:async()=>++calls===1?
      new Response(null,{status:302,headers:{location:assetUrl}}):response(corrupt)});
    await expect(library.install()).rejects.toMatchObject({code:'STARTER_SOURCE_INTEGRITY'});
    expect(assets.list()).toEqual([]);expect(readdirSync(join(root,'starters','originals'))).toEqual([]);expect(readdirSync(join(root,'starters','tmp'))).toEqual([]);
  });
});
