import { buildApp } from './app.js';
import { openExportJobs, openStudio, positiveInteger } from './runtime.js';

process.umask(0o077);
const port = positiveInteger('PORT',4317);
if (port > 65535) throw new Error('PORT must be below 65536');
const studio = openStudio();
const {store,assets,starterLibrary} = studio;
let exports:ReturnType<typeof openExportJobs>;
try { exports = openExportJobs(studio); }
catch (error) { store.close(); throw error; }
const app = buildApp({scenes:store.scenes,assets,starterLibrary,exports,
  allowedOrigin:process.env['ASMR_ALLOWED_ORIGIN'] ?? `http://127.0.0.1:${port}`});
app.addHook('onClose',async () => { try { await exports.close(); } finally { store.close(); } });
for (const signal of ['SIGINT','SIGTERM'] as const) process.once(signal,() => { void app.close(); });
try { await app.listen({host:'127.0.0.1',port}); console.log(`ASMR Studio API listening on http://127.0.0.1:${port}`); }
catch { await app.close(); console.error('ASMR Studio could not start'); process.exitCode = 1; }
