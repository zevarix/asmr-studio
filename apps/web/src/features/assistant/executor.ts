import {parseScene,parseAssistantDeviceState,type AssistantAcknowledgement,type AssistantDeviceState,type AssistantPendingCommand,type Scene,type SceneCommand} from '@asmr-studio/contracts';

export class AssistantControlError extends Error {
  constructor(readonly code:string,message:string){super(message);this.name='AssistantControlError';}
}

export interface AssistantHost {
  getState:()=>AssistantDeviceState;
  isBusy:()=>boolean;
  prepareAudio:()=>Promise<void>;
  edit:(command:SceneCommand,isCurrent:()=>boolean)=>Promise<void>;
  play:(isCurrent:()=>boolean)=>Promise<void>;
  pause:()=>void;
  stop:()=>void;
  save:()=>Promise<boolean>;
  open:(id:string,isCurrent:()=>boolean)=>Promise<void>;
  restore:(scene:Scene,expectedVersion:number,isCurrent:()=>boolean)=>Promise<void>;
}

/** One browser executor owns acknowledgements; receiving a request is not applying it. */
export function createAssistantExecutor(getHost:()=>AssistantHost,now:()=>number=Date.now) {
  let running=false;
  let undo:{requestId:string;scene:Scene;stateVersion:number}|null=null;
  const handled=new Set<string>();
  return async(command:AssistantPendingCommand,connected:()=>boolean):Promise<AssistantAcknowledgement>=>{
    const host=getHost();
    const acknowledgement=(status:AssistantAcknowledgement['status'],message:string|null):AssistantAcknowledgement=>({
      epoch:command.epoch,requestId:command.requestId,status,message,state:host.getState(),
    });
    const key=command.deviceId+'/'+command.epoch+'/'+command.requestId;
    if(handled.has(key))return acknowledgement('rejected','ALREADY_HANDLED: This request was already handled; it was not repeated.');
    if(running)return acknowledgement('rejected','BUSY: Another assistant command is still running.');
    const current=()=>connected()&&now()<command.expiresAt;
    if(!current())return acknowledgement('rejected','EXPIRED: This connection or command is no longer current.');
    const before=parseAssistantDeviceState(host.getState());
    if(before.stateVersion!==command.expectedStateVersion)
      return acknowledgement('rejected','STALE_STATE: The session changed. Read its current state before trying another command.');
    if(host.isBusy())return acknowledgement('rejected','BUSY: A session operation is still running.');
    const action=command.action;
    if(action.type==='openSavedSession'&&before.dirty&&!action.discardUnsaved)
      return acknowledgement('rejected','UNSAVED_CHANGES: Save this draft or explicitly choose to discard it before opening another session.');
    if(action.type==='undo'&&(!undo||undo.requestId!==action.requestId||undo.stateVersion!==before.stateVersion||undo.scene.id!==before.scene.id))
      return acknowledgement('rejected','UNDO_UNAVAILABLE: Only the last assistant edit can be undone, before any newer change.');
    running=true;
    handled.add(key);
    if(handled.size>64)handled.delete(handled.values().next().value!);
    let timeout:ReturnType<typeof setTimeout>|undefined;
    try {
      const operation=(async()=>{switch(action.type){
        case 'edit': await host.edit(action.command,current);break;
        case 'play': await host.play(current);break;
        case 'pause': host.pause();break;
        case 'stop': host.stop();break;
        case 'save': if(!await host.save())throw new AssistantControlError('SAVE_INCOMPLETE','Saving did not confirm the complete current draft. An earlier submitted snapshot may have been saved; check savedRevision, unsaved changes, and any browser conflict before retrying.');break;
        case 'openSavedSession': await host.open(action.sceneId,current);break;
        case 'undo': await host.restore(undo!.scene,before.stateVersion,current);break;
      }})();
      await Promise.race([operation,new Promise<never>((_,reject)=>{
        timeout=setTimeout(()=>reject(new AssistantControlError('EXPIRED','The command deadline passed before completion. Read the current state before retrying.')),Math.max(0,command.expiresAt-now()));
      })]);
      if(!current())throw new AssistantControlError('EXPIRED','The command ended after its connection or deadline expired. Its current state is reported separately.');
      const after=host.getState();
      if(after.stateVersion!==before.stateVersion+1)
        throw new AssistantControlError('SUPERSEDED','A newer change occurred while this command was running. Read the current state.');
      if(action.type==='play'&&after.playback.state!=='playing')
        throw new AssistantControlError('NEEDS_USER_GESTURE','Audio did not start. Press Start listening in this browser, then retry.');
      undo=action.type==='edit'?{requestId:command.requestId,scene:parseScene(before.scene),stateVersion:after.stateVersion}:null;
      return acknowledgement('applied',null);
    }catch(error){
      const message=error instanceof AssistantControlError?error.code+': '+error.message
        :'APPLY_FAILED: The command could not be applied to playback. Check the browser and read the current state before retrying.';
      return acknowledgement('failed',message);
    }finally{if(timeout)clearTimeout(timeout);running=false;}
  };
}
