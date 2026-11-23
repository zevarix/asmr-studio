// Generic metadata only; no personal script, recording, or voice reference.
export function fixtureLayer(overrides: Record<string, unknown> = {}) {
  return {id:'ambience',assetId:'asset-rain',role:'ambience' as const,gain:0.5,pan:0,muted:false,solo:false,startSeconds:0,loop:null,...overrides};
}
export function fixtureScene() {
  return {schemaVersion:1 as const,id:'scene-test',title:'Quiet room',revision:1,masterGain:0.25,durationSeconds:null,
    layers:[fixtureLayer(),{...fixtureLayer(),id:'narration',assetId:'asset-voice',role:'narration' as const}]};
}
export function fixtureAsset() {
  return {id:'asset-rain',sha256:'a'.repeat(64),displayName:'Rain fixture',roles:['ambience' as const],durationSeconds:2,sampleRate:48000,channels:2,format:'wav',
    provenance:{kind:'original' as const,source:null},rights:{privateUse:'permitted' as const,redistribution:'unknown' as const}};
}
