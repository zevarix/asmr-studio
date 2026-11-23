import {describe,expect,it} from 'vitest';
import * as audio from './index.js';
import {defaultListeningTimer,listeningDuration,listeningFadeError} from '@asmr-studio/contracts';

const timer={enabled:true,durationSeconds:8,fadeInSeconds:2,fadeOutSeconds:2};
describe('fresh listening envelope',()=>{
  it('provides a shared Float32 envelope with exact neutral, endpoint and triangle values',()=>{
    expect(typeof audio.listeningEnvelopeGain).toBe('function');
    const gain=audio.listeningEnvelopeGain;
    for(const [time,value] of [[0,0],[1,.5],[2,1],[6,1],[7,.5],[8,0],[9,0]] as const)
      expect(gain(timer,time,8)).toBe(value);
    expect(gain(timer,1/3,8)).toBe(Math.fround(1/6));
    expect(gain({...timer,fadeOutSeconds:6},2,8)).toBe(1);
    expect(gain({...timer,fadeOutSeconds:6},5,8)).toBe(.5);
    expect(gain({...timer,fadeInSeconds:0,fadeOutSeconds:0},7.999,8)).toBe(1);
    expect(gain(undefined,9,8)).toBe(1);expect(gain({...timer,enabled:false},9,8)).toBe(1);
  });
  it('uses a chosen render endpoint independently of the saved timer',()=>{
    expect(typeof audio.listeningEnvelopeGain).toBe('function');
    expect(audio.listeningEnvelopeGain(timer,5,6)).toBe(.5);
    expect(audio.listeningEnvelopeGain(timer,7,10)).toBe(1);
  });
  it('keeps defaults detached and gives explicit settings priority over legacy duration',()=>{
    const first=defaultListeningTimer();first.durationSeconds=5;
    expect(defaultListeningTimer()).toEqual({enabled:false,durationSeconds:2700,fadeInSeconds:0,fadeOutSeconds:180});
    expect(listeningDuration(undefined,30)).toBe(30);expect(listeningDuration(undefined,null)).toBeNull();
    expect(listeningDuration(timer,30)).toBe(8);expect(listeningDuration({...timer,enabled:false},30)).toBeNull();
    expect(listeningFadeError(timer,3)).toMatch(/fade-in and fade-out/i);expect(listeningFadeError(timer,4)).toBeNull();
    expect(listeningFadeError({...timer,enabled:false},.1)).toBeNull();
  });
});
