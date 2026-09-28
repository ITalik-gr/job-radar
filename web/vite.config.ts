import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwind from '@tailwindcss/vite';

export default defineConfig({
  root: 'web',
  plugins: [react(), tailwind()],
  server: {
    port: 5173,
    proxy: {
      // The API port is configurable: 3000 is sometimes taken by another project of the owner's.
      '/api': { target: `http://127.0.0.1:${process.env.API_PORT ?? 3000}`, changeOrigin: true },
    },
  },
});
