// Scratch config for headless verification only (no mkcert, no AI relay).
import { iwsdkDev } from '@iwsdk/vite-plugin-dev';
import { compileUIKit } from '@iwsdk/vite-plugin-uikitml';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [
    iwsdkDev({ emulator: { device: 'metaQuest3', environment: 'living_room' }, verbose: false }),
    compileUIKit({ sourceDir: 'ui', outputDir: 'public/ui', verbose: false }),
  ],
  server: { host: '127.0.0.1', port: 8090, strictPort: true, open: false },
  esbuild: { target: 'esnext' },
  optimizeDeps: { exclude: ['@babylonjs/havok'], esbuildOptions: { target: 'esnext' } },
  publicDir: 'public',
  base: './',
});
