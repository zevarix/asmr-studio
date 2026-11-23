import {createHash,randomBytes,randomUUID,timingSafeEqual} from 'node:crypto';
import {
  parseAssistantAcknowledgement,parseAssistantCommandRequest,parseAssistantDeviceState,
  parseAssistantPollRequest,parseAssistantRegistrationRequest,
  type AssistantAcknowledgement,type AssistantCommandReceipt,type AssistantCommandRequest,
  type AssistantDeviceState,type AssistantDeviceView,type AssistantPendingCommand,
  type AssistantPollResponse,type AssistantRegistration,type AssistantStateSummary,
} from '@asmr-studio/contracts';
import {StudioError} from './errors.js';

interface RetainedCommand {
  fingerprint:string;
  receipt:AssistantCommandReceipt;
  acknowledgementFingerprint?:string;
}
interface Device {
  id:string;epoch:string;name:string;browserHash:Buffer;controlHash:Buffer;
  state:AssistantDeviceState;lastSeenAt:number;observedAt:number;revokedAt:number|null;
  commands:Map<string,RetainedCommand>;pending:AssistantPendingCommand|null;
}
export interface PlaybackDevicesOptions {
  now?:()=>number;
  heartbeatIntervalMs?:number;
  leaseMs?:number;
  commandTimeoutMs?:number;
  retentionMs?:number;
  maxDevices?:number;
  maxCommandsPerDevice?:number;
}
const digest=(value:string):Buffer=>createHash('sha256').update(value).digest();
const fingerprint=(value:unknown):string=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const copy=<T>(value:T):T=>structuredClone(value);
function tokenMatches(raw:unknown,expected:Buffer):boolean {
  return typeof raw==='string'&&/^[a-f0-9]{64}$/.test(raw)&&timingSafeEqual(digest(raw),expected);
}
function stateSummary(state:AssistantDeviceState):AssistantStateSummary {
  const {scene:_,...summary}=state;return copy(summary);
}
function draftIdentity(state:AssistantDeviceState):string {
  return JSON.stringify({scene:state.scene,savedRevision:state.savedRevision,dirty:state.dirty});
}
function positive(value:number):number {
  if(!Number.isSafeInteger(value)||value<=0)throw new Error('Assistant control limits must be positive integers');
  return value;
}

/** Ephemeral delivery, not a source of truth for saved scenes or audible playback. */
export class PlaybackDevices {
  private readonly devices=new Map<string,Device>();
  private readonly now:()=>number;
  private readonly heartbeatIntervalMs:number;
  private readonly leaseMs:number;
  private readonly commandTimeoutMs:number;
  private readonly retentionMs:number;
  private readonly maxDevices:number;
  private readonly maxCommandsPerDevice:number;

  constructor(options:PlaybackDevicesOptions={}) {
    this.now=options.now??Date.now;
    this.heartbeatIntervalMs=positive(options.heartbeatIntervalMs??1000);
    this.leaseMs=positive(options.leaseMs??15000);
    this.commandTimeoutMs=positive(options.commandTimeoutMs??15000);
    this.retentionMs=positive(options.retentionMs??300000);
    this.maxDevices=positive(options.maxDevices??16);
    // Do not forget a request ID within an epoch: forgetting could replay an uncertain edit.
    this.maxCommandsPerDevice=positive(options.maxCommandsPerDevice??512);
  }

  register(input:unknown):AssistantRegistration {
    const {name,state}=parseAssistantRegistrationRequest(input);
    const now=this.now();this.sweep(now);
    if(this.devices.size>=this.maxDevices)throw new StudioError('DEVICE_LIMIT','Too many assistant connections; disable an unused connection and try again later',429);
    const browserToken=randomBytes(32).toString('hex');
    const controlToken=randomBytes(32).toString('hex');
    const device:Device={id:randomUUID(),epoch:randomUUID(),name,browserHash:digest(browserToken),controlHash:digest(controlToken),
      state,lastSeenAt:now,observedAt:now,revokedAt:null,commands:new Map(),pending:null};
    this.devices.set(device.id,device);
    return {deviceId:device.id,epoch:device.epoch,browserToken,controlToken,
      heartbeatIntervalMs:this.heartbeatIntervalMs,commandTimeoutMs:this.commandTimeoutMs};
  }

  list(controlToken:unknown):AssistantDeviceView[] {
    const now=this.now();this.sweep(now);
    let selected:Device|undefined;
    for(const device of this.devices.values())if(tokenMatches(controlToken,device.controlHash))selected=device;
    if(!selected)throw this.unauthorized();
    return [this.view(selected,now)];
  }

