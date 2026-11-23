import {parseScene,parseCapturedMix,parseAssetRecord,parseExportJob,type AssetImportMetadata,type AssetRecord,type CapturedMix,type Scene,type ExportJob,type ExportRequest} from '@asmr-studio/contracts';

export interface SceneSummary {
  id: string;
  title: string;
  revision: number;
  durationSeconds: number | null;
  layerCount: number;
  kind: 'mix' | 'transition';
}

export class StudioApiError extends Error {
  constructor(readonly code:string,readonly status:number,message:string,readonly currentRevision:number|null=null) {
    super(message);this.name='StudioApiError';
  }
}
export class StudioApi {
  private async request(path:string,options:RequestInit={}):Promise<unknown> {
    let response:Response;
    try {response=await fetch('/api'+path,{credentials:'same-origin',...options});}
    catch {throw new StudioApiError('NETWORK_ERROR',0,'The local studio could not be reached. Your edits are still here.');}
    const payload:unknown=await response.json().catch(()=>null);
    if(!response.ok) {
      const value=payload&&typeof payload==='object'?payload as Record<string,unknown>:{};
      const code=typeof value.code==='string'?value.code:'REQUEST_FAILED';
      const message=typeof value.message==='string'?value.message:'The studio could not complete the request';
      const revision=typeof value.currentRevision==='number'?value.currentRevision:null;
      throw new StudioApiError(code,response.status,message,revision);
    }
    return payload;
  }
  async listAssets():Promise<AssetRecord[]> {
    const value=await this.request('/assets');
    if(!Array.isArray(value)) throw new StudioApiError('INVALID_RESPONSE',0,'The audio library response was invalid');
    return value.map(parseAssetRecord);
  }
  async installStarterSounds():Promise<AssetRecord[]> {
    const value=await this.request('/library/install',{
      method:'POST',headers:{'content-type':'application/json'},body:'{}',
    });
    if(!Array.isArray(value)) throw new StudioApiError('INVALID_RESPONSE',0,'The starter library response was invalid');
    return value.map(parseAssetRecord);
  }
  async listScenes():Promise<SceneSummary[]> {
    const value=await this.request('/scenes');
    if(!Array.isArray(value)) throw new StudioApiError('INVALID_RESPONSE',0,'The saved sessions response was invalid');
    return value.map(item=>{
      if(!item||typeof item!=='object'||typeof item.id!=='string'||!item.id.trim()||
        typeof item.title!=='string'||!item.title.trim()||!Number.isSafeInteger(item.revision)||item.revision<1||
        !Number.isSafeInteger(item.layerCount)||item.layerCount<0||
        (item.kind!==undefined&&item.kind!=='mix'&&item.kind!=='transition')||
        (item.durationSeconds!==null&&(!Number.isFinite(item.durationSeconds)||item.durationSeconds<=0))) {
        throw new StudioApiError('INVALID_RESPONSE',0,'A saved session summary was invalid');
      }
      return {id:item.id,title:item.title,revision:item.revision,durationSeconds:item.durationSeconds,layerCount:item.layerCount,kind:item.kind??'mix'};
    });
  }
  async importAsset(file:File,metadata:AssetImportMetadata):Promise<AssetRecord> {
    // HTTP header values are byte strings. JSON Unicode escapes preserve names
    // such as emoji without changing the server's validated metadata protocol.
    const encodedMetadata=JSON.stringify(metadata).replace(/[\u007f-\uffff]/g,
      character=>'\\u'+character.charCodeAt(0).toString(16).padStart(4,'0'));
    return parseAssetRecord(await this.request('/assets',{
      method:'POST',headers:{'content-type':file.type||'application/octet-stream','x-asmr-metadata':encodedMetadata},
      body:file,
    }));
  }
  async createScene(scene:Scene):Promise<Scene> {
    return parseScene(await this.request('/scenes',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(scene)}));
  }
  async getScene(id:string):Promise<Scene> {
    return parseScene(await this.request('/scenes/'+encodeURIComponent(id)));
  }
  async captureScene(id:string,expectedRevision:number):Promise<CapturedMix> {
    return parseCapturedMix(await this.request('/scenes/'+encodeURIComponent(id)+'/capture',{
      method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({expectedRevision}),
    }));
  }
  async saveScene(scene:Scene,expectedRevision:number):Promise<Scene> {
    return parseScene(await this.request('/scenes/'+encodeURIComponent(scene.id),{
      method:'PUT',headers:{'content-type':'application/json'},body:JSON.stringify({scene,expectedRevision}),
    }));
  }
  async listExports():Promise<ExportJob[]> {
    const value=await this.request('/exports');
    if(!Array.isArray(value))throw new StudioApiError('INVALID_RESPONSE',0,'The finished mixes response was invalid');
    return value.map(parseExportJob);
  }
  async getExport(id:string):Promise<ExportJob> {
    return parseExportJob(await this.request('/exports/'+encodeURIComponent(id)));
  }
  async createExport(request:ExportRequest):Promise<ExportJob> {
    return parseExportJob(await this.request('/exports',{
      method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(request),
    }));
  }
  async cancelExport(id:string):Promise<ExportJob> {
    return parseExportJob(await this.request('/exports/'+encodeURIComponent(id)+'/cancel',{
      method:'POST',headers:{'content-type':'application/json'},body:'{}',
    }));
  }
}
export const studioApi=new StudioApi();
