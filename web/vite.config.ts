import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  // Build to the repo-root dist/, where Vercel expects the Vite output.
  build: { outDir: '../dist', emptyOutDir: true },
  plugins: [react(), {
    // Dev-only POST /api/chat; api/chat.js serves the same route on Vercel.
    // concierge.mjs is imported lazily so a missing .env surfaces as a JSON error, not a dev-server crash.
    name: 'local-concierge-api',
    configureServer(server) {
      server.middlewares.use('/api/chat', async (req, res, next) => {
        if (req.method !== 'POST') return next()
        try {
          const chunks: Buffer[] = []
          for await (const chunk of req) chunks.push(chunk)
          const { chat } = await import('../server/concierge.mjs')
          const data = await chat(JSON.parse(Buffer.concat(chunks).toString() || '{}'))
          res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(data))
        } catch (error) { res.statusCode = 502; res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ error: error instanceof Error ? error.message : 'Request failed.' })) }
      })
    }
  }]
})
