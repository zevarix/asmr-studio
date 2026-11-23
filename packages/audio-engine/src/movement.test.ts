import {describe,expect,it} from 'vitest';
import {movementParameters,movementPan} from './movement.js';

const sway={enabled:true,width:.3,cycleSeconds:30};
describe('stereo movement trajectory',()=>{
  it('retains the static center for absent, disabled, and zero-width movement',()=>{
    for(const settings of [undefined,{...sway,enabled:false},{...sway,width:0}]){
      expect(movementParameters(.25,settings).radius).toBe(0);
      for(const time of [0,7.5,1000])expect(movementPan(.25,settings,time)).toBe(.25);
    }
  });
  it('starts at center toward the right and follows a complete bounded cycle',()=>{
    const settings={...sway,cycleSeconds:4};
    expect([0,1,2,3,4].map(time=>movementPan(.25,settings,time))).toEqual([
      .25,Math.fround(.25+Math.fround(.3)),.25,Math.fround(.25-Math.fround(.3)),.25,
    ]);
    expect(movementPan(.25,settings,-1)).toBe(.25);
  });
  it('constrains width around the float32 center without changing the requested settings',()=>{
    const settings={...sway,width:1,cycleSeconds:2};
    for(const center of [-1,-.95,0,.95,1]){
      const parameters=movementParameters(center,settings);
      expect(parameters.center).toBe(Math.fround(center));
      expect(parameters.radius).toBe(Math.fround(Math.min(1,1-Math.abs(Math.fround(center)))));
      for(let i=0;i<=80;i++)expect(Math.abs(movementPan(center,settings,i/40))).toBeLessThanOrEqual(1);
    }
    expect(settings.width).toBe(1);
  });
  it('uses the native float32 frequency even at a long elapsed position',()=>{
    const parameters=movementParameters(.123456789,sway);
    expect(parameters).toEqual({center:Math.fround(.123456789),radius:Math.fround(.3),frequency:Math.fround(1/30)});
    const elapsed=20000;
    const expected=Math.fround(parameters.center+parameters.radius*Math.sin(2*Math.PI*((elapsed*parameters.frequency)%1)));
    expect(movementPan(.123456789,sway,elapsed)).toBe(expected);
    expect(Math.abs(expected-Math.fround(parameters.center+parameters.radius*Math.sin(2*Math.PI*elapsed/30)))).toBeGreaterThan(1e-5);
  });
});
