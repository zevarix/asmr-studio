import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { fileURLToPath } from 'node:url';
export default defineConfig({
  plugins:[react(),tailwindcss()],
  resolve:{alias:{
    '@asmr-studio/contracts':fileURLToPath(new URL('./packages/contracts/src/index.ts',import.meta.url)),
    '@asmr-studio/audio-engine':fileURLToPath(new URL('./packages/audio-engine/src/index.ts',import.meta.url)),
  }},
  server:{host:'127.0.0.1',proxy:{'/api':{target:'http://127.0.0.1:4319',changeOrigin:false}}},
});
