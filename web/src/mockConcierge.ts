// Client for the concierge API, plus the shared request/response types.
// POST /api/chat is served by the Vite middleware locally and by api/chat.js on Vercel.
// The concierge runs server-side only; it must never run in the browser.

// One remembered fact. `saved` persists across outings; `tonight` is cleared by "New outing".
export type Detail = { key: string; label: string; value: string; kind: 'saved' | 'tonight' }
// A restaurant card. Every field comes from a catalog record except `why` and `caveat`, which the model writes.
export type Recommendation = { restaurantId: number; name: string; cuisine: string; price: string; address: string; hours: string; why: string; caveat: string; warning?: string }
// One step the agent took, shown in the activity panel. `input` and `result` are JSON strings.
export type Activity = { id: string; tool: string; status: 'complete' | 'working' | 'error'; summary: string; input?: string; result?: string; change?: { field: string; from: string; to: string }; outcome?: 'ok' | 'empty' | 'fallback' | 'unavailable' }
// `context` is the full updated context and replaces the client's copy.
// `locationState` tells the client how to update its location-prompt counter.
export type ConciergeResponse = { reply: string; recommendation?: Recommendation; alternatives?: Recommendation[]; context: Detail[]; activity: Activity[]; noMatches?: boolean; degraded?: boolean; locationState?: 'asked' | 'resolved' | 'exhausted' }
export type HistoryItem = { role: 'user' | 'assistant'; text: string; recommendation?: Recommendation; alternatives?: Recommendation[] }

export const defaultContext: Detail[] = []

// Sends one user turn. Throws with the server's error message on a non-2xx response.
export async function askConcierge(message: string, context: Detail[], history: HistoryItem[], locationPromptCount: number, lastCity?: string, localTime?: string): Promise<ConciergeResponse> {
  const response = await fetch('/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message, context, history, locationPromptCount, lastCity, localTime })
  })
  const data = await response.json() as ConciergeResponse & { error?: string }
  if (!response.ok) throw new Error(data.error || 'The concierge is unavailable.')
  return data
}
