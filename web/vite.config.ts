import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwind from '@tailwindcss/vite';

export default defineConfig({
  root: 'web',
  plugins: [react(), tailwind()],
  server: {
    port: 5173,
    proxy: {
      // Порт API налаштовується: 3000 буває зайнятий іншим проєктом власника.
      '/api': { target: `http://localhost:${process.env.API_PORT ?? 3000}`, changeOrigin: true },
    },
  },
});
