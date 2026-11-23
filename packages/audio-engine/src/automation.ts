const fallbackHolds=new WeakMap<AudioParam,{time:number;value:number}>();

/** Preserve the consumed part of a linear automation when scheduling its replacement. */
export function holdLinearAutomation(param:AudioParam,value:number,time:number):void {
  if(typeof param.cancelAndHoldAtTime==='function')param.cancelAndHoldAtTime(time);
  else{
    param.cancelScheduledValues(time);
    // A set event alone would erase an in-progress ramp's endpoint and restore
    // its original value just before this boundary. Clip that ramp first.
    // Repeated edits at the same audio time must preserve the first left-hand
    // endpoint even when an intervening set event changed the current value.
    const previous=fallbackHolds.get(param),held=previous?.time===time?previous.value:Math.fround(value);
    param.linearRampToValueAtTime(held,time);fallbackHolds.set(param,{time,value:held});
  }
}
