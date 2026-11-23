import {McpServer} from '@modelcontextprotocol/server';
import {z} from 'zod';
import {assistantCommandRequestSchema} from '@asmr-studio/contracts';
import {AssistantClient,ControlError} from './client.js';

const identity=z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/);
const selected=z.strictObject({deviceId:identity,epoch:identity});
async function result(operation:()=>Promise<Record<string,unknown>>){
  try{
    const value=await operation();
    return {content:[{type:'text' as const,text:JSON.stringify(value)}],structuredContent:value};
  }catch(error){
    const value=error instanceof ControlError?{code:error.code,message:error.message}
      :{code:'INVALID_STUDIO_RESULT',message:'The studio result could not be validated. Read the selected device state before continuing.'};
    return {isError:true,content:[{type:'text' as const,text:JSON.stringify(value)}],structuredContent:value};
  }
}
export function createAssistantServer(client:AssistantClient):McpServer {
  const server=new McpServer({name:'asmr-studio',version:'0.0.0'});
  server.registerTool('list_playback_devices',{
    description:'List the browser tab paired with this local connection. Choose its deviceId and epoch explicitly for later calls. An old observation does not prove current playback.',
    inputSchema:z.strictObject({}),annotations:{readOnlyHint:true},
  },()=>result(async()=>({devices:await client.devices()})));
  server.registerTool('get_playback_device',{
    description:'Read the selected tab: displayed draft, stateVersion, savedRevision, dirty flag, observed playback, and observation freshness. These are separate facts.',
    inputSchema:selected,annotations:{readOnlyHint:true},
  },input=>result(async()=>({device:await client.device(input.deviceId,input.epoch)})));
  server.registerTool('list_assets',{
    description:'List recordings already in the local library for this paired tab, with roles, durations, and source rights. This does not download, import, generate, or start audio.',
    inputSchema:selected,annotations:{readOnlyHint:true},
  },input=>result(async()=>({assets:await client.assets(input.deviceId,input.epoch)})));
  server.registerTool('list_saved_sessions',{
    description:'List saved sessions available to the paired tab. A saved scene is distinct from that tab\'s current unsaved mix.',
    inputSchema:selected,annotations:{readOnlyHint:true},
  },input=>result(async()=>({sessions:await client.sessions(input.deviceId,input.epoch)})));
  server.registerTool('submit_session_command',{
    description:'Adjust only the explicitly selected tab through the same validated browser mixer operations. Read fresh stateVersion first. Use a unique requestId for each intent and retain that ID to reconcile retries. The returned receipt may be queued; query get_command_result before claiming success. Edits are unsaved until an explicit save. openSavedSession rejects dirty drafts unless discardUnsaved is true. play may require a browser gesture.',
    inputSchema:assistantCommandRequestSchema,annotations:{readOnlyHint:false,destructiveHint:true,idempotentHint:true},
  },input=>result(async()=>({receipt:await client.submit(input)})));
  server.registerTool('get_command_result',{
    description:'Reconcile an original requestId after submission or an uncertain network response. applied confirms browser acknowledgement, not subjective audio quality. unconfirmed means a delivered command lacks a timely acknowledgement; read current device state and never blindly submit a new request ID.',
    inputSchema:selected.extend({requestId:identity}),annotations:{readOnlyHint:true},
  },input=>result(async()=>({receipt:await client.receipt(input.deviceId,input.epoch,input.requestId)})));
  server.registerTool('undo_session_command',{
    description:'Undo the latest successful assistant edit only while its result is still current. Requires the current stateVersion and a new requestId. Newer local/assistant changes cause a conflict; transport, saving, and opening sessions are not undoable.',
    inputSchema:selected.extend({requestId:identity,expectedStateVersion:z.number().int().nonnegative(),originalRequestId:identity}),
    annotations:{readOnlyHint:false,destructiveHint:false,idempotentHint:true},
  },input=>result(async()=>({receipt:await client.submit({deviceId:input.deviceId,epoch:input.epoch,
    requestId:input.requestId,expectedStateVersion:input.expectedStateVersion,action:{type:'undo',requestId:input.originalRequestId}})})));
  return server;
}
