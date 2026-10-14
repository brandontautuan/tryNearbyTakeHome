// Vercel serverless function for POST /api/chat; mirrors the local Vite middleware in vite.config.ts.
export default async function handler(req, res) {
  if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return res.status(405).json({ error: 'Method not allowed.' }) }
  try {
    // Imported lazily so a missing environment variable surfaces as a JSON error instead of a crashed function.
    const { chat } = await import('../server/concierge.mjs')
    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : req.body || {}
    res.status(200).json(await chat(body))
  } catch (error) { res.status(502).json({ error: error instanceof Error ? error.message : 'Request failed.' }) }
}
