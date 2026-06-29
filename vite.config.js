import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5180,
    // Forward /api calls to the local proxy server (server/index.js), which holds
    // the ERPNext credentials and fetches live data. Credentials never reach the browser.
    proxy: {
      '/api': {
        target: `http://localhost:${process.env.PROXY_PORT || 8787}`,
        changeOrigin: true,
      },
    },
  },
})
