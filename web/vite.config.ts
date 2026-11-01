import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  // Relative assets work both at a server root and at /Nullx11-MIDICon/ on GitHub Pages.
  base: './',
  plugins: [react()],
  server: {
    host: '0.0.0.0',
    port: 3000,
    allowedHosts: ['.e2b.app'],
    proxy: { '/api': { target: 'http://127.0.0.1:8000', changeOrigin: false } },
  },
  build: {
    outDir: 'dist', sourcemap: false,
    rollupOptions: { output: { manualChunks: id => id.includes('onnxruntime') ? 'onnx-runtime' : undefined } },
  },
});
