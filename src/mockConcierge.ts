// The local Vite middleware exposes POST /api/chat. Move this transport to a
// trusted server/Edge Function for deployment; it must never run in the browser.
export type Detail = { key: string; label: string; value: string; kind: 'saved' | 'tonight' }
export type Recommendation = { restaurantId: number; name: string; cuisine: string; price: string; address: string; hours: string; why: string; caveat: string }
export type Activity = { id: string; tool: string; status: 'complete' | 'working' | 'error'; summary: string; input?: string; result?: string; change?: { field: string; from: string; to: string } }
export type ConciergeResponse = { reply: string; recommendation?: Recommendation; alternatives?: Recommendation[]; context: Detail[]; activity: Activity[]; noMatches?: boolean; locationState?: 'asked' | 'resolved' | 'exhausted' }
export type HistoryItem = { role: 'user' | 'assistant'; text: string; recommendation?: Recommendation; alternatives?: Recommendation[] }

const defaultContext: Detail[] = []
const indian: Recommendation = {
  restaurantId: 0, name: 'Mock restaurant — replace with restaurants.txt data', cuisine: 'Indian', price: 'Price band from source',
  address: 'Address from supplied data', hours: 'Hours from supplied data',
  why: 'This example card is ready to display a match returned by your restaurant source.',
  caveat: 'Please load restaurants.txt to show verified dietary notes and seating caveats.'
}
const quiet: Recommendation = { ...indian, cuisine: 'Quiet dinner', why: 'An example of how a change of plans updates the recommendation in place.' }

function merge(context: Detail[], changes: Partial<Record<string, string>>) {
  const next = [...context]
  Object.entries(changes).forEach(([key, value]) => {
    const found = next.find(d => d.key === key)
    if (found) found.value = value!
    else next.push({ key, label: key === 'diet' ? 'Dietary needs' : key === 'group' ? 'Group size' : key === 'vibe' ? 'Atmosphere' : key, value: value!, kind: key === 'diet' ? 'saved' : 'tonight' })
  })
  return next
}

export async function askConcierge(message: string, context: Detail[], history: HistoryItem[], locationPromptCount: number, lastCity?: string): Promise<ConciergeResponse> {
  const response = await fetch('/api/chat', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message, context, history, locationPromptCount, lastCity })
  })
  const data = await response.json() as ConciergeResponse & { error?: string }
  if (!response.ok) throw new Error(data.error || 'The concierge is unavailable.')
  return data
  /* Mock fixture retained below as a fallback reference for offline UI work.
  await new Promise(r => setTimeout(r, 750))
  const text = message.toLowerCase()
  if (text.includes('fail')) throw new Error('The simulated concierge is taking a moment. Please try again.')
  if (text.includes('no match') || text.includes('none')) return { reply: "I couldn't find a suitable match without changing a constraint. Would you rather expand the neighborhood or raise the budget?", context, noMatches: true, activity: [{ id: crypto.randomUUID(), tool: 'search_restaurants', status: 'complete', summary: 'No suitable matches', input: message, result: '0 matches' }] }
  if (text.includes('cheap') || text.includes('budget')) {
    const next = merge(context, { budget: 'Budget-friendly', city: 'Irvine' })
    return { reply: 'I can help with that. Is this dinner for one, or are you bringing anyone along?', context: next, activity: [{ id: crypto.randomUUID(), tool: 'update_context', status: 'complete', summary: 'Learned budget and city', change: { field: 'Budget', from: context.find(x => x.key === 'budget')?.value || '—', to: 'Budget-friendly' } }] }
  }
  if (text.includes('vegan')) {
    const isCompanion = /friend|girlfriend|boyfriend|partner|companion|with a vegan/.test(text)
    const next = merge(context, { diet: isCompanion ? 'Vegan option for a companion' : 'Vegan', group: isCompanion ? '2 people' : '—' })
    const diet = next.find(detail => detail.key === 'diet')!
    diet.kind = isCompanion ? 'tonight' : 'saved'
    return { reply: 'Got it — I’ll keep vegan-friendly options front and center. I found a possible fit to start from.', recommendation: indian, context: next, activity: [{ id: crypto.randomUUID(), tool: 'update_context', status: 'complete', summary: isCompanion ? 'Captured tonight’s dietary need' : 'Saved explicit dietary preference', change: { field: 'Dietary needs', from: '—', to: diet.value } }, { id: crypto.randomUUID(), tool: 'search_restaurants', status: 'complete', summary: 'Searched restaurant source', input: 'vegan-friendly dinner', result: '1 mock display result' }] }
  }
  if (text.includes('quiet') || text.includes('date') || text.includes('change') || text.includes('instead')) {
    const next = merge(context, { vibe: 'Quiet', group: '2 people' })
    return { reply: 'A quiet date spot it is. I’ve adjusted the search to favor a calmer atmosphere.', recommendation: quiet, context: next, activity: [{ id: crypto.randomUUID(), tool: 'update_context', status: 'complete', summary: 'Updated tonight’s atmosphere', change: { field: 'Atmosphere', from: context.find(x => x.key === 'vibe')?.value || '—', to: 'Quiet' } }, { id: crypto.randomUUID(), tool: 'search_restaurants', status: 'complete', summary: 'Refined recommendation', input: 'quiet dinner for 2', result: '1 mock display result' }] }
  }
  return { reply: 'A little more detail will help me narrow it down. What matters most tonight: neighborhood, budget, dietary needs, or atmosphere?', context, activity: [{ id: crypto.randomUUID(), tool: 'clarify_request', status: 'complete', summary: 'Asked a follow-up question' }] } */
}
export { defaultContext }
