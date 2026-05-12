import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    host: '0.0.0.0',
    // When running through Express (middlewareMode), port/proxy are not used.
    // If you run `vite` standalone, it will use its default port.
  },
  build: {
    outDir: 'dist/client',
  },
})
