import OpenAI from 'openai'
import { createClient } from '@supabase/supabase-js'
import { readFileSync } from 'node:fs'

function environment() {
  const file = readFileSync(new URL('../.env', import.meta.url), 'utf8')
  return { ...Object.fromEntries(file.split(/\r?\n/).filter(x => /^[A-Z][A-Z0-9_]*=/.test(x)).map(x => [x.slice(0, x.indexOf('=')), x.slice(x.indexOf('=') + 1)])), ...process.env }
}
const env = environment()
const url = env.SUPABASE_URL || env.NEXT_PUBLIC_SUPABASE_URL
// Local compatibility fallback. Do not use a NEXT_PUBLIC variable for a secret in deployment.
const key = env.SUPABASE_SERVICE_ROLE_KEY || env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY
if (!url || !key || !env.OPENROUTER_API_KEY) throw new Error('Supabase URL/key or OPENROUTER_API_KEY is missing.')
const db = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } })
const ai = new OpenAI({ apiKey: env.OPENROUTER_API_KEY, baseURL: 'https://openrouter.ai/api/v1' })
const select = 'id,name,address,city,cuisine,price_level,hours_text,context_text'
// Read-through cache of only catalog records previously returned by Supabase.
// It never fabricates a restaurant and never writes to the database.
const recentCatalog = new Map()
// Results are unranked, so a small limit silently drops good matches; the UI still caps alternatives separately.
const SEARCH_LIMIT = 5
const label = { city: 'City', budget: 'Budget', time: 'Time', companions: 'Companions', group: 'Group size', occasion: 'Occasion', vibe: 'Atmosphere', diet: 'Dietary needs', cuisine: 'Cuisine' }

const tools = [
  { type: 'function', function: { name: 'update_context', description: 'Change only specified context. Preserve unrelated saved preferences and tonight plans. Put explicit enduring statements about the user in saved (for example “I am vegan” or “I usually prefer quiet places”). Put this outing’s city, budget, time, companions, group size, and occasion in tonight.', parameters: { type: 'object', additionalProperties: false, properties: { scope: { type: 'string', enum: ['saved', 'tonight'], description: 'saved for durable user preferences; tonight for this outing only.' }, set: { type: 'object', description: 'Fields to add or replace. Only these fields exist; never store restaurant IDs, search keywords, or anything else.', additionalProperties: false, properties: Object.fromEntries(Object.keys(label).map(key => [key, { type: 'string', description: label[key] }])) }, remove: { type: 'array', description: 'Field keys to remove only from the named scope.', items: { type: 'string', enum: Object.keys(label) } }, new_outing: { type: 'boolean', description: 'true when the user signals a new outing: they are back later, it is a different meal or time, or they are with different people. Clears the previous tonight plans before applying set.' } }, required: ['scope'] } } },
  { type: 'function', function: { name: 'search_restaurants', description: 'Search the supplied catalog by supported filters. Search before recommending. Use min_price_level and max_price_level together to request one exact price band. Use exclude_restaurant_ids for requests such as “more like that” so you do not repeat an earlier recommendation.', parameters: { type: 'object', additionalProperties: false, properties: { city: { type: 'string', description: 'A canonical city name inferred from the user’s wording.' }, min_price_level: { type: 'integer', minimum: 1, maximum: 4 }, max_price_level: { type: 'integer', minimum: 1, maximum: 4 }, cuisine: { type: 'string', description: 'A cuisine style such as Mexican or ramen. Dietary needs like vegan or gluten-free go in keyword, not here.' }, keyword: { type: 'string', description: 'One short word or phrase that must appear in the restaurant’s listed context, for dietary needs or atmosphere (for example “vegan”, “gluten”, “quiet”, “patio”). Omit when not needed.' }, exclude_restaurant_ids: { type: 'array', description: 'Only when the user asks for different or more options than ones already shown: those earlier IDs. Never when the user is refining requirements (for example adding a dietary need).', items: { type: 'integer' } } } } } },
  { type: 'function', function: { name: 'get_restaurant_details', description: 'Retrieve complete supplied details for a restaurant returned from search.', parameters: { type: 'object', additionalProperties: false, properties: { restaurant_id: { type: 'integer' } }, required: ['restaurant_id'] } } }
]

