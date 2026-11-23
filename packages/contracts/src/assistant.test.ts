import {describe,expect,it} from 'vitest';
import {createEmptyScene,SceneValidationError} from './scene.js';
import {
  parseAssistantCommandRequest,parseAssistantDeviceState,parseAssistantRegistrationRequest,
  parseAssistantAcknowledgement,parseAssistantCommandReceipt,
} from './assistant.js';

const state=()=>({stateVersion:0,scene:createEmptyScene('mix','Listening session'),savedRevision:null,dirty:false,
  playback:{state:'idle' as const,positionSeconds:0,error:null}});
const command=()=>({deviceId:'device-1',epoch:'connection-1',requestId:'request-1',expectedStateVersion:0,
  action:{type:'edit' as const,command:{type:'setMasterGain' as const,gain:.4}}});

describe('assistant control boundaries',()=>{
  it('uses the same validated scene adjustments as the mixer and detaches inputs',()=>{
    const input=command();const parsed=parseAssistantCommandRequest(input);
    input.action.command.gain=.8;
    expect(parsed.action).toEqual({type:'edit',command:{type:'setMasterGain',gain:.4}});
    expect(()=>parseAssistantCommandRequest({...command(),action:{type:'edit',command:{type:'setMasterGain',gain:2}}})).toThrow(SceneValidationError);
    expect(()=>parseAssistantDeviceState({...state(),scene:{...state().scene,masterGain:-1}})).toThrow(SceneValidationError);
  });

  it('requires explicit device, connection, request, and optimistic state identities',()=>{
    for(const key of ['deviceId','epoch','requestId','expectedStateVersion']){
      const input:Record<string,unknown>={...command()};delete input[key];
      expect(()=>parseAssistantCommandRequest(input)).toThrow(SceneValidationError);
    }
    for(const expectedStateVersion of [-1,.5,Number.MAX_SAFE_INTEGER+1])
      expect(()=>parseAssistantCommandRequest({...command(),expectedStateVersion})).toThrow(SceneValidationError);
    expect(()=>parseAssistantCommandRequest({...command(),deviceId:'../another-device'})).toThrow(SceneValidationError);
  });

  it('does not silently discard a draft when opening another saved session',()=>{
    expect(parseAssistantCommandRequest({...command(),action:{type:'openSavedSession',sceneId:'saved-mix'}}).action)
      .toEqual({type:'openSavedSession',sceneId:'saved-mix',discardUnsaved:false});
    expect(parseAssistantCommandRequest({...command(),action:{type:'openSavedSession',sceneId:'saved-mix',discardUnsaved:true}}).action)
      .toEqual({type:'openSavedSession',sceneId:'saved-mix',discardUnsaved:true});
  });

  it('keeps an unsaved draft, saved revision, and playback observations separate',()=>{
    const input={...state(),stateVersion:7,scene:{...state().scene,revision:3,masterGain:.6},savedRevision:3,dirty:true,
      playback:{state:'interrupted',positionSeconds:12,error:'needs-user-gesture',audioContextState:'suspended'}};
    expect(parseAssistantDeviceState(input)).toEqual(input);
    expect(()=>parseAssistantDeviceState({...input,savedRevision:0})).toThrow(SceneValidationError);
    expect(()=>parseAssistantDeviceState({...input,playback:{...input.playback,positionSeconds:NaN}})).toThrow(SceneValidationError);
  });

  it('rejects unrecognized fields, non-scene actions, and malformed acknowledgements',()=>{
    expect(()=>parseAssistantRegistrationRequest({name:'Browser tab',state:state(),controlToken:'injected'})).toThrow(SceneValidationError);
    expect(()=>parseAssistantCommandRequest({...command(),action:{type:'shell',command:'anything'}})).toThrow(SceneValidationError);
    expect(()=>parseAssistantAcknowledgement({epoch:'connection-1',requestId:'request-1',status:'playing',message:null,state:state()})).toThrow(SceneValidationError);
    expect(()=>parseAssistantRegistrationRequest({name:'\n',state:state()})).toThrow(SceneValidationError);
  });

  it('can represent an uncertain command without inventing a successful result',()=>{
    const receipt={deviceId:'device-1',epoch:'connection-1',requestId:'request-1',expectedStateVersion:0,status:'unconfirmed',
      submittedAt:100,expiresAt:200,completedAt:201,message:'Completion was not confirmed',result:null};
    expect(parseAssistantCommandReceipt(receipt)).toEqual(receipt);
  });
});
