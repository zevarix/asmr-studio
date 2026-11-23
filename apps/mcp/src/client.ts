import {parseAssetRecord,parseAssistantCommandReceipt,parseAssistantCommandRequest,
  parseAssistantDeviceView,type AssistantCommandRequest,type AssistantDeviceView} from '@asmr-studio/contracts';
import {z} from 'zod';

export interface Configuration {origin:string;token:string}
export class ControlError extends Error {
  constructor(readonly code:string,message:string){super(message);this.name='ControlError';}
}
export function readConfiguration(env:Record<string,string|undefined>):Configuration {
  const token=env['ASMR_CONTROL_TOKEN'];
  if(!token||! /^[a-f0-9]{64}$/.test(token))throw new Error('Set ASMR_CONTROL_TOKEN to the credential shown by the enabled studio tab.');
  let url:URL;
  try{url=new URL(env['ASMR_STUDIO_URL']??'http://127.0.0.1:4318');}
  catch{throw new Error('ASMR_STUDIO_URL must be a loopback HTTP origin.');}
  if(url.protocol!=='http:'||!['127.0.0.1','localhost','[::1]'].includes(url.hostname)
    ||url.username||url.password||url.pathname!=='/'||url.search||url.hash)
    throw new Error('ASMR_STUDIO_URL must be a loopback HTTP origin without credentials, paths, or query parameters.');
  return {origin:url.origin,token};
}
const summary=z.object({id:z.string(),title:z.string(),revision:z.number().int().positive(),
  durationSeconds:z.number().positive().nullable(),layerCount:z.number().int().nonnegative(),kind:z.enum(['mix','transition']).optional()});
export class AssistantClient {
  constructor(private readonly config:Configuration,private readonly fetcher:typeof fetch=fetch){}
  private async request(path:string,body?:unknown):Promise<unknown>{
    let response:Response;
    try{
      response=await this.fetcher(new URL('/api'+path,this.config.origin),{
        method:body===undefined?'GET':'POST',redirect:'error',signal:AbortSignal.timeout(8000),
        headers:{origin:this.config.origin,'x-asmr-control-token':this.config.token,
          ...(body===undefined?{}:{'content-type':'application/json'})},
        ...(body===undefined?{}:{body:JSON.stringify(body)}),
      });
    }catch{
      throw new ControlError(body===undefined?'STUDIO_UNAVAILABLE':'OUTCOME_UNCONFIRMED',body===undefined
        ?'The local studio could not be reached. Open it and check the connection.'
        :'The command outcome is unconfirmed. Reconcile its original request ID; do not submit a new command as a retry.');
    }
    const data:unknown=await response.json().catch(()=>null);
    if(!response.ok){
      const error=data&&typeof data==='object'?data as Record<string,unknown>:{};
      throw new ControlError(typeof error['code']==='string'?error['code']:'STUDIO_ERROR',
        typeof error['message']==='string'?error['message']:'The local studio rejected the request.');
    }
    return data;
  }
  async devices():Promise<AssistantDeviceView[]>{
    const value=await this.request('/assistant/devices');
    if(!Array.isArray(value))throw new ControlError('INVALID_RESPONSE','The paired-device response was invalid.');
    return value.map(parseAssistantDeviceView);
  }
  async device(deviceId:string,epoch:string):Promise<AssistantDeviceView>{
    return parseAssistantDeviceView(await this.request('/assistant/devices/'+encodeURIComponent(deviceId)+'?epoch='+encodeURIComponent(epoch)));
  }
  private async requireConnected(deviceId:string,epoch:string):Promise<void>{
    const device=await this.device(deviceId,epoch);
    if(!device.connected)throw new ControlError('DEVICE_DISCONNECTED','Enable assistant control in the selected browser tab again.');
  }
  async assets(deviceId:string,epoch:string){
    await this.requireConnected(deviceId,epoch);
    const value=await this.request('/assets');
    if(!Array.isArray(value))throw new ControlError('INVALID_RESPONSE','The sound-library response was invalid.');
    return value.map(parseAssetRecord);
  }
  async sessions(deviceId:string,epoch:string){
    await this.requireConnected(deviceId,epoch);
    return z.array(summary).parse(await this.request('/scenes'));
  }
  async submit(input:AssistantCommandRequest){
    const request=parseAssistantCommandRequest(input);
    return parseAssistantCommandReceipt(await this.request('/assistant/devices/'+encodeURIComponent(request.deviceId)+'/commands',request));
  }
  async receipt(deviceId:string,epoch:string,requestId:string){
    return parseAssistantCommandReceipt(await this.request('/assistant/devices/'+encodeURIComponent(deviceId)
      +'/commands/'+encodeURIComponent(requestId)+'?epoch='+encodeURIComponent(epoch)));
  }
}
