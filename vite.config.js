import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5180,
    // When wiring up live ERPNext data later, proxy /erpnext to the UAT site
    // to avoid CORS. Credentials should live on the server side, never in the bundle.
    // proxy: {
    //   '/erpnext': {
    //     target: 'https://your-uat-site.erpnext.com',
    //     changeOrigin: true,
    //     rewrite: (p) => p.replace(/^\/erpnext/, ''),
    //   },
    // },
  },
})
