import type {MixTransition,Scene} from './scene.js';
import {layerAssetIds,playbackAssetIds} from './occasional.js';

/** Both captured sides follow one playhead; timed automation holds B at completion. */
export function transitionBlendAt(transition:Pick<MixTransition,'mode'|'blend'|'startSeconds'|'durationSeconds'>,elapsedSeconds:number):number {
  if(transition.mode==='manual')return transition.blend;
  const fraction=Math.max(0,Math.min(1,(elapsedSeconds-transition.startSeconds)/transition.durationSeconds));
  return transition.blend+(1-transition.blend)*fraction;
}

/** Linear weights avoid adding a midpoint boost to aligned, correlated sources. */
export function transitionGainsAt(transition:MixTransition,elapsedSeconds:number):readonly [number,number] {
  if(!transition.a)return [0,transition.b?1:0];
  if(!transition.b)return [1,0];
  const blend=transitionBlendAt(transition,elapsedSeconds);
  return [1-blend,blend];
}

export function sceneLayerCount(scene:Scene):number {
  return scene.transition?(scene.transition.a?.scene.layers.length??0)+(scene.transition.b?.scene.layers.length??0):scene.layers.length;
}

/** All saved references, including inactive occasional alternatives, retain credits. */
export function sceneAssetIds(scene:Scene):string[] {
  const layers=scene.transition?[...(scene.transition.a?.scene.layers??[]),...(scene.transition.b?.scene.layers??[])]:scene.layers;
  return [...new Set(layers.flatMap(layerAssetIds))];
}

/** Physical decoding may be shared; side processing and audible layers remain distinct. */
export function scenePlaybackAssetIds(scene:Scene):string[] {
  const layers=scene.transition?[...(scene.transition.a?.scene.layers??[]),...(scene.transition.b?.scene.layers??[])]:scene.layers;
  return [...new Set(layers.flatMap(playbackAssetIds))];
}
