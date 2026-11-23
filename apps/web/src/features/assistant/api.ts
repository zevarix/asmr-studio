import {parseAssistantRegistration,parseAssistantPollResponse,parseAssistantCommandReceipt,type AssistantDeviceState,type AssistantAcknowledgement,type AssistantRegistration} from '@asmr-studio/contracts';
import {StudioApiError} from '../../api.js';

async function request(path:string,body:unknown,browserToken?:string,keepalive=false):Promise<unknown>{
  const controller=new AbortController();
  // A lost poll or ACK must not leave a connection or its next command waiting indefinitely.
  const timeout=setTimeout(()=>controller.abort(),8000);
  try{
    let response:Response;let payload:unknown;
    try{
      response=await fetch('/api/assistant'+path,{method:'POST',credentials:'same-origin',keepalive,signal:controller.signal,
        headers:{'content-type':'application/json',...(browserToken?{'x-asmr-device-token':browserToken}:{})},body:JSON.stringify(body)});
      payload=await response.json();
    }catch{throw new StudioApiError('NETWORK_ERROR',0,'The local studio connection was interrupted.');}
    if(!response.ok){
      const code=payload&&typeof payload==='object'&&'code' in payload&&payload.code==='STATE_CONFLICT'?'STATE_CONFLICT':'ASSISTANT_REQUEST_FAILED';
      throw new StudioApiError(code,response.status,'The assistant connection could not accept this observation.');
    }
    return payload;
  }finally{clearTimeout(timeout);}
}
export const assistantApi={
  register:async(name:string,state:AssistantDeviceState)=>parseAssistantRegistration(await request('/devices',{name,state})),
  poll:async(connection:AssistantRegistration,state:AssistantDeviceState)=>parseAssistantPollResponse(await request(
    '/devices/'+encodeURIComponent(connection.deviceId)+'/poll',{epoch:connection.epoch,state},connection.browserToken)),
  acknowledge:async(connection:AssistantRegistration,result:AssistantAcknowledgement)=>{parseAssistantCommandReceipt(await request(
    '/devices/'+encodeURIComponent(connection.deviceId)+'/ack',result,connection.browserToken));},
  revoke:async(connection:AssistantRegistration)=>{await request(
    '/devices/'+encodeURIComponent(connection.deviceId)+'/revoke',{epoch:connection.epoch},connection.browserToken,true);},
};
