import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir:'./tests/e2e', fullyParallel:false, workers:1, timeout:20000,
  use:{baseURL:'http://127.0.0.1:4318',headless:true},
  webServer:{command:'npm run build --workspace=@asmr-studio/server && node scripts/test-stack.mjs',url:'http://127.0.0.1:4318/api/health',reuseExistingServer:false,timeout:30000},
});
