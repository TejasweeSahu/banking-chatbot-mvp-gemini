/**
 * @file frontend/vite.config.js
 * @description Vite configuration for the Northstar banking frontend.
 * Configures the React plugin, dev server listening on port 5173, and API proxy routing
 * `/api` requests to the Express backend on `http://localhost:4000`.
 */

import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: { '/api': 'http://localhost:4000' }
  }
});
