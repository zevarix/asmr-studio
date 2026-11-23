import type {FastifyInstance} from 'fastify';
import {assistantRevokeSchema,parseWith} from '@asmr-studio/contracts';
import type {PlaybackDevices} from './playback-devices.js';

/** All routes retain buildApp's exact loopback Host/Origin check. */
export function registerAssistantRoutes(app:FastifyInstance,devices:PlaybackDevices):void {
  app.post('/api/assistant/devices',async(request,reply)=>reply.code(201).send(devices.register(request.body)));
  app.get('/api/assistant/devices',async request=>devices.list(request.headers['x-asmr-control-token']));
  app.get<{Params:{id:string};Querystring:{epoch:string}}>('/api/assistant/devices/:id',async request=>
    devices.get(request.params.id,request.query.epoch,request.headers['x-asmr-control-token']));
  app.post<{Params:{id:string}}>('/api/assistant/devices/:id/poll',async request=>
    devices.poll(request.params.id,request.headers['x-asmr-device-token'],request.body));
  app.post<{Params:{id:string}}>('/api/assistant/devices/:id/ack',async request=>
    devices.acknowledge(request.params.id,request.headers['x-asmr-device-token'],request.body));
  app.post<{Params:{id:string}}>('/api/assistant/devices/:id/revoke',async request=>{
    const {epoch}=parseWith(assistantRevokeSchema,request.body);
    return devices.revoke(request.params.id,epoch,request.headers['x-asmr-device-token']);
  });
  app.post<{Params:{id:string}}>('/api/assistant/devices/:id/commands',async(request,reply)=>
    reply.code(202).send(devices.submit(request.params.id,request.headers['x-asmr-control-token'],request.body)));
  app.get<{Params:{id:string;requestId:string};Querystring:{epoch:string}}>('/api/assistant/devices/:id/commands/:requestId',async request=>
    devices.receipt(request.params.id,request.query.epoch,request.params.requestId,request.headers['x-asmr-control-token']));
}
