import {afterEach,describe,expect,it} from 'vitest';
import {mkdtempSync,rmSync,readdirSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';import {join} from 'node:path';import {createHash} from 'node:crypto';
import {openStore} from './store.js';import {AssetStore} from './assets.js';
import {fixtureAsset} from '../../../tests/fixtures/scene.js';import {wavFixture} from '../../../tests/fixtures/audio.js';
const roots:string[]=[];const stores:ReturnType<typeof openStore>[]=[];
function fresh(limits:Record<string,number>={}){const root=mkdtempSync(join(tmpdir(),'asmr-assets-'));roots.push(root);const database=openStore(join(root,'studio.sqlite'));stores.push(database);const assets=new AssetStore({root:join(root,'media'),repository:database.assets,maxUploadBytes:1024*1024,decodedBudgetBytes:1024*1024,acceptedFormats:['wav'],...limits});return{root,database,assets};}
function metadata(){const {id,sha256,durationSeconds,sampleRate,channels,format,...data}=fixtureAsset();return data;}
async function* bytes(data:Uint8Array){yield data;}
async function collect(stream:AsyncIterable<Uint8Array>){const pieces:Buffer[]=[];for await(const part of stream)pieces.push(Buffer.from(part));return Buffer.concat(pieces);}
afterEach(()=>{stores.splice(0).forEach(s=>s.close());roots.splice(0).forEach(p=>rmSync(p,{recursive:true,force:true}));});

describe('managed audio assets',()=>{
  it('probes hashes and serves exact bytes without using a filename as a path',async()=>{
    const {root,assets}=fresh();const input=wavFixture();const record=await assets.ingest(bytes(input),{...metadata(),displayName:'../../escape.wav'},'audio/wav');
    expect(record.sha256).toBe(createHash('sha256').update(input).digest('hex'));expect(record.channels).toBe(2);expect(record.sampleRate).toBe(48000);expect(record.durationSeconds).toBeCloseTo(0.1,5);
    expect(existsSync(join(root,'escape.wav'))).toBe(false);expect(assets.list()).toEqual([record]);
    expect(await collect(assets.openContent(record.id).stream)).toEqual(Buffer.from(input));
    const ranged=assets.openContent(record.id,{start:4,endInclusive:7});expect(ranged.totalBytes).toBe(input.length);expect(await collect(ranged.stream)).toEqual(Buffer.from(input.slice(4,8)));
    expect(()=>assets.openContent('../../escape.wav')).toThrow();
    expect(()=>assets.openContent(record.id,{start:0,endInclusive:input.length})).toThrow();
  });
  it('deduplicates bytes while preserving separate provenance declarations',async()=>{
    const {root,assets}=fresh();const one=await assets.ingest(bytes(wavFixture()),metadata());
    const two=await assets.ingest(bytes(wavFixture()),{...metadata(),displayName:'Other declaration',provenance:{kind:'licensed',source:'Test license'}});
    expect(two.id).not.toBe(one.id);expect(two.sha256).toBe(one.sha256);expect(assets.get(one.id)?.provenance).toEqual({kind:'original',source:null});expect(assets.list()).toHaveLength(2);
    expect(readdirSync(join(root,'media','blobs'))).toHaveLength(1);
  });
  it('rejects corrupt content and false MIME declarations without partial records',async()=>{
    const {root,assets}=fresh();await expect(assets.ingest(bytes(new TextEncoder().encode('not audio')),metadata())).rejects.toThrow();
    await expect(assets.ingest(bytes(wavFixture()),metadata(),'audio/mpeg')).rejects.toThrow();
    expect(assets.list()).toEqual([]);expect(readdirSync(join(root,'media','tmp'))).toEqual([]);expect(readdirSync(join(root,'media','blobs'))).toEqual([]);
  });
  it('cleans an interrupted stream and refuses undeclared private-use permission',async()=>{
    const {root,assets}=fresh();async function* interrupted(){yield wavFixture();throw new Error('upload interrupted');}
    await expect(assets.ingest(interrupted(),metadata())).rejects.toThrow();
    await expect(assets.ingest(bytes(wavFixture()),{...metadata(),rights:{privateUse:'unknown',redistribution:'unknown'}})).rejects.toThrow();
    expect(assets.list()).toEqual([]);expect(readdirSync(join(root,'media','tmp'))).toEqual([]);
  });
  it('enforces configured byte and decoded-memory budgets',async()=>{
    const a=fresh({maxUploadBytes:100});await expect(a.assets.ingest(bytes(wavFixture()),metadata())).rejects.toThrow();expect(a.assets.list()).toEqual([]);
    const b=fresh({decodedBudgetBytes:100});await expect(b.assets.ingest(bytes(wavFixture()),metadata())).rejects.toThrow();expect(b.assets.list()).toEqual([]);
  });
});
