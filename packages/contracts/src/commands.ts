import { z } from 'zod';
import { layerSchema, loopSchema, mixTransitionSchema, parseScene, parseWith, SceneValidationError, type Scene } from './scene.js';
import {equalizerSchema} from './equalizer.js';
import {outputLimiterSchema} from './output.js';
import {stereoMovementSchema} from './movement.js';
import {listeningTimerSchema} from './listening-timer.js';
import {occasionalSchema} from './occasional.js';

const id = z.string().refine(value => value.trim().length > 0, 'Must not be blank');
const gain = z.number().finite().min(0).max(1);
export const sceneCommandSchema = z.discriminatedUnion('type', [
  z.strictObject({type:z.literal('addLayer'),layer:layerSchema}),
  z.strictObject({type:z.literal('removeLayer'),layerId:id}),
  z.strictObject({type:z.literal('setLayerGain'),layerId:id,gain}),
  z.strictObject({type:z.literal('setLayerPan'),layerId:id,pan:z.number().finite().min(-1).max(1)}),
  z.strictObject({type:z.literal('setLayerLoop'),layerId:id,loop:loopSchema.nullable()}),
  z.strictObject({type:z.literal('setLayerEqualizer'),layerId:id,equalizer:equalizerSchema}),
  z.strictObject({type:z.literal('setLayerMovement'),layerId:id,movement:stereoMovementSchema}),
  z.strictObject({type:z.literal('setLayerOccasional'),layerId:id,occasional:occasionalSchema}),
  z.strictObject({type:z.literal('setMuted'),layerId:id,muted:z.boolean()}),
  z.strictObject({type:z.literal('setSolo'),layerId:id,solo:z.boolean()}),
  z.strictObject({type:z.literal('setMasterGain'),gain}),
  z.strictObject({type:z.literal('setMasterEqualizer'),equalizer:equalizerSchema}),
  z.strictObject({type:z.literal('setOutputLimiter'),limiter:outputLimiterSchema}),
  z.strictObject({type:z.literal('setListeningTimer'),timer:listeningTimerSchema}),
  z.strictObject({type:z.literal('setTransition'),transition:mixTransitionSchema}),
]);
export type SceneCommand = z.output<typeof sceneCommandSchema>;

/** Validate both inputs and detach all nested data. Edits never advance persisted revisions. */
export function applyCommand(scene: Scene, command: SceneCommand): Scene {
  const next = parseScene(scene);
  const edit = parseWith(sceneCommandSchema, command);
  if (edit.type === 'setMasterGain') return {...next, masterGain:edit.gain};
  if (edit.type === 'setMasterEqualizer') return parseScene({...next, masterEqualizer:edit.equalizer});
  if (edit.type === 'setOutputLimiter') return {...next, outputLimiter:edit.limiter};
  if (edit.type === 'setListeningTimer') return parseScene({...next,durationSeconds:null,listeningTimer:edit.timer});
  if (edit.type === 'setTransition') {
    if(!next.transition)throw new SceneValidationError('Create a separate transition arrangement before choosing its mixes');
    return parseScene({...next,transition:edit.transition});
  }
  if (edit.type === 'addLayer') return parseScene({...next,layers:[...next.layers,edit.layer]});
  const index = next.layers.findIndex(layer => layer.id === edit.layerId);
  const layer = next.layers[index];
  if (!layer) throw new SceneValidationError(`Unknown layer: ${edit.layerId}`);
  switch (edit.type) {
    case 'removeLayer': next.layers.splice(index,1); break;
    case 'setLayerGain': next.layers[index] = {...layer,gain:edit.gain}; break;
    case 'setLayerPan': next.layers[index] = {...layer,pan:edit.pan}; break;
    case 'setLayerLoop': next.layers[index] = {...layer,loop:edit.loop}; break;
    case 'setLayerEqualizer': next.layers[index] = {...layer,equalizer:edit.equalizer}; break;
    case 'setLayerMovement': next.layers[index] = {...layer,movement:edit.movement}; break;
    case 'setLayerOccasional': return parseScene({...next,layers:next.layers.map((item,at)=>at===index?{...layer,occasional:edit.occasional}:item)});
    case 'setMuted': next.layers[index] = {...layer,muted:edit.muted}; break;
    case 'setSolo': next.layers[index] = {...layer,solo:edit.solo}; break;
  }
  return next;
}
