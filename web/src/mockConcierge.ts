// Client for the concierge API, plus the shared request/response types.
// POST /api/chat is served by the Vite middleware locally and by api/chat.js on Vercel.
// The concierge runs server-side only; it must never run in the browser.

// One remembered fact. `saved` persists across outings; `tonight` is cleared by "New outing".
export type Detail = { key: string; label: string; value: string; kind: 'saved' | 'tonight' }
// A restaurant card. Every field comes from a catalog record except `why` and `caveat`, which the model writes.
export type Recommendation = { restaurantId: number; name: string; cuisine: string; price: string; address: string; hours: string; why: string; caveat: string; reasons?: string[]; dietNote?: string }
export type Change = { field: string; from: string; to: string }
// One step, shown in the activity panel. `input` and `result` are JSON strings: the raw tool arguments and the exact
// result the model received. tool is a server tool, 'backcheck' (a corrective retry or withheld pick), or
// 'manual_edit' (the user changed context in the panel). `changes` lists an update_context call's changes (empty for
// a no-op); `change` is a single change (manual edits and logs saved before `changes` existed).
export type Activity = { id: string; tool: string; status: 'complete' | 'working' | 'error'; summary: string; input?: string; result?: string; change?: Change; changes?: Change[]; outcome?: 'ok' | 'empty' | 'fallback' | 'unavailable' | 'rejected' }
// `context` is the full updated context and replaces the client's copy.
// `locationState` tells the client how to update its location-prompt counter.
// One line of the server's per-turn trace; t is ms since the turn began.
export type LogEntry = { t: number; level: 'debug' | 'info' | 'warn' | 'error'; message: string; data?: unknown }
export type ConciergeResponse = { logs?: LogEntry[]; reply: string; recommendation?: Recommendation; alternatives?: Recommendation[]; context: Detail[]; activity: Activity[]; noMatches?: boolean; degraded?: boolean; locationState?: 'asked' | 'resolved' | 'exhausted' }
export type HistoryItem = { role: 'user' | 'assistant'; text: string; recommendation?: Recommendation; alternatives?: Recommendation[] }

export const defaultContext: Detail[] = []

// Sends one user turn. Throws with the server's error message on a non-2xx response.
export async function askConcierge(message: string, context: Detail[], history: HistoryItem[], locationPromptCount: number, lastCity?: string, localTime?: string): Promise<ConciergeResponse> {
  const response = await fetch('/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message, context, history, locationPromptCount, lastCity, localTime })
  })
  // A platform error page (e.g. a Vercel timeout) is not JSON; keep the status so the Logs view can show it.
  const data = await response.json().catch(() => ({ error: `Server returned ${response.status} ${response.statusText} with a non-JSON body.` })) as ConciergeResponse & { error?: string }
  if (!response.ok || data.error) throw Object.assign(new Error(data.error || 'The concierge is unavailable.'), { status: response.status })
  return data
}
