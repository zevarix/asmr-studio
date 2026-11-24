import { buildApp } from './app.js';
import { openExportJobs, openStudio, positiveInteger } from './runtime.js';
import {PlaybackDevices} from './playback-devices.js';
import { fileURLToPath } from 'node:url';
import { loadBuiltWeb, registerBuiltWeb } from './static-web.js';

process.umask(0o077);
const args=process.argv.slice(2);
if (args.length>1 || (args[0]!==undefined && args[0]!=='--serve-ui')) {
  throw new Error('Usage: node apps/server/dist/main.js [--serve-ui]');
}
const web=args[0]==='--serve-ui' ? loadBuiltWeb(fileURLToPath(new URL('../../web/dist/',import.meta.url))) : null;
const port = positiveInteger('PORT',web?4318:4317);
if (port > 65535) throw new Error('PORT must be below 65536');
const studio = openStudio();
const {store,assets,starterLibrary} = studio;
let exports:ReturnType<typeof openExportJobs>;
try { exports = openExportJobs(studio); }
catch (error) { store.close(); throw error; }
const assistant=new PlaybackDevices();
let app:ReturnType<typeof buildApp>;
try {
  app=buildApp({scenes:store.scenes,assets,starterLibrary,exports,assistant,
    allowedOrigin:process.env['ASMR_ALLOWED_ORIGIN'] ?? `http://127.0.0.1:${port}`});
  if (web) registerBuiltWeb(app,web);
} catch (error) {
  assistant.close();
  try { await exports.close(); } finally { store.close(); }
  throw error;
}
app.addHook('onClose',async () => { assistant.close();try { await exports.close(); } finally { store.close(); } });
for (const signal of ['SIGINT','SIGTERM'] as const) process.once(signal,() => { void app.close(); });
try { await app.listen({host:'127.0.0.1',port}); console.log(`ASMR Studio${web?'':' API'} listening on http://127.0.0.1:${port}`); }
catch { await app.close(); console.error('ASMR Studio could not start'); process.exitCode = 1; }