  get(deviceId:string,epoch:string,controlToken:unknown):AssistantDeviceView {
    const device=this.authorize(deviceId,controlToken,'control');this.assertEpoch(device,epoch);
    return this.view(device,this.now());
  }

  submit(deviceId:string,controlToken:unknown,input:unknown):AssistantCommandReceipt {
    const request=parseAssistantCommandRequest(input);
    const device=this.authorize(deviceId,controlToken,'control');
    this.assertEpoch(device,request.epoch);
    if(request.deviceId!==deviceId)throw new StudioError('DEVICE_MISMATCH','The command names a different playback device',409);
    const now=this.now();this.expire(device,now);
    const identity=fingerprint(request);const previous=device.commands.get(request.requestId);
    if(previous){
      if(previous.fingerprint!==identity)throw new StudioError('REQUEST_ID_CONFLICT','This request ID already names a different command',409);
      return copy(previous.receipt);
    }
    if(!this.connected(device,now))throw new StudioError('DEVICE_DISCONNECTED','The selected browser is no longer connected; inspect its current state before retrying',410);
    if(device.pending)throw new StudioError('DEVICE_BUSY','A command is awaiting acknowledgement; inspect its receipt before sending another',409);
    if(request.expectedStateVersion!==device.state.stateVersion)throw new StudioError('STATE_CONFLICT','The selected browser has changed; read its current state before editing',409);
    if(device.commands.size>=this.maxCommandsPerDevice)throw new StudioError('COMMAND_LIMIT','This connection has reached its receipt limit; reconnect assistant control to start a new command session',429);
    const receipt:AssistantCommandReceipt={deviceId,epoch:device.epoch,requestId:request.requestId,expectedStateVersion:request.expectedStateVersion,
      status:'queued',submittedAt:now,expiresAt:now+this.commandTimeoutMs,completedAt:null,message:null,result:null};
    device.commands.set(request.requestId,{fingerprint:identity,receipt});
    device.pending={...request,expiresAt:receipt.expiresAt};
    return copy(receipt);
  }

  receipt(deviceId:string,epoch:string,requestId:string,controlToken:unknown):AssistantCommandReceipt {
    const device=this.authorize(deviceId,controlToken,'control');this.assertEpoch(device,epoch);this.expire(device,this.now());
    const command=device.commands.get(requestId);
    if(!command)throw new StudioError('COMMAND_NOT_FOUND','The selected connection has no receipt for this request ID',404);
    return copy(command.receipt);
  }

  poll(deviceId:string,browserToken:unknown,input:unknown):AssistantPollResponse {
    const report=parseAssistantPollRequest(input);
    const device=this.authorize(deviceId,browserToken,'browser');this.assertEpoch(device,report.epoch);
    const now=this.now();this.expire(device,now);
    // Expiring the lease is terminal. A delayed heartbeat cannot revive old control credentials.
    if(!this.connected(device,now))throw new StudioError('DEVICE_DISCONNECTED','Enable assistant control again to create a new connection',410);
    this.observe(device,report.state,now);
    const pending=device.pending;
    if(!pending)return {command:null};
    const retained=device.commands.get(pending.requestId)!;
    if(retained.receipt.status!=='queued')return {command:null};
    if(pending.expectedStateVersion!==device.state.stateVersion){
      this.finish(device,retained,'rejected','The browser changed before delivery; read its current state before editing',now);
      return {command:null};
    }
    retained.receipt.status='dispatched';
    return {command:copy(pending)};
  }

  acknowledge(deviceId:string,browserToken:unknown,input:unknown):AssistantCommandReceipt {
    const acknowledgement=parseAssistantAcknowledgement(input);
    const device=this.authorize(deviceId,browserToken,'browser');this.assertEpoch(device,acknowledgement.epoch);
    const now=this.now();this.expire(device,now);
    const retained=device.commands.get(acknowledgement.requestId);
    if(!retained)throw new StudioError('COMMAND_NOT_FOUND','This connection has no command with that request ID',404);
    const identity=fingerprint(acknowledgement);
    if(retained.acknowledgementFingerprint){
      if(retained.acknowledgementFingerprint!==identity)throw new StudioError('ACKNOWLEDGEMENT_CONFLICT','This command already has a different acknowledgement',409);
      return copy(retained.receipt);
    }
    if(!this.connected(device,now)||retained.receipt.status==='expired'||retained.receipt.status==='unconfirmed'||retained.receipt.status==='disconnected')
      throw new StudioError('ACKNOWLEDGEMENT_EXPIRED','This command is no longer accepting acknowledgements; its outcome remains unconfirmed',410);
    if(retained.receipt.status!=='dispatched'||device.pending?.requestId!==acknowledgement.requestId)
      throw new StudioError('ACKNOWLEDGEMENT_CONFLICT','The command is not awaiting acknowledgement',409);
    this.validateAcknowledgement(device,retained.receipt,acknowledgement);
    this.observe(device,acknowledgement.state,now);
    retained.acknowledgementFingerprint=identity;
    this.finish(device,retained,acknowledgement.status,acknowledgement.message,now,stateSummary(acknowledgement.state));
    return copy(retained.receipt);
  }

