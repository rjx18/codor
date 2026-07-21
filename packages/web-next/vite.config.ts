import { resolve } from 'node:path';

import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

// The supported browser is self-contained: presentation, synchronization, crypto,
// notifications, and its owned service worker all build from this workspace.
export default defineConfig({
  plugins: [
    react(),
    // The browser owns its offline and push worker alongside the app runtime.
    VitePWA({
      strategies: 'injectManifest',
      srcDir: resolve(__dirname, 'src'),
      filename: 'sw.ts',
      injectRegister: false,
      includeAssets: [
        'codor-favicon.svg',
        'codor-mark.svg',
        'codor-192.png',
        'codor-512.png',
        'codor-maskable-512.png',
        'codor-apple-touch-180.png',
        'codor-og.png',
      ],
      injectManifest: {
        globPatterns: ['**/*.{html,js,css,svg,png,woff2}'],
        rollupFormat: 'es',
        maximumFileSizeToCacheInBytes: 4 * 1024 * 1024,
      },
      manifest: {
        name: 'Codor',
        short_name: 'Codor',
        description: 'Private rooms for humans and coding agents.',
        start_url: '/',
        scope: '/',
        display: 'standalone',
        orientation: 'any',
        background_color: '#e9e9e6',
        theme_color: '#e9e9e6',
        categories: ['productivity', 'utilities'],
        icons: [
          { src: '/codor-192.png', sizes: '192x192', type: 'image/png' },
          { src: '/codor-512.png', sizes: '512x512', type: 'image/png' },
          // A padded, full-bleed plate: Android crops ~20% off each edge of a
          // maskable icon, which clipped the rounded plate when this reused the
          // plain 512.
          { src: '/codor-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
    }),
  ],
  resolve: {
    alias: {
      '@runtime': resolve(__dirname, 'src/runtime'),
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
    rollupOptions: {
      output: {
        // The crypto stack dwarfs the app; keep it (and other stable vendors)
        // in their own long-lived chunks.
        manualChunks: {
          sodium: ['libsodium-wrappers'],
          react: ['react', 'react-dom'],
          graph: ['d3-force'],
          qr: ['qrcode'],
        },
      },
    },
  },
});
