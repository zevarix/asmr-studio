import { resolve, join } from 'node:path';
import { homedir } from 'node:os';
import { openStore } from './store.js';
import { AssetStore } from './assets.js';
import { StarterLibrary } from './starter-library.js';
import { ExportJobs } from './exports.js';

export function positiveInteger(name:string,fallback:number):number {
  const value = process.env[name] === undefined ? fallback : Number(process.env[name]);
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`);
  return value;
}

export function studioDataRoot():string {
  return resolve(process.env['ASMR_DATA_DIR'] ?? join(homedir(),'.local','share','asmr-studio'));
}

/** API and command-line imports share the same private store and upload limits. */
export function openStudio(root=studioDataRoot()) {
  const store = openStore(join(root,'studio.sqlite'));
  try {
    const assets = new AssetStore({root:join(root,'media'),repository:store.assets,
      maxUploadBytes:positiveInteger('ASMR_MAX_UPLOAD_BYTES',256*1024*1024),
      decodedBudgetBytes:positiveInteger('ASMR_DECODED_BUDGET_BYTES',512*1024*1024),
      acceptedFormats:(process.env['ASMR_ACCEPTED_FORMATS'] ?? 'wav,flac,mp3,ogg,m4a').split(',')});
    return {store,assets,starterLibrary:new StarterLibrary({root,assets})};
  } catch (error) {store.close();throw error;}
}

/** Only the API process owns export execution; library installation stays a passive store client. */
export function openExportJobs(studio:ReturnType<typeof openStudio>,root=studioDataRoot()):ExportJobs {
  return new ExportJobs({root:join(root,'exports'),scenes:studio.store.scenes,assets:studio.assets,
    decodedBudgetBytes:positiveInteger('ASMR_DECODED_BUDGET_BYTES',512*1024*1024)});
}