  revoke(deviceId:string,epoch:string,browserToken:unknown):{revoked:true} {
    const device=this.authorize(deviceId,browserToken,'browser');this.assertEpoch(device,epoch);
    const now=this.now();device.revokedAt??=now;this.expire(device,now);
    return {revoked:true};
  }

  close():void {this.devices.clear();}

  private authorize(deviceId:string,token:unknown,kind:'browser'|'control'):Device {
    this.sweep(this.now());
    const device=this.devices.get(deviceId);
    if(!device||!tokenMatches(token,kind==='browser'?device.browserHash:device.controlHash))throw this.unauthorized();
    return device;
  }
  private unauthorized():StudioError {return new StudioError('ASSISTANT_UNAUTHORIZED','A valid token for this playback connection is required',401);}
  private assertEpoch(device:Device,epoch:string):void {
    if(device.epoch!==epoch)throw new StudioError('CONNECTION_CONFLICT','This command belongs to a different browser connection',409);
  }
  private connected(device:Device,now:number):boolean {return device.revokedAt===null&&now-device.lastSeenAt<this.leaseMs;}
  private observe(device:Device,input:AssistantDeviceState,now:number):void {
    const state=parseAssistantDeviceState(input);
    if(state.stateVersion<device.state.stateVersion||state.stateVersion===device.state.stateVersion&&draftIdentity(state)!==draftIdentity(device.state))
      throw new StudioError('STATE_CONFLICT','An older or conflicting browser observation cannot replace the current state',409);
    device.state=state;device.lastSeenAt=now;device.observedAt=now;
  }
  private validateAcknowledgement(device:Device,receipt:AssistantCommandReceipt,ack:AssistantAcknowledgement):void {
    if(ack.state.stateVersion<device.state.stateVersion||ack.state.stateVersion<receipt.expectedStateVersion)
      throw new StudioError('STALE_ACKNOWLEDGEMENT','An older acknowledgement cannot replace newer browser state',409);
    if(ack.status==='applied'&&ack.state.stateVersion<=receipt.expectedStateVersion)
      throw new StudioError('INVALID_ACKNOWLEDGEMENT','An applied command must identify its resulting browser state version',409);
  }
  private view(device:Device,now:number):AssistantDeviceView {
    this.expire(device,now);
    return copy({deviceId:device.id,epoch:device.epoch,name:device.name,connected:this.connected(device,now),lastSeenAt:device.lastSeenAt,
      observedAt:device.observedAt,state:device.state});
  }
  private finish(device:Device,command:RetainedCommand,status:AssistantCommandReceipt['status'],message:string|null,now:number,result:AssistantStateSummary|null=null):void {
    command.receipt={...command.receipt,status,message,completedAt:now,result};
    if(device.pending?.requestId===command.receipt.requestId)device.pending=null;
  }
  private expire(device:Device,now:number):void {
    const pending=device.pending;if(!pending)return;
    const command=device.commands.get(pending.requestId)!;
    if(now<pending.expiresAt&&this.connected(device,now))return;
    if(command.receipt.status==='dispatched')this.finish(device,command,'unconfirmed',
      'The browser did not confirm completion before this command expired or disconnected. Read current state; do not assume the action did not occur.',now);
    else this.finish(device,command,this.connected(device,now)?'expired':'disconnected','The command was not delivered before this connection or command expired',now);
  }
  private sweep(now:number):void {
    for(const [id,device] of this.devices){
      this.expire(device,now);
      const inactiveSince=device.revokedAt??device.lastSeenAt;
      if(!this.connected(device,now)&&now-inactiveSince>=this.retentionMs)this.devices.delete(id);
    }
  }
}
