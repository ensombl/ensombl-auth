import { sveltekit } from '@sveltejs/kit/vite'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [sveltekit()],
  server: {
    host: process.env.HOST ?? '0.0.0.0',
    port: Number(process.env.PORT ?? 3400),
    allowedHosts: ['host.docker.internal'],
  },
})
