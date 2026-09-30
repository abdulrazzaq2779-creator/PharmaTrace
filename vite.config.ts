import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import { configureScanApi } from './server/scanApi'

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    react(),
    {
      name: 'pharmatrace-scan-api',
      configureServer(server) {
        configureScanApi(server.middlewares)
      },
      configurePreviewServer(server) {
        configureScanApi(server.middlewares)
      },
    },
  ],
})