// Context is a fixed set of fields; common synonyms map onto them and anything else (e.g. restaurant_id) is dropped.
const contextAliases = { dietary: 'diet', dietary_needs: 'diet', dietary_restrictions: 'diet', diet_preference: 'diet', dietary_preference: 'diet', cuisine_preference: 'cuisine', group_size: 'group', party_size: 'group', atmosphere: 'vibe', ambiance: 'vibe', location: 'city', companion: 'companions' }
function contextKey(key) { const k = String(key || '').toLowerCase().trim().replace(/[\s-]+/g, '_'); return label[k] ? k : contextAliases[k] || null }
// Where someone eats changes outing to outing, so location is never a saved preference.
function isLocationKey(key) { return /city|location|neighbo|area|address|zip|town/i.test(key) }
// True when `text` contains `target` allowing a couple of typos ("irivine" ≈ "Irvine").
function looselyMentions(text, target) {
  const hay = text.toLowerCase().replace(/[^a-z]/g, ''), needle = target.toLowerCase().replace(/[^a-z]/g, '')
  if (!needle) return false
  if (hay.includes(needle)) return true
  const budget = Math.max(1, Math.floor(needle.length / 4))
  for (let len = needle.length - budget; len <= needle.length + budget; len++) {
    for (let start = 0; start + len <= hay.length; start++) {
      const window = hay.slice(start, start + len), row = Array.from({ length: needle.length + 1 }, (_, i) => i)
      for (let i = 1; i <= window.length; i++) { let prev = row[0]; row[0] = i; for (let j = 1; j <= needle.length; j++) { const temp = row[j]; row[j] = Math.min(row[j] + 1, row[j - 1] + 1, prev + (window[i - 1] === needle[j - 1] ? 0 : 1)); prev = temp } }
      if (row[needle.length] <= budget) return true
    }
  }
  return false
}
// "I live in Santa Ana" describes the user, not where they are eating tonight.
function onlyBackgroundMention(text, target) {
  const lower = text.toLowerCase(), needle = target.toLowerCase().trim()
  let index = lower.indexOf(needle), mentions = 0, background = 0
  while (needle && index !== -1) { mentions++; if (/\b(live|living|lives|based|work|works|working|home|from|grew up|stay|staying)\b[\s\w]{0,12}$/.test(lower.slice(Math.max(0, index - 30), index))) background++; index = lower.indexOf(needle, index + needle.length) }
  return mentions > 0 && mentions === background
}
function applyContext(context, args) {
  const cleared = args.new_outing === true ? context.filter(item => item.kind === 'tonight') : []
  if (cleared.length) context = context.filter(item => item.kind !== 'tonight')
  const scope = args.scope === 'saved' ? 'saved' : 'tonight', set = Object.fromEntries(Object.entries(args.set || {}).map(([field, value]) => [contextKey(field), value]).filter(([field]) => field)), remove = Array.isArray(args.remove) ? args.remove.map(contextKey).filter(Boolean) : []
  const next = context.filter(item => !(item.kind === scope && remove.includes(item.key))).map(item => ({ ...item }))
  const changes = cleared.map(item => ({ field: item.label, from: item.value, to: 'removed' }))
  for (const [field, input] of Object.entries(set)) {
    const value = String(input).trim(); if (!value) continue
    const fieldScope = isLocationKey(field) ? 'tonight' : scope
    const existing = next.find(item => item.kind === fieldScope && item.key === field)
    if (existing && existing.value === value) continue
    if (existing) { changes.push({ field: existing.label, from: existing.value, to: value }); existing.value = value }
    else { const item = { key: field, label: label[field] || field, value, kind: fieldScope }; next.push(item); changes.push({ field: item.label, from: '—', to: value }) }
  }
  for (const field of remove) { const old = context.find(item => item.kind === scope && item.key === field); if (old) changes.push({ field: old.label, from: old.value, to: 'removed' }) }
  return { next, changes }
}
function card(record, why, caveat) { return { restaurantId: record.id, name: record.name, cuisine: record.cuisine, price: `Price level ${record.price_level}`, address: record.address, hours: record.hours_text, why: why || 'Selected from the supplied restaurant catalog.', caveat: caveat || 'Review the listed restaurant context for limitations.' } }
function event(tool, status, summary, input, result, change) { return { id: crypto.randomUUID(), tool, status, summary, input: input ? JSON.stringify(input) : undefined, result: result ? JSON.stringify(result) : undefined, change } }
function errorText(error) { return error instanceof Error ? error.message : (typeof error?.message === 'string' ? error.message : 'Tool failed') }
function cacheRecords(records) { for (const record of records || []) recentCatalog.set(record.id, record) }
async function catalogCities() {
  const { data } = await db.from('restaurants').select('city').limit(100)
  return [...new Set((data || []).map(item => item.city).filter(Boolean))].sort()
}
function escapeLike(text) { return text.replace(/[\\%_]/g, '\\$&') }
function applyFilters(query, { min_price_level, max_price_level, cuisine, keyword, excluded = [] }) {
  if (Number.isInteger(min_price_level)) query = query.gte('price_level', min_price_level)
  if (Number.isInteger(max_price_level)) query = query.lte('price_level', max_price_level)
  if (cuisine) query = query.ilike('cuisine', `%${cuisine}%`)
  if (typeof keyword === 'string' && keyword.trim()) query = query.ilike('context_text', `%${escapeLike(keyword.trim())}%`)
  if (excluded.length) query = query.not('id', 'in', `(${excluded.join(',')})`)
  return query
}
// Explains an empty search by re-running it with each filter dropped, so the
// agent can name the blocking requirement and offer real catalog alternatives.
async function emptyResultDiagnostic(city, filters) {
  const rows = async (f, inCity = true) => { let query = applyFilters(db.from('restaurants').select('city').limit(100), f); if (inCity) query = query.ilike('city', city); const { data, error } = await query; return error ? null : data }
  const cityRows = await rows({ excluded: filters.excluded })
  if (cityRows?.length === 0) return { city, city_result_count: 0, available_cities: await catalogCities(), blocking_constraint: 'city' }
  const used = ['cuisine', 'keyword', 'price'].filter(k => k === 'price' ? Number.isInteger(filters.min_price_level) || Number.isInteger(filters.max_price_level) : typeof filters[k] === 'string' && filters[k].trim())
  const matchesIfDropped = {}
  for (const k of used) matchesIfDropped[k] = (await rows(k === 'price' ? { ...filters, min_price_level: undefined, max_price_level: undefined } : { ...filters, [k]: undefined }))?.length ?? null
  const otherCities = [...new Set(((await rows(filters, false)) || []).map(item => item.city))].filter(item => item.toLowerCase() !== city.toLowerCase()).sort()
  const blocking = used.find(k => matchesIfDropped[k] > 0) || (otherCities.length ? 'city' : 'refine_preferences')
  const summary = [`0 restaurants in ${city} match every requested filter.`, ...used.map(k => `Dropping only the ${k} filter would leave ${matchesIfDropped[k] ?? 'an unknown number of'} restaurants in ${city}.`), otherCities.length ? `The same filters do match in other catalog cities: ${otherCities.join(', ')}.` : 'No other catalog city matches the same filters.'].join(' ')
  return { city, city_result_count: cityRows?.length ?? null, summary, matches_if_dropped: matchesIfDropped, same_filters_in_other_cities: otherCities, blocking_constraint: blocking }
}
function cachedSearch({ city, min_price_level, max_price_level, cuisine, keyword, exclude_restaurant_ids = [] }) {
  const normalizedCity = typeof city === 'string' ? city.trim() : city
  const excluded = new Set(Array.isArray(exclude_restaurant_ids) ? exclude_restaurant_ids.filter(Number.isInteger) : [])
  return [...recentCatalog.values()].filter(record =>
    !excluded.has(record.id) &&
    (!normalizedCity || record.city.toLowerCase() === normalizedCity.toLowerCase()) &&
    (!Number.isInteger(min_price_level) || record.price_level >= min_price_level) &&
    (!Number.isInteger(max_price_level) || record.price_level <= max_price_level) &&
    (!cuisine || record.cuisine.toLowerCase().includes(cuisine.toLowerCase())) &&
    (typeof keyword !== 'string' || !keyword.trim() || (record.context_text || '').toLowerCase().includes(keyword.trim().toLowerCase()))
  ).slice(0, 3)
}

