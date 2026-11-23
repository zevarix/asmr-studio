import {describe,expect,it} from 'vitest';
import {FakeParam} from './fake-context.js';

describe('fake native automation semantics',()=>{
  it('clips an active ramp at cancelAndHoldAtTime without rewriting earlier values',()=>{
    const param=new FakeParam(0);param.setValueAtTime(0,0);param.linearRampToValueAtTime(1,1);
    param.cancelAndHoldAtTime(.5);
    expect(param.valueAt(.25)).toBe(.25);expect(param.valueAt(.5)).toBe(.5);expect(param.valueAt(1)).toBe(.5);
  });
});
