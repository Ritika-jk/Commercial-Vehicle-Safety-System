import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import basicSsl from '@vitejs/plugin-basic-ssl';

// Enable HTTPS by default for mobile smartphone camera & sensor permissions over local Wi-Fi.
// To run in plain HTTP mode (e.g. for USB port forwarding), set VITE_HTTP=true.
const useHttps = process.env.VITE_HTTP !== 'true';

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    ...(useHttps ? [basicSsl()] : []),
  ],
  server: {
    port: 5173,
    host: '0.0.0.0', // allow network access for smartphone testing
    proxy: {
      '/api': {
        target: 'http://localhost:8000',
        changeOrigin: true,
      },
      '/ws': {
        target: 'ws://localhost:8000',
        ws: true,
      },
    },
  },
  build: {
    target: 'es2020',
    outDir: 'dist',
  },
});
