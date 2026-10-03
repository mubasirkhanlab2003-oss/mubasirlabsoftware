import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
  build: { target: 'es2022', chunkSizeWarningLimit: 1200 },
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['favicon.svg'],
      manifest: {
        name: 'Laboratory Information System',
        short_name: 'Lab',
        description: 'Laboratory management: patients, tests, results, reports and billing',
        theme_color: '#0d3b37',
        background_color: '#f3f6f5',
        display: 'standalone',
        start_url: '/',
        icons: [{ src: 'favicon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' }],
      },
      workbox: {
        // The whole app shell (including the lazy PDF chunk) is cached so the
        // app opens and works without internet.
        globPatterns: ['**/*.{js,css,html,svg,png,ico,woff2}'],
        maximumFileSizeToCacheInBytes: 6 * 1024 * 1024,
        navigateFallback: '/index.html',
        navigateFallbackDenylist: [/^\/api\//],
        runtimeCaching: [],
      },
    }),
  ],
  test: { environment: 'node', setupFiles: ['./tests/setup.js'], include: ['tests/**/*.test.{js,jsx}'] },
});
