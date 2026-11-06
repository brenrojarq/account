import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig(({ mode }) => ({
  base: './',
  plugins: [
    react(),
    VitePWA({
      disable: mode === 'portable',
      registerType: 'prompt',
      injectRegister: false,
      includeManifestIcons: false,
      manifest: {
        name: 'KONTEN',
        short_name: 'KONTEN',
        description: 'Tus finanzas personales, con claridad.',
        id: './',
        start_url: './',
        scope: './',
        display: 'standalone',
        lang: 'es-NI',
        theme_color: '#087f46',
        background_color: '#f3faf6',
        icons: [
          { src: 'icons/konten-icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' },
          { src: 'icons/konten-icon.png', sizes: '1254x1254', type: 'image/png', purpose: 'any' },
        ],
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,woff2,png,svg}'],
        navigateFallback: 'index.html',
        cleanupOutdatedCaches: true,
        clientsClaim: true,
        skipWaiting: false,
      },
    }),
  ],
  optimizeDeps: { entries: ['index.html'] },
  server: { host: '0.0.0.0', port: 5173 },
}));
