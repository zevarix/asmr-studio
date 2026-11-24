import { defineConfig } from '@playwright/test';
import development from './playwright.config.js';

const port=Number(process.env['ASMR_TEST_PORT']??4318);
if(!Number.isInteger(port)||port<1||port>65535) throw new Error('ASMR_TEST_PORT must be a valid TCP port');
const origin=`http://127.0.0.1:${port}`;

// Reuse user-facing journeys against the packaged interface. Audio-analysis
// specs load source modules through Vite and stay in the development suite.
export default defineConfig({
  ...development,
  use:{...development.use,baseURL:origin},
  testMatch:['**/listening-session.spec.ts','**/listening-ui.spec.ts','**/scene-conflict.spec.ts','**/export-ui.spec.ts'],
  webServer:{command:'npm run build && node scripts/test-stack.mjs --built',
    url:`${origin}/api/health`,reuseExistingServer:false,timeout:60000,
    env:{ASMR_TEST_PORT:String(port)}},
});
