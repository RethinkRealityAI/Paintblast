import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      // Stub out @iwsdk/core in unit tests to avoid browser-only side effects
      // (canvas.getContext etc.) from @iwsdk/xr-input at module-evaluation time.
      // Only the pure SplatterPool class is exercised by tests; the System wrapper
      // is verified manually in the Phase 1 gate with a live World.
      '@iwsdk/core': resolve(__dirname, 'tests/__mocks__/iwsdk-core.ts'),
    },
  },
  test: {
    environment: 'happy-dom',
    include: ['tests/unit/**/*.test.ts', 'tests/integration/**/*.test.ts'],
    globals: false,
  },
});
