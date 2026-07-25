import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['favicon.svg'],
      manifest: {
        name: 'Hive',
        short_name: 'Hive',
        description: 'Chat di squadra con agenti AI che lavorano insieme a te',
        // Il primo stop del gradiente dell'app: installata, la barra della
        // finestra continua la pagina invece di tagliarla con un'altra tinta.
        theme_color: '#d9dee2',
        background_color: '#d9dee2',
        display: 'standalone',
        // Dove il browser lo supporta, la barra di sistema sparisce del tutto
        // e i comandi della finestra galleggiano sul gradiente: è la barra
        // "trasparente" vera. Dove non è supportato si ripiega su standalone.
        display_override: ['window-controls-overlay', 'standalone'],
        orientation: 'portrait',
        start_url: '/',
        icons: [
          { src: 'icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png' },
          {
            src: 'icon-512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'maskable',
          },
        ],
      },
      workbox: {
        // La chat è realtime: non ha senso servire messaggi dalla cache.
        // Mettiamo in cache solo il guscio dell'app.
        navigateFallbackDenylist: [/^\/api/, /^\/ws/],
        runtimeCaching: [
          {
            urlPattern: /^https?:\/\/[^/]+\/api\//,
            handler: 'NetworkOnly',
          },
        ],
      },
    }),
  ],
  server: {
    host: '0.0.0.0',
    port: 5173,
    proxy: {
      '/api': { target: 'http://127.0.0.1:8080', changeOrigin: true },
      '/ws': { target: 'ws://127.0.0.1:8080', ws: true },
    },
  },
  build: {
    target: 'es2022',
    rollupOptions: {
      output: {
        // Il rendering markdown pesa: lo isoliamo in un chunk suo.
        manualChunks(id: string) {
          if (/node_modules\/(react-markdown|remark-|rehype-|micromark|mdast|hast)/.test(id)) {
            return 'markdown';
          }
          return undefined;
        },
      },
    },
  },
});
