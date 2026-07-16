import { resolve } from 'node:path';

import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// The next UI is a fresh presentation layer over the UNCHANGED client machinery: the
// legacy package's nonvisual modules (state, api, ws, crypto, theme, push, room-color,
// run-presenter, notifications) are imported straight from its source tree via this
// alias, so protocol behavior, encryption and synchronization stay byte-identical while
// every component, layout and stylesheet here is new.
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@legacy': resolve(__dirname, '../web/src'),
    },
  },
  server: {
    port: 5273,
    proxy: {
      '/api': {
        target: `http://127.0.0.1:${process.env.CODOR_NEXT_API_PORT ?? '21037'}`,
        changeOrigin: true,
        ws: true,
      },
    },
  },
  build: {
    outDir: 'dist',
  },
});
