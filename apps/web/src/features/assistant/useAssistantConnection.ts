import {useEffect,useRef,useState} from 'react';
import type {AssistantRegistration} from '@asmr-studio/contracts';
import {assistantApi} from './api.js';
import {AssistantControlError,createAssistantExecutor,type AssistantHost} from './executor.js';
import {StudioApiError} from '../../api.js';

export function useAssistantConnection(host:AssistantHost){
  const latest=useRef(host);latest.current=host;
  const executor=useRef<ReturnType<typeof createAssistantExecutor>|null>(null);
  if(!executor.current)executor.current=createAssistantExecutor(()=>latest.current);
  const active=useRef<AssistantRegistration|null>(null);
  const generation=useRef(0);
  const timer=useRef<ReturnType<typeof setTimeout>|null>(null);
  const executing=useRef<Promise<void>|null>(null);
  const [connection,setConnection]=useState<AssistantRegistration|null>(null);
  const [connecting,setConnecting]=useState(false);
  const [message,setMessage]=useState('');
  const stop=()=>{
    generation.current++;
    if(timer.current){clearTimeout(timer.current);timer.current=null;}
    const previous=active.current;active.current=null;
    setConnection(null);setConnecting(false);
    if(previous)void assistantApi.revoke(previous).catch(()=>{});
  };
  useEffect(()=>()=>{
    generation.current++;
    if(timer.current)clearTimeout(timer.current);
    const previous=active.current;active.current=null;
    if(previous)void assistantApi.revoke(previous).catch(()=>{});
  },[]);
  const connect=async(name:string)=>{
    if(active.current||connecting)return;
    const attempt=++generation.current;
    setConnecting(true);setMessage('');
    let registered:AssistantRegistration|null=null;
    try{
      // Called directly by the Enable button: resume begins inside the real gesture.
      await latest.current.prepareAudio();
      if(attempt!==generation.current)return;
      registered=await assistantApi.register(name,latest.current.getState());
      if(attempt!==generation.current){void assistantApi.revoke(registered).catch(()=>{});return;}
      const owned=registered;active.current=owned;setConnection(owned);setConnecting(false);
      const current=()=>active.current===owned&&attempt===generation.current;
      const poll=async()=>{
        if(!current())return;
        try{
          const {command}=await assistantApi.poll(owned,latest.current.getState());
          if(!current())return;
          if(command){
            if(command.deviceId!==owned.deviceId||command.epoch!==owned.epoch)throw new Error('Unexpected playback target');
            const previous=executing.current;
            const task=(async()=>{
              // The server may accept an ACK before its HTTP response reaches us.
              // Keep a following delivery serialized behind that completion.
              if(previous)await previous;
              if(!current())return;
              const result=await executor.current!(command,current);
              if(!current())return;
              try{await assistantApi.acknowledge(owned,result);}
              catch{
                if(current())setMessage('The command finished without a confirmed receipt. Read the current playback state before retrying.');
              }
            })();
            executing.current=task;
            void task.then(()=>{if(executing.current===task)executing.current=null;},()=>{
              if(executing.current===task)executing.current=null;
              if(current()){stop();setMessage('Assistant controls stopped after an unexpected command error.');}
            });
          }
          // Heartbeats continue while an audio decode or saved-session operation is pending.
          if(current())timer.current=setTimeout(()=>{void poll();},owned.heartbeatIntervalMs);
        }catch(error){
          if(current()&&error instanceof StudioApiError&&error.status===409&&error.code==='STATE_CONFLICT'){
            // A newer acknowledgement can overtake an earlier heartbeat in transit.
            timer.current=setTimeout(()=>{void poll();},owned.heartbeatIntervalMs);
          }else if(current()){stop();setMessage('Assistant controls disconnected. Enable them again to create a new connection.');}
        }
      };
      void poll();
    }catch(error){
      if(attempt===generation.current){setConnecting(false);setMessage(error instanceof AssistantControlError&&error.code==='NEEDS_USER_GESTURE'
        ?error.message:'Could not enable assistant controls. Check that the local studio is running, then try again.');}
      if(registered&&active.current!==registered)void assistantApi.revoke(registered).catch(()=>{});
    }
  };
  return {connection,connecting,message,connect,disconnect:()=>{stop();setMessage('Assistant controls are off.');}};
}