export async function chat({ message, context = [], history = [], locationPromptCount = 0, lastCity = '', localTime = '' }) {
  if (typeof message !== 'string' || !message.trim() || message.length > 12000) throw new Error('A message up to 12,000 characters is required.')
  // Collapse duplicate entries (same scope and key), keeping the latest value, so stale or repeated context never accumulates.
  let current = Array.isArray(context) ? [...new Map(context.map(item => ({ ...item, key: contextKey(item?.key) })).filter(item => item.key && String(item.value ?? '').trim() && !(item.kind === 'saved' && isLocationKey(item.key))).map(item => [`${item.kind}:${item.key}`, { ...item, label: label[item.key] }])).values()] : []
  const previousCity = typeof lastCity === 'string' ? lastCity.trim().slice(0, 80) : ''
  const events = [], records = new Map()
  const recentHistory = Array.isArray(history) ? history.slice(-12).filter(item => item && (item.role === 'user' || item.role === 'assistant')).map(item => ({ role: item.role, text: String(item.text || '').slice(0, 2000), recommendation: item.recommendation && { restaurantId: item.recommendation.restaurantId, name: item.recommendation.name, cuisine: item.recommendation.cuisine, price: item.recommendation.price }, alternatives: Array.isArray(item.alternatives) ? item.alternatives.filter(alt => Number.isInteger(alt?.restaurantId)).slice(0, 3).map(alt => ({ restaurantId: alt.restaurantId, name: alt.name })) : [] })) : []
  const unresolvedNames = [...new Set(recentHistory.filter(item => item.recommendation?.name && !Number.isInteger(item.recommendation.restaurantId)).map(item => item.recommendation.name))]
  if (unresolvedNames.length) {
    const { data } = await db.from('restaurants').select('id,name').in('name', unresolvedNames)
    const idsByName = new Map((data || []).map(item => [item.name, item.id]))
    recentHistory.forEach(item => { if (item.recommendation && !Number.isInteger(item.recommendation.restaurantId)) item.recommendation.restaurantId = idsByName.get(item.recommendation.name) })
  }
  const priorRecommendationIds = new Set(recentHistory.flatMap(item => [item.recommendation?.restaurantId, ...(item.alternatives || []).map(alt => alt.restaurantId)]).filter(Number.isInteger))
  const isOpeningTurn = !recentHistory.some(item => item.role === 'user')
  const knownCityAtStart = current.find(item => item.key === 'city' && item.value?.trim())?.value
  const priorLocationPrompts = Math.max(0, Math.min(Number(locationPromptCount) || 0, 3))
  const coverageCities = !knownCityAtStart && priorLocationPrompts >= 3 ? await catalogCities() : []
  const messages = [{ role: 'system', content: `You are a concise, warm restaurant concierge. Your FIRST action on every turn must be update_context: extract explicit preferences or plans from the user's message, preserve unrelated context, and use an empty update when there is nothing to change. Saved preferences are durable statements about the user (for example, “I’m vegan”). Tonight plans include city, budget, time, companions, group size, and occasion. LOCATION GATE: after update_context, do not call search_restaurants unless its resulting context contains a city. With a city, search that exact city only. This catalog has no coordinates, so never claim a radius, proximity ranking, or that another city is nearby. If no city remains after update_context and location prompts used is under 3, ask one concise location question and do not recommend a restaurant. If no city remains and prompts used is 3, stop asking; say you cannot confidently recommend somewhere local and offer only these catalog coverage cities: ${JSON.stringify(coverageCities)}. Use the supplied recent history to resolve references such as “that place,” “the last one,” or “more like it.” When offering alternatives, exclude only the referenced ID from this known list: ${JSON.stringify([...priorRecommendationIds])}. Preserve hard requirements, especially dietary needs, using keyword when supported. Treat the prior cuisine label, exact price band, and descriptive wording as soft similarities: never pass a long multi-tag cuisine string as a cuisine filter. If the first alternative search is empty, try one broader search that keeps city, hard dietary needs, and the exclusion but drops soft cuisine/price preferences before asking a question. Use both min_price_level and max_price_level when their wording calls for one exact price band. Then use only supplied catalog facts. Ask one useful question only when it changes a recommendation; once the user has answered a question, deferred the choice to you, or confirmed, recommend from the candidates instead of asking again. If every search this turn returned no candidates, never say you found restaurants and never name a restaurant: state plainly which requirement has no catalog match, using diagnostic.summary as the source of truth, and offer the concrete options it lists in one question. If the user then defers ("whatever", "you pick", "sounds good", or any equivalent) or has already been asked about this conflict, do not ask again: relax the blocking soft preference (cuisine, price, or atmosphere wording) yourself, search again in the same city, and recommend; tell them what you relaxed. City and dietary needs stay hard unless the user explicitly changes them. Any restaurant your reply names must be a tool-returned ID given as recommendation_id or in alternatives. When the user asks to see again a restaurant recommended earlier in the conversation, set recommendation_id to that restaurantId. When they simply choose one of the restaurants you just showed, confirm briefly and set recommendation_id to null; the card is already on screen. Never offer reservations or other actions you cannot perform. Never invent ratings, exact prices, availability, or dietary safety. Never relax a hard requirement without asking. If an empty search result has diagnostic.city_result_count 0, say you cannot confidently recommend a restaurant in that city, offer diagnostic.available_cities, and only search another city if the user explicitly names or accepts it. Never mention databases, tools, errors, outages, or system access to the user. If search returns fallback candidates, recommend one of those normally. If no candidate data is available, say warmly that you are having trouble narrowing the list right now and ask one helpful preference question; never fabricate a restaurant. After tool use, return ONLY JSON: {"reply":"...","recommendation_id":number|null,"why":"...","caveat":"...","alternatives":[{"id":number,"why":"...","caveat":"..."}]}. recommendation_id must be an ID returned by a tool. why and caveat describe only that primary restaurant. When your reply suggests more than one restaurant, list at most two additional restaurants (each an ID returned by a tool) in alternatives with its own why and caveat; otherwise use an empty array.` }, { role: 'user', content: `Current context: ${JSON.stringify(current)}\nRecent conversation: ${JSON.stringify(recentHistory)}\nUser message: ${message.trim()}` }]
  messages.splice(1, 0, { role: 'system', content: `Personalization rule: saved preferences are context, not an automatic decision. Treat hard requirements such as dietary restrictions as constraints; treat prior cuisines, cities, and restaurants as soft signals that may inform a question or tie-break only after the user states what they want for this outing. Never recommend a restaurant solely because it matches a remembered preference, and do not repeatedly steer the user toward a remembered cuisine or place. This is ${isOpeningTurn ? 'the opening user turn of a new conversation' : 'an ongoing conversation'}. On an opening turn without a concrete dining request, ask one broad, open-ended question about what they feel like eating; do not search or recommend. A concrete request includes a cuisine, dish, meal type, occasion, location, budget, dietary need, or direct request for a recommendation, including asking you to choose for them. Use the user’s new message and current-outing context as the primary signal; only mention a saved preference when it directly helps resolve an ambiguity.` })
  messages.splice(2, 0, { role: 'system', content: `Delegation: when the user hands the choice to you ("surprise me", "pick for me", "you decide", "anything", or any equivalent), cuisine, price, and atmosphere are open; never ask about them. The city is the only thing you may still ask for. Once a city is confirmed in this conversation, search it using only hard requirements already in context (dietary needs such as vegan or gluten-free, passed as keyword) and recommend one restaurant plus alternatives. Location: always store city in tonight, never in saved. People eat in different cities from day to day, so a city counts only once the user says they are eating there for this outing, or confirms it. Where they live, work, or are based is background, not tonight's location: ask "Eating in <that city> tonight?" before storing or searching it. ${previousCity ? `Their last-used city was ${previousCity}. Whenever you ask for a location, your question MUST name it as a quick confirmation, for example "Still eating in ${previousCity}, or somewhere else?"; never store or search it until they confirm.` : ''}` })
  messages.splice(3, 0, { role: 'system', content: 'Non-negotiable location wording: this catalog only has city names, not coordinates. Never describe a different city as nearby, closest, local to, within a radius, or a short drive. When coverage is missing, say only that the catalog includes records in named other cities.' })
  const userTime = typeof localTime === 'string' ? localTime.trim().slice(0, 60) : ''
  messages.splice(messages.length - 1, 0, { role: 'system', content: `Outings: when the user signals a new outing (they are back, it is a different meal or time, or they are with different people), the previous tonight plans no longer apply. In that turn's update_context, remove the old tonight fields (city, companions, group, occasion, time, budget, and any diet that belonged to a companion), then confirm the city again before searching; do not assume the old city. A companion's dietary need ("my girlfriend is vegan") is a tonight diet, never saved. Record who they are with in companions. If the user names a city and leaves the rest open ("anything around here", "whatever's good"), that is delegation: search and recommend in that turn without asking about cuisine or vibe. Hours: ${userTime ? `the user's local time is ${userTime} (for reasoning only; store time in context only when the user states one). ` : ''}When the user mentions a meal, a time, or "now", read each candidate's hours_text and prefer places open then; never recommend a place listed as closed at that time without saying so in the caveat. Also prefer places whose listed context fits the stated group and occasion.` })
  let corrected = false
  for (let round = 0; round < 6; round++) {
    const response = await ai.chat.completions.create({ model: env.OPENROUTER_MODEL || 'openai/gpt-4.1-mini', messages, tools, tool_choice: round === 0 ? { type: 'function', function: { name: 'update_context' } } : 'auto', temperature: 0.2 })
    const assistant = response.choices[0]?.message
    if (!assistant) throw new Error('The model returned no response.')
    messages.push(assistant)
    if (!assistant.tool_calls?.length) {
      let final; try { final = JSON.parse(assistant.content || '{}') } catch { final = { reply: assistant.content || 'I could not complete that request.' } }
      // A follow-up may re-reference an earlier recommendation without searching again; reload it from the catalog so its card can be shown.
      const recallIds = [final.recommendation_id, ...(Array.isArray(final.alternatives) ? final.alternatives.map(item => item?.id) : [])].filter(id => Number.isInteger(id) && !records.has(id) && priorRecommendationIds.has(id))
      if (recallIds.length) {
        const { data } = await db.from('restaurants').select(select).in('id', recallIds)
        const recalled = recallIds.map(id => (data || []).find(item => item.id === id) || recentCatalog.get(id)).filter(Boolean)
        recalled.forEach(item => records.set(item.id, item))
        if (recalled.length) events.push(event('get_restaurant_details', 'complete', `Recalled ${recalled.map(item => item.name).join(', ')}`, { restaurant_ids: recallIds }, recalled.map(item => ({ id: item.id, name: item.name }))))
      }
      const record =Number.isInteger(final.recommendation_id) ? records.get(final.recommendation_id) : null
      // Backcheck: an ID that no tool returned, or another question after the user already answered one while candidates exist, gets one corrective retry.
      const lastAssistant = [...recentHistory].reverse().find(item => item.role === 'assistant')
      const alreadyAsked = lastAssistant && !lastAssistant.recommendation && recentHistory.some(item => item.role === 'user')
      if (!record && !corrected && records.size && (Number.isInteger(final.recommendation_id) || alreadyAsked)) {
        corrected = true
        messages.push({ role: 'user', content: `Correction: ${Number.isInteger(final.recommendation_id) ? 'that recommendation_id was not returned by a tool this turn.' : 'the user already answered your previous question.'} Recommend now using only these tool-returned IDs: ${[...records.keys()].join(', ')}. Do not ask another preference question. Return the same JSON shape.` })
        continue
      }
      // Two more backchecks: naming a found restaurant without attaching its card, and asking a question
      // mid-conversation while a confirmed city exists and no search was run this turn.
      const shownBefore = new Set(recentHistory.flatMap(item => [item.recommendation?.restaurantId, ...(item.alternatives || []).map(alt => alt.restaurantId)]).filter(Number.isInteger))
      const namedWithoutCard = !record && [...records.values()].some(item => !shownBefore.has(item.id) && String(final.reply || '').toLowerCase().includes(item.name.toLowerCase()))
      const confirmedCity = current.some(item => item.key === 'city' && item.value?.trim())
      const askedInsteadOfSearching = !record && !isOpeningTurn && confirmedCity && !events.some(item => item.tool === 'search_restaurants') && /\?\s*$/.test(String(final.reply || '').trim())
      if (!corrected && (namedWithoutCard || askedInsteadOfSearching)) {
        corrected = true
        messages.push({ role: 'user', content: namedWithoutCard ? `Correction: your reply names a restaurant returned by a tool but recommendation_id is null. Set recommendation_id (and alternatives) to the IDs you describe: ${[...records.keys()].join(', ')}. Return the same JSON shape.` : 'Correction: the city is confirmed. Do not ask about cuisine, price, or vibe. Search that city now with only the hard requirements in context and recommend; ask a question only if the search returns no candidates. Return the same JSON shape.' })
        continue
      }
      const resolvedCity = current.some(item => item.key === 'city' && item.value?.trim())
      const locationState = resolvedCity ? 'resolved' : priorLocationPrompts >= 3 ? 'exhausted' : 'asked'
      const alternatives = record && Array.isArray(final.alternatives) ? [...new Map(final.alternatives.filter(item => Number.isInteger(item?.id) && item.id !== record.id && records.has(item.id)).map(item => [item.id, item])).values()].slice(0, 2).map(item => card(records.get(item.id), item.why, item.caveat)) : []
      // Cards already on screen in the latest reply that showed cards (e.g. the user just picked one of them) are not repeated.
      const lastWithCards = [...recentHistory].reverse().find(item => item.role === 'assistant' && item.recommendation)
      const lastShown = [lastWithCards?.recommendation?.restaurantId, ...(lastWithCards?.alternatives || []).map(item => item.restaurantId)].filter(Number.isInteger)
      const repeatsLast = !!record && [record.id, ...alternatives.map(item => item.restaurantId)].every(id => lastShown.includes(id))
      return { reply: final.reply || 'What sounds good?', recommendation: record && !repeatsLast ? card(record, final.why, final.caveat) : undefined, alternatives: repeatsLast ? [] : alternatives, context: current, activity: events, noMatches: events.some(x => x.tool === 'search_restaurants' && x.summary === 'No candidates found'), locationState }
    }
    for (const call of assistant.tool_calls) {
      let args; try { args = JSON.parse(call.function.arguments || '{}') } catch { args = {} }
      let output
      try {
        if (call.function.name === 'update_context') {
          // A location only counts once the user states it, or answers a question that named it; a remembered city is never assumed.
          // The previous reply only counts as offering a city when it asked a question.
          const previousReply = [...recentHistory].reverse().find(item => item.role === 'assistant')?.text || ''
          const lastAssistantText = previousReply.includes('?') ? previousReply : ''
          const unconfirmed = Object.entries(args.set || {}).filter(([field, value]) => isLocationKey(field) && ((!looselyMentions(message, String(value)) && !looselyMentions(lastAssistantText, String(value))) || (onlyBackgroundMention(message, String(value)) && !looselyMentions(lastAssistantText, String(value))))).map(([field]) => field)
          if (unconfirmed.length) { args.set = Object.fromEntries(Object.entries(args.set).filter(([field]) => !unconfirmed.includes(field))) }
          const result = applyContext(current, args); current = result.next; output = unconfirmed.length ? { ...result, not_saved: unconfirmed, reason: 'The user has not confirmed this location in this conversation. Ask them to confirm it.' } : result
          result.changes.forEach(change => events.push(event('update_context', 'complete', `Updated ${change.field}`, args, null, change)))
        } else if (call.function.name === 'search_restaurants') {
          const currentCity = current.find(item => item.key === 'city' && item.value?.trim())?.value
          if (!currentCity) {
            output = { location_required: true }
            events.push(event('search_restaurants', 'complete', 'Waiting for location', args, output))
            messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(output) })
            continue
          }
          const city = currentCity
          args.city = city
          const excluded = Array.isArray(args.exclude_restaurant_ids) ? args.exclude_restaurant_ids.filter(id => Number.isInteger(id) && priorRecommendationIds.has(id)) : []
          // Excluding a restaurant from another city is a no-op; drop it so the trace stays honest.
          excluded.splice(0, excluded.length, ...excluded.filter(id => !recentCatalog.get(id) || recentCatalog.get(id).city.toLowerCase() === city.toLowerCase()))
          args.exclude_restaurant_ids = excluded
          // The same term in both filters (e.g. "vegan") would require it in the cuisine label too; keep it only as a keyword.
          if (typeof args.cuisine === 'string' && typeof args.keyword === 'string' && args.cuisine.trim().toLowerCase() === args.keyword.trim().toLowerCase()) args.cuisine = ''
          const filters = { min_price_level: args.min_price_level, max_price_level: args.max_price_level, cuisine: args.cuisine, keyword: args.keyword, excluded }
          const { data, error } = await applyFilters(db.from('restaurants').select(select).limit(SEARCH_LIMIT).ilike('city', city), filters); if (error) throw error
          cacheRecords(data); for (const item of data || []) records.set(item.id, item)
          output = data?.length ? data : { candidates: [], diagnostic: await emptyResultDiagnostic(city, filters) }
          events.push(event('search_restaurants', 'complete', data?.length ? `${data.length} candidates found` : 'No candidates found', args, data?.map(x => ({ id: x.id, name: x.name })) || []))
        } else if (call.function.name === 'get_restaurant_details') {
          const { data, error } = await db.from('restaurants').select(select).eq('id', args.restaurant_id).maybeSingle(); if (error) throw error
          if (data) records.set(data.id, data); output = data || { error: 'Not found' }; events.push(event('get_restaurant_details', 'complete', data ? `Loaded ${data.name}` : 'Restaurant not found', args, output))
        } else throw new Error('Unsupported tool')
      } catch (error) {
        if (call.function.name === 'search_restaurants') {
          const fallback = cachedSearch(args); cacheRecords(fallback); for (const item of fallback) records.set(item.id, item)
          output = fallback.length ? fallback : { unavailable: true, candidates: [] }
          events.push(event('search_restaurants', fallback.length ? 'complete' : 'error', fallback.length ? `Used ${fallback.length} recent catalog matches` : 'Search temporarily unavailable', args, fallback.length ? fallback.map(item => ({ id: item.id, name: item.name })) : { error: errorText(error) }))
        } else if (call.function.name === 'get_restaurant_details' && recentCatalog.has(args.restaurant_id)) {
          const fallback = recentCatalog.get(args.restaurant_id); records.set(fallback.id, fallback)
          output = fallback; events.push(event('get_restaurant_details', 'complete', `Used recent details for ${fallback.name}`, args, { id: fallback.id, name: fallback.name }))
        } else {
          output = { error: errorText(error) }; events.push(event(call.function.name, 'error', 'Tool failed', args, output))
        }
      }
      messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(output) })
    }
  }
  throw new Error('The concierge reached its six-tool limit. Please retry.')
}
