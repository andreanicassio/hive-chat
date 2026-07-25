import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { VitePWA } from 'vite-plugin-pwa';
import { execSync } from 'node:child_process';

/*
 * L'identità della build.
 *
 * Lo `sha` è il commit da cui esce questo bundle: è la stessa sigla che
 * finisce nei messaggi in chat («committato come cd59864»), quindi guardando
 * l'angolo della barra laterale si sa esattamente cosa si sta eseguendo —
 * senza doverlo dedurre da quali funzioni si vedono e quali no.
 */
const BUILD_SHA = (() => {
  try {
    return execSync('git rev-parse --short HEAD', { encoding: 'utf8' }).trim();
  } catch {
    return 'dev';
  }
})();
const BUILD_TIME = new Date().toISOString().slice(0, 16).replace('T', ' ') + ' UTC';

/**
 * `version.json` accanto al bundle.
 *
 * Il client lo rilegge ogni tanto: se la sigla è cambiata, sul server c'è una
 * versione più nuova di quella che sta girando qui. È il modo più diretto di
 * accorgersene — il controllo del service worker da solo passa ogni mezz'ora,
 * troppo lento in una fase in cui si pubblica dieci volte al giorno.
 */
function versionManifest() {
  return {
    name: 'hive-version-manifest',
    generateBundle(this: { emitFile: (f: Record<string, string>) => void }) {
      this.emitFile({
        type: 'asset',
        fileName: 'version.json',
        source: JSON.stringify({ sha: BUILD_SHA, builtAt: BUILD_TIME }),
      });
    },
  };
}

export default defineConfig({
  define: {
    __BUILD_ID__: JSON.stringify(`${BUILD_SHA} · ${BUILD_TIME}`),
    __BUILD_SHA__: JSON.stringify(BUILD_SHA),
    __BUILD_TIME__: JSON.stringify(BUILD_TIME),
  },
  plugins: [
    versionManifest(),
    react(),
    tailwindcss(),
    VitePWA({
      // `prompt`, non `autoUpdate`: l'aggiornamento lo accetta chi usa l'app,
      // con l'avviso in basso. Vedi `lib/update.ts`.
      registerType: 'prompt',
      // `injectManifest` e non `generateSW`: il service worker ce lo scriviamo
      // noi (src/sw.ts) perché deve gestire l'evento `push`, che è l'unico
      // modo di svegliare l'app quando è chiusa.
      strategies: 'injectManifest',
      srcDir: 'src',
      filename: 'sw.ts',
      injectManifest: {
        globPatterns: ['**/*.{js,css,html,svg,png,webmanifest}'],
      },
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
