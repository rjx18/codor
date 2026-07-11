import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    // harn:assume sw-injectmanifest-owned-worker ref=vite-pwa-owned-worker
    VitePWA({
      strategies: 'injectManifest',
      srcDir: 'src',
      filename: 'sw.ts',
      injectRegister: false,
      includeAssets: ['wireroom-icon.svg', 'wireroom-192.png', 'wireroom-512.png'],
      injectManifest: {
        globPatterns: ['**/*.{html,js,css,svg,png,woff2}'],
        rollupFormat: 'es',
      },
      manifest: {
        name: 'Wireroom',
        short_name: 'Wireroom',
        description: 'Private rooms for humans and coding agents.',
        start_url: '/',
        scope: '/',
        display: 'standalone',
        orientation: 'any',
        background_color: '#070b0d',
        theme_color: '#070b0d',
        categories: ['productivity', 'utilities'],
        icons: [
          { src: '/wireroom-192.png', sizes: '192x192', type: 'image/png' },
          { src: '/wireroom-512.png', sizes: '512x512', type: 'image/png' },
          {
            src: '/wireroom-512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'maskable',
          },
        ],
      },
    }),
    // harn:end sw-injectmanifest-owned-worker
  ],
  test: {
    include: ['src/**/*.spec.{ts,tsx}'], // Playwright owns tests/
  },
});
