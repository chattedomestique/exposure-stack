import { defineConfig } from 'vite'
import { VitePWA } from 'vite-plugin-pwa'

// The entire merge engine (Mertens fusion + MTB alignment) is hand-written
// TypeScript with no native dependency, so the whole app precaches into the
// service worker and runs fully offline — all image processing stays on-device.
export default defineConfig({
  base: './',
  plugins: [
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['favicon.svg'],
      workbox: {
        globPatterns: ['**/*.{js,css,html,svg,png,ico}'],
      },
      manifest: {
        id: './',
        name: 'Exposure Stack',
        short_name: 'ExpStack',
        description:
          'Merge three bracketed exposures into one clean image — privately, in your browser.',
        theme_color: '#0b0f17',
        background_color: '#0b0f17',
        display: 'standalone',
        orientation: 'any',
        start_url: './',
        scope: './',
        icons: [
          { src: 'icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
          { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
          {
            src: 'icons/icon-192-maskable.png',
            sizes: '192x192',
            type: 'image/png',
            purpose: 'maskable',
          },
          {
            src: 'icons/icon-512-maskable.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'maskable',
          },
        ],
      },
    }),
  ],
})
