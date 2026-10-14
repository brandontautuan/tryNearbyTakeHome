// Restaurant concierge agent. Runs server-side only: it holds the Supabase key and the OpenRouter key.
// Served as POST /api/chat by the Vite middleware locally (vite.config.ts) and by api/chat.js on Vercel.
//
// One call to chat() is one user turn:
//   1. normalize the request (context, history, location state)
//   2. build the system prompts
//   3. run the tool loop (update_context → search_restaurants / get_restaurant_details → final JSON)
//   4. validate the model's answer against tool-returned records and build restaurant cards
import OpenAI from 'openai'
import { createClient } from '@supabase/supabase-js'
import { readFileSync } from 'node:fs'

// ---------------------------------------------------------------------------
// Environment and clients
// ---------------------------------------------------------------------------

// Locally, values come from .env; on Vercel there is no .env and they come from project environment variables.
// Minimal reader (KEY=value lines only); real environment variables take precedence.
function environment() {
  let file = ''
  try { file = readFileSync(new URL('../.env', import.meta.url), 'utf8') } catch {}
  const fromFile = Object.fromEntries(file.split(/\r?\n/)
    .filter(line => /^[A-Z][A-Z0-9_]*=/.test(line))
    .map(line => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]))
  return { ...fromFile, ...process.env }
}
const env = environment()
const url = env.SUPABASE_URL || env.NEXT_PUBLIC_SUPABASE_URL
// Local compatibility fallback. Do not use a NEXT_PUBLIC variable for a secret in deployment.
const key = env.SUPABASE_SERVICE_ROLE_KEY || env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY
if (!url || !key || !env.OPENROUTER_API_KEY) throw new Error('Supabase URL/key or OPENROUTER_API_KEY is missing.')
// Per-request timeouts. A whole turn also has a deadline (TURN_DEADLINE_MS below).
const DB_TIMEOUT_MS = 5000
const MODEL_TIMEOUT_MS = 15000
// Every Supabase request gets a timeout, so a hung database surfaces as an error (and the cache fallback) instead of a stuck turn.
const timedFetch = (input, init = {}) => fetch(input, { ...init, signal: init.signal ? AbortSignal.any([init.signal, AbortSignal.timeout(DB_TIMEOUT_MS)]) : AbortSignal.timeout(DB_TIMEOUT_MS) })
const db = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false }, global: { fetch: timedFetch } })
// OpenRouter speaks the OpenAI chat-completions API, so the OpenAI SDK is pointed at it.
const ai = new OpenAI({ apiKey: env.OPENROUTER_API_KEY, baseURL: 'https://openrouter.ai/api/v1', timeout: MODEL_TIMEOUT_MS, maxRetries: 1 })

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

// Columns loaded for a restaurant; these are the only facts the model is allowed to cite.
const select = 'id,name,address,city,cuisine,price_level,hours_text,context_text'
// Read-through cache of only catalog records previously returned by Supabase.
// It never fabricates a restaurant and never writes to the database. It lives as long as the
// process and is shared across requests; it is the fallback when Supabase fails.
const recentCatalog = new Map()
// Results are unranked, so a small limit silently drops good matches; the UI still caps alternatives separately.
const SEARCH_LIMIT = 5
// Maximum model calls per turn, including corrective retries. One round can request several tools,
// so tool calls have their own budget; past it, calls are skipped and the model must answer.
const MAX_ROUNDS = 6
const MAX_TOOL_CALLS = 8
// Wall-clock budget for one turn; past it the turn ends with a friendly "try again" reply.
const TURN_DEADLINE_MS = 25000
// The fixed set of context fields. Keys are what is stored; values are the display labels.
const label = { city: 'City', budget: 'Budget', time: 'Time', companions: 'Companions', group: 'Group size', occasion: 'Occasion', vibe: 'Atmosphere', diet: 'Dietary needs', cuisine: 'Cuisine' }

// ---------------------------------------------------------------------------
// Tool schemas (OpenAI function-calling format)
// ---------------------------------------------------------------------------

const tools = [
  {
    type: 'function',
    function: {
      name: 'update_context',
      description: 'Change only specified context. Preserve unrelated saved preferences and tonight plans. Put explicit enduring statements about the user in saved (for example “I am vegan” or “I usually prefer quiet places”). Put this outing’s city, budget, time, companions, group size, and occasion in tonight.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          scope: { type: 'string', enum: ['saved', 'tonight'], description: 'saved for durable user preferences; tonight for this outing only.' },
          set: {
            type: 'object',
            description: 'Fields to add or replace. Only these fields exist; never store restaurant IDs, search keywords, or anything else.',
            additionalProperties: false,
            properties: Object.fromEntries(Object.keys(label).map(field => [field, { type: 'string', description: label[field] }]))
          },
          remove: { type: 'array', description: 'Field keys to remove only from the named scope.', items: { type: 'string', enum: Object.keys(label) } },
          new_outing: { type: 'boolean', description: 'true when the user signals a new outing: they are back later, it is a different meal or time, or they are with different people. Clears the previous tonight plans before applying set.' }
        },
        required: ['scope']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'search_restaurants',
      description: 'Search the supplied catalog by supported filters. Search before recommending. Use min_price_level and max_price_level together to request one exact price band. Use exclude_restaurant_ids for requests such as “more like that” so you do not repeat an earlier recommendation.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          // The server always replaces this with the city from context; see the search_restaurants handler in chat().
          city: { type: 'string', description: 'A canonical city name inferred from the user’s wording.' },
          min_price_level: { type: 'integer', minimum: 1, maximum: 4 },
          max_price_level: { type: 'integer', minimum: 1, maximum: 4 },
          cuisine: { type: 'string', description: 'A cuisine style such as Mexican or ramen. Dietary needs like vegan or gluten-free go in keyword, not here.' },
          keyword: { type: 'string', description: 'One short word or phrase that must appear in the restaurant’s listed context, for dietary needs or atmosphere (for example “vegan”, “gluten”, “quiet”, “patio”). Omit when not needed.' },
          exclude_restaurant_ids: { type: 'array', description: 'Only when the user asks for different or more options than ones already shown: those earlier IDs. Never when the user is refining requirements (for example adding a dietary need).', items: { type: 'integer' } }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'get_restaurant_details',
      description: 'Retrieve complete supplied details for a restaurant returned from search.',
      parameters: { type: 'object', additionalProperties: false, properties: { restaurant_id: { type: 'integer' } }, required: ['restaurant_id'] }
    }
  }
]

// ---------------------------------------------------------------------------
// Context helpers
// ---------------------------------------------------------------------------

// Context is a fixed set of fields; common synonyms map onto them and anything else (e.g. restaurant_id) is dropped.
const contextAliases = { dietary: 'diet', dietary_needs: 'diet', dietary_restrictions: 'diet', diet_preference: 'diet', dietary_preference: 'diet', cuisine_preference: 'cuisine', group_size: 'group', party_size: 'group', atmosphere: 'vibe', ambiance: 'vibe', location: 'city', companion: 'companions' }
// Normalizes a field name ("Party Size" → "party_size") and resolves it to a key in `label`, or null if unsupported.
function contextKey(key) {
  const normalized = String(key || '').toLowerCase().trim().replace(/[\s-]+/g, '_')
  return label[normalized] ? normalized : contextAliases[normalized] || null
}
// Where someone eats changes outing to outing, so location is never a saved preference.
function isLocationKey(key) { return /city|location|neighbo|area|address|zip|town/i.test(key) }

// Cleans client-supplied context: maps keys onto supported fields, drops empty values and saved
// locations, and collapses duplicates (same scope and key) keeping the latest value, so stale or
// repeated context never accumulates.
function normalizeContext(context) {
  if (!Array.isArray(context)) return []
  const entries = context
    .map(item => ({ ...item, key: contextKey(item?.key) }))
    .filter(item => item.key && String(item.value ?? '').trim() && !(item.kind === 'saved' && isLocationKey(item.key)))
    .map(item => [`${item.kind}:${item.key}`, { ...item, label: label[item.key] }])
  return [...new Map(entries).values()]
}

// Applies an update_context call. Returns the new context plus human-readable changes for the
// activity log. The input array is not mutated.
function applyContext(context, args) {
  // A new outing wipes every tonight field first; saved preferences survive.
  const cleared = args.new_outing === true ? context.filter(item => item.kind === 'tonight') : []
  if (cleared.length) context = context.filter(item => item.kind !== 'tonight')
  const scope = args.scope === 'saved' ? 'saved' : 'tonight'
  const set = Object.fromEntries(Object.entries(args.set || {}).map(([field, value]) => [contextKey(field), value]).filter(([field]) => field))
  const remove = Array.isArray(args.remove) ? args.remove.map(contextKey).filter(Boolean) : []
  const next = context.filter(item => !(item.kind === scope && remove.includes(item.key))).map(item => ({ ...item }))
  const changes = cleared.map(item => ({ field: item.label, from: item.value, to: 'removed' }))
  for (const [field, input] of Object.entries(set)) {
    const value = String(input).trim()
    if (!value) continue
    // Locations are forced into tonight even if the model asked for saved.
    const fieldScope = isLocationKey(field) ? 'tonight' : scope
    const existing = next.find(item => item.kind === fieldScope && item.key === field)
    if (existing && existing.value === value) continue
    if (existing) {
      changes.push({ field: existing.label, from: existing.value, to: value })
      existing.value = value
    } else {
      const item = { key: field, label: label[field] || field, value, kind: fieldScope }
      next.push(item)
      changes.push({ field: item.label, from: '—', to: value })
    }
  }
  for (const field of remove) {
    const old = context.find(item => item.kind === scope && item.key === field)
    if (old) changes.push({ field: old.label, from: old.value, to: 'removed' })
  }
  return { next, changes }
}

// ---------------------------------------------------------------------------
// Location confirmation helpers
// ---------------------------------------------------------------------------

// True when `text` contains `target` allowing a couple of typos ("irivine" ≈ "Irvine").
// Slides windows of roughly the target's length over the text and runs Levenshtein on each;
// the typo budget is one edit per four letters (minimum one).
function looselyMentions(text, target) {
  const hay = text.toLowerCase().replace(/[^a-z]/g, ''), needle = target.toLowerCase().replace(/[^a-z]/g, '')
  if (!needle) return false
  if (hay.includes(needle)) return true
  const budget = Math.max(1, Math.floor(needle.length / 4))
  for (let len = needle.length - budget; len <= needle.length + budget; len++) {
    for (let start = 0; start + len <= hay.length; start++) {
      const window = hay.slice(start, start + len)
      const row = Array.from({ length: needle.length + 1 }, (_, i) => i)
      for (let i = 1; i <= window.length; i++) {
        let prev = row[0]
        row[0] = i
        for (let j = 1; j <= needle.length; j++) {
          const temp = row[j]
          row[j] = Math.min(row[j] + 1, row[j - 1] + 1, prev + (window[i - 1] === needle[j - 1] ? 0 : 1))
          prev = temp
        }
      }
      if (row[needle.length] <= budget) return true
    }
  }
  return false
}
// "I live in Santa Ana" describes the user, not where they are eating tonight.
// True only when every mention of `target` is preceded by a background phrase (live, work, from, …).
function onlyBackgroundMention(text, target) {
  const lower = text.toLowerCase(), needle = target.toLowerCase().trim()
  let index = lower.indexOf(needle), mentions = 0, background = 0
  while (needle && index !== -1) {
    mentions++
    if (/\b(live|living|lives|based|work|works|working|home|from|grew up|stay|staying)\b[\s\w]{0,12}$/.test(lower.slice(Math.max(0, index - 30), index))) background++
    index = lower.indexOf(needle, index + needle.length)
  }
  return mentions > 0 && mentions === background
}
// Location fields in an update_context `set` the user has not confirmed: the value appears in neither
// the user's message nor the assistant's last question, or the user mentioned it only as background
// ("I live in …") and the assistant never asked about it.
function unconfirmedLocations(set, message, lastQuestion) {
  return Object.entries(set || {})
    .filter(([field, value]) => {
      if (!isLocationKey(field)) return false
      const inMessage = looselyMentions(message, String(value)), askedAbout = looselyMentions(lastQuestion, String(value))
      return (!inMessage && !askedAbout) || (onlyBackgroundMention(message, String(value)) && !askedAbout)
    })
    .map(([field]) => field)
}

// ---------------------------------------------------------------------------
// Catalog helpers
// ---------------------------------------------------------------------------

// The restaurant card shape sent to the UI (Recommendation in src/mockConcierge.ts).
// `warning` is set only when the restaurant still misses a hard requirement after a corrective retry.
function card(record, why, caveat, warning) {
  return {
    ...(warning ? { warning } : {}),
    restaurantId: record.id,
    name: record.name,
    cuisine: record.cuisine,
    price: `Price level ${record.price_level}`,
    address: record.address,
    hours: record.hours_text,
    why: why || 'Selected from the supplied restaurant catalog.',
    caveat: caveat || 'Review the listed restaurant context for limitations.'
  }
}
// One row in the UI's activity panel (Activity in src/mockConcierge.ts).
// `outcome` distinguishes search results: ok, empty (nothing matches), fallback (cached records because
// live search failed), or unavailable (live search failed and nothing was cached).
function event(tool, status, summary, input, result, change, outcome) {
  return { id: crypto.randomUUID(), tool, status, summary, input: input ? JSON.stringify(input) : undefined, result: result ? JSON.stringify(result) : undefined, change, ...(outcome ? { outcome } : {}) }
}
function errorText(error) { return error instanceof Error ? error.message : (typeof error?.message === 'string' ? error.message : 'Tool failed') }
function cacheRecords(records) { for (const record of records || []) recentCatalog.set(record.id, record) }
async function catalogCities() {
  const { data } = await db.from('restaurants').select('city').limit(100)
  return [...new Set((data || []).map(item => item.city).filter(Boolean))].sort()
}
// Escapes LIKE wildcards so a keyword such as "100%" is matched literally.
function escapeLike(text) { return text.replace(/[\\%_]/g, '\\$&') }
// Adds the optional search filters to a Supabase query. The caller applies the city.
function applyFilters(query, { min_price_level, max_price_level, cuisine, keyword, excluded = [] }) {
  if (Number.isInteger(min_price_level)) query = query.gte('price_level', min_price_level)
  if (Number.isInteger(max_price_level)) query = query.lte('price_level', max_price_level)
  if (typeof cuisine === 'string' && cuisine.trim()) query = query.ilike('cuisine', `%${escapeLike(cuisine.trim())}%`)
  if (typeof keyword === 'string' && keyword.trim()) query = query.ilike('context_text', `%${escapeLike(keyword.trim())}%`)
  if (excluded.length) query = query.not('id', 'in', `(${excluded.join(',')})`)
  return query
}
// Explains an empty search by re-running it with each filter dropped, so the
// agent can name the blocking requirement and offer real catalog alternatives.
async function emptyResultDiagnostic(city, filters) {
  // Matching rows (in `city` unless inCity is false), or null if the query failed.
  const rows = async (f, inCity = true) => {
    let query = applyFilters(db.from('restaurants').select('city').limit(100), f)
    if (inCity) query = query.ilike('city', city)
    const { data, error } = await query
    return error ? null : data
  }
  // Nothing at all in this city: the city itself is the problem.
  const cityRows = await rows({ excluded: filters.excluded })
  if (cityRows?.length === 0) return { city, city_result_count: 0, available_cities: await catalogCities(), blocking_constraint: 'city' }
  const used = ['cuisine', 'keyword', 'price'].filter(k => k === 'price'
    ? Number.isInteger(filters.min_price_level) || Number.isInteger(filters.max_price_level)
    : typeof filters[k] === 'string' && filters[k].trim())
  const matchesIfDropped = {}
  for (const k of used) {
    const relaxed = k === 'price' ? { ...filters, min_price_level: undefined, max_price_level: undefined } : { ...filters, [k]: undefined }
    matchesIfDropped[k] = (await rows(relaxed))?.length ?? null
  }
  const otherCities = [...new Set(((await rows(filters, false)) || []).map(item => item.city))].filter(item => item.toLowerCase() !== city.toLowerCase()).sort()
  const blocking = used.find(k => matchesIfDropped[k] > 0) || (otherCities.length ? 'city' : 'refine_preferences')
  const summary = [
    `0 restaurants in ${city} match every requested filter.`,
    ...used.map(k => `Dropping only the ${k} filter would leave ${matchesIfDropped[k] ?? 'an unknown number of'} restaurants in ${city}.`),
    otherCities.length ? `The same filters do match in other catalog cities: ${otherCities.join(', ')}.` : 'No other catalog city matches the same filters.'
  ].join(' ')
  return { city, city_result_count: cityRows?.length ?? null, summary, matches_if_dropped: matchesIfDropped, same_filters_in_other_cities: otherCities, blocking_constraint: blocking }
}
// In-memory version of the search over recentCatalog. Used only when Supabase errors.
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

// ---------------------------------------------------------------------------
// Guards: tool-argument validation and hard-requirement checks
// ---------------------------------------------------------------------------

// The fields each tool accepts. The schemas guide the model; this is what the server enforces.
const toolFields = {
  update_context: ['scope', 'set', 'remove', 'new_outing'],
  search_restaurants: ['city', 'min_price_level', 'max_price_level', 'cuisine', 'keyword', 'exclude_restaurant_ids'],
  get_restaurant_details: ['restaurant_id']
}
// Checks a tool call's raw JSON arguments before anything runs. Returns cleaned args plus a list of
// problems; a call with problems is not executed and the problems go back to the model instead.
// knownIds: restaurant IDs a tool returned this turn or shown earlier, the only ones details may load.
function validateToolArgs(name, raw, knownIds) {
  if (!toolFields[name]) return { args: {}, problems: [`unknown tool ${name}`] }
  let args
  try { args = JSON.parse(raw || '{}') } catch { return { args: {}, problems: ['arguments were not valid JSON'] } }
  if (!args || typeof args !== 'object' || Array.isArray(args)) return { args: {}, problems: ['arguments must be a JSON object'] }
  const problems = Object.keys(args).filter(field => !toolFields[name].includes(field)).map(field => `unknown field ${field}`)
  const present = field => args[field] !== undefined && args[field] !== null
  const text = (field, max) => {
    if (!present(field)) return delete args[field]
    if (typeof args[field] !== 'string') problems.push(`${field} must be a string`)
    else if (args[field].length > max) problems.push(`${field} must be at most ${max} characters`)
  }
  const priceLevel = field => {
    if (!present(field)) return delete args[field]
    const value = typeof args[field] === 'string' && /^\s*\d+\s*$/.test(args[field]) ? Number(args[field]) : args[field]
    if (!Number.isInteger(value) || value < 1 || value > 4) problems.push(`${field} must be an integer from 1 to 4`)
    else args[field] = value
  }
  if (name === 'update_context') {
    // A missing scope defaults to tonight in applyContext; only a wrong value is rejected.
    if (present('scope') && !['saved', 'tonight'].includes(args.scope)) problems.push('scope must be "saved" or "tonight"')
    if (present('set')) {
      if (typeof args.set !== 'object' || Array.isArray(args.set)) problems.push('set must be an object')
      else for (const [field, value] of Object.entries(args.set)) {
        if (typeof value === 'number' || typeof value === 'boolean') args.set[field] = String(value)
        else if (typeof value !== 'string') problems.push(`set.${field} must be a string`)
        else if (value.length > 120) problems.push(`set.${field} must be at most 120 characters`)
      }
    }
    if (present('remove') && !(Array.isArray(args.remove) && args.remove.every(item => typeof item === 'string'))) problems.push('remove must be an array of field names')
    if (present('new_outing') && typeof args.new_outing !== 'boolean') problems.push('new_outing must be true or false')
  } else if (name === 'search_restaurants') {
    text('city', 80)
    text('cuisine', 60)
    text('keyword', 60)
    priceLevel('min_price_level')
    priceLevel('max_price_level')
    if (Number.isInteger(args.min_price_level) && Number.isInteger(args.max_price_level) && args.min_price_level > args.max_price_level) problems.push('min_price_level cannot be above max_price_level')
    if (present('exclude_restaurant_ids') && !(Array.isArray(args.exclude_restaurant_ids) && args.exclude_restaurant_ids.length <= 20 && args.exclude_restaurant_ids.every(Number.isInteger))) problems.push('exclude_restaurant_ids must be an array of at most 20 integer IDs')
  } else if (name === 'get_restaurant_details') {
    if (!Number.isInteger(args.restaurant_id)) problems.push('restaurant_id must be an integer')
    else if (!knownIds.has(args.restaurant_id)) problems.push('restaurant_id must be one returned by search this turn or shown earlier')
  }
  return { args, problems }
}

// Dietary needs the checker can verify, each with the listing words that count as evidence.
const dietEvidence = { vegan: ['vegan', 'plant-based'], vegetarian: ['vegetarian', 'vegan', 'plant-based'], 'gluten-free': ['gluten'], 'dairy-free': ['dairy-free', 'dairy free', 'vegan'], halal: ['halal'], kosher: ['kosher'], 'nut-free': ['nut-free', 'nut free'] }
// Splits every diet value in context into checks: { term, evidence[] }. Known diets use their synonym
// list; anything else (e.g. "keto", "pescatarian") is checked literally against the listing, so new
// diets are covered without code changes. "vegan (for girlfriend), keto" → vegan + keto.
function dietChecks(context) {
  const values = context.filter(item => item.key === 'diet').map(item => item.value.toLowerCase())
  const segments = values.flatMap(value => value.replace(/\([^)]*\)/g, ' ').split(/,|\/|;|\band\b|\bor\b/))
    .map(segment => segment.replace(/\b(for|my|her|his|their|the|a|an|friend|friends|girlfriend|boyfriend|partner|wife|husband|kids?|options?|only|diet|strict|is|are|she|he|they|we|i|am|needs?)\b/g, ' ').replace(/\s+/g, ' ').trim())
    .filter(Boolean)
  const checks = []
  for (const segment of segments) {
    const known = Object.keys(dietEvidence).filter(term => segment.includes(term) || segment.includes(term.replace('-', ' '))
      || (term === 'gluten-free' && /gluten|celiac|coeliac/.test(segment)) || (term === 'vegetarian' && /veggie/.test(segment)))
    if (known.length) known.forEach(term => checks.push({ term, evidence: dietEvidence[term] }))
    // Unknown diets: only short phrases are checked, so free-form notes don't trigger false warnings.
    else if (segment.split(' ').length <= 2) checks.push({ term: segment, evidence: [segment, segment.replace(/-/g, ' ')] })
  }
  return [...new Map(checks.map(check => [check.term, check])).values()]
}
// Hard requirements a recommended restaurant must meet: the confirmed city, and every dietary need its
// listing can evidence. Budget is deliberately soft and not checked here. Matching is plain text, so a
// listing that says "not vegan-friendly" would still pass.
function requirementProblems(record, context) {
  const problems = []
  const city = context.find(item => item.key === 'city' && item.value?.trim())?.value
  if (city && record.city.toLowerCase() !== city.trim().toLowerCase()) problems.push(`it is in ${record.city}, not ${city}`)
  const listing = `${record.cuisine} ${record.context_text || ''}`.toLowerCase()
  for (const { term, evidence } of dietChecks(context)) if (!evidence.some(word => listing.includes(word))) problems.push(`its listing does not mention ${term} options`)
  return problems
}

// ---------------------------------------------------------------------------
// Request normalization
// ---------------------------------------------------------------------------

// Trims client history to the last 12 user/assistant turns and keeps only the card fields the model needs.
function normalizeHistory(history) {
  if (!Array.isArray(history)) return []
  return history.slice(-12)
    .filter(item => item && (item.role === 'user' || item.role === 'assistant'))
    .map(item => ({
      role: item.role,
      text: String(item.text || '').slice(0, 2000),
      recommendation: item.recommendation && { restaurantId: item.recommendation.restaurantId, name: item.recommendation.name, cuisine: item.recommendation.cuisine, price: item.recommendation.price },
      alternatives: Array.isArray(item.alternatives) ? item.alternatives.filter(alt => Number.isInteger(alt?.restaurantId)).slice(0, 3).map(alt => ({ restaurantId: alt.restaurantId, name: alt.name })) : []
    }))
}
// Older stored conversations may have recommendations without an ID; look them up by name. Mutates `history`.
async function backfillRecommendationIds(history) {
  const unresolvedNames = [...new Set(history.filter(item => item.recommendation?.name && !Number.isInteger(item.recommendation.restaurantId)).map(item => item.recommendation.name))]
  if (!unresolvedNames.length) return
  const { data } = await db.from('restaurants').select('id,name').in('name', unresolvedNames)
  const idsByName = new Map((data || []).map(item => [item.name, item.id]))
  history.forEach(item => { if (item.recommendation && !Number.isInteger(item.recommendation.restaurantId)) item.recommendation.restaurantId = idsByName.get(item.recommendation.name) })
}

// ---------------------------------------------------------------------------
// Prompts
// ---------------------------------------------------------------------------

// Builds the message list for the first model call, in this order: main rules, personalization,
// delegation/location, location wording, outings/hours, then the user turn.
function buildMessages({ message, current, recentHistory, priorRecommendationIds, coverageCities, isOpeningTurn, previousCity, userTime }) {
  return [
    { role: 'system', content: `You are a concise, warm restaurant concierge. Your FIRST action on every turn must be update_context: extract explicit preferences or plans from the user's message, preserve unrelated context, and use an empty update when there is nothing to change. Saved preferences are durable statements about the user (for example, “I’m vegan”). Tonight plans include city, budget, time, companions, group size, and occasion. LOCATION GATE: after update_context, do not call search_restaurants unless its resulting context contains a city. With a city, search that exact city only. This catalog has no coordinates, so never claim a radius, proximity ranking, or that another city is nearby. If no city remains after update_context and location prompts used is under 3, ask one concise location question and do not recommend a restaurant. If no city remains and prompts used is 3, stop asking; say you cannot confidently recommend somewhere local and offer only these catalog coverage cities: ${JSON.stringify(coverageCities)}. Use the supplied recent history to resolve references such as “that place,” “the last one,” or “more like it.” When offering alternatives, exclude only the referenced ID from this known list: ${JSON.stringify([...priorRecommendationIds])}. Preserve hard requirements, especially dietary needs, using keyword when supported. Treat the prior cuisine label, exact price band, and descriptive wording as soft similarities: never pass a long multi-tag cuisine string as a cuisine filter. If the first alternative search is empty, try one broader search that keeps city, hard dietary needs, and the exclusion but drops soft cuisine/price preferences before asking a question. Use both min_price_level and max_price_level when their wording calls for one exact price band. Then use only supplied catalog facts. Ask one useful question only when it changes a recommendation; once the user has answered a question, deferred the choice to you, or confirmed, recommend from the candidates instead of asking again. If every search this turn returned no candidates, never say you found restaurants and never name a restaurant: state plainly which requirement has no catalog match, using diagnostic.summary as the source of truth, and offer the concrete options it lists in one question. If the user then defers ("whatever", "you pick", "sounds good", or any equivalent) or has already been asked about this conflict, do not ask again: relax the blocking soft preference (cuisine, price, or atmosphere wording) yourself, search again in the same city, and recommend; tell them what you relaxed. City and dietary needs stay hard unless the user explicitly changes them. Any restaurant your reply names must be a tool-returned ID given as recommendation_id or in alternatives. When the user asks to see again a restaurant recommended earlier in the conversation, set recommendation_id to that restaurantId. When they simply choose one of the restaurants you just showed, confirm briefly and set recommendation_id to null; the card is already on screen. Never offer reservations or other actions you cannot perform. Never invent ratings, exact prices, availability, or dietary safety. Never relax a hard requirement without asking. If an empty search result has diagnostic.city_result_count 0, say you cannot confidently recommend a restaurant in that city, offer diagnostic.available_cities, and only search another city if the user explicitly names or accepts it. Never mention databases, tools, errors, outages, or system access to the user. If a search result has status "fallback", recommend from its candidates normally. A tool result with status "invalid_arguments" lists problems: fix them and call again. A tool result with status "budget_exhausted" means answer now with what you already have. If no candidate data is available, say warmly that you are having trouble narrowing the list right now and ask one helpful preference question; never fabricate a restaurant. After tool use, return ONLY JSON: {"reply":"...","recommendation_id":number|null,"why":"...","caveat":"...","alternatives":[{"id":number,"why":"...","caveat":"..."}]}. recommendation_id must be an ID returned by a tool. why and caveat describe only that primary restaurant. When your reply suggests more than one restaurant, list at most two additional restaurants (each an ID returned by a tool) in alternatives with its own why and caveat; otherwise use an empty array.` },
    { role: 'system', content: `Personalization rule: saved preferences are context, not an automatic decision. Treat hard requirements such as dietary restrictions as constraints; treat prior cuisines, cities, and restaurants as soft signals that may inform a question or tie-break only after the user states what they want for this outing. Never recommend a restaurant solely because it matches a remembered preference, and do not repeatedly steer the user toward a remembered cuisine or place. This is ${isOpeningTurn ? 'the opening user turn of a new conversation' : 'an ongoing conversation'}. On an opening turn without a concrete dining request, ask one broad, open-ended question about what they feel like eating; do not search or recommend. A concrete request includes a cuisine, dish, meal type, occasion, location, budget, dietary need, or direct request for a recommendation, including asking you to choose for them. Use the user’s new message and current-outing context as the primary signal; only mention a saved preference when it directly helps resolve an ambiguity.` },
    { role: 'system', content: `Delegation: when the user hands the choice to you ("surprise me", "pick for me", "you decide", "anything", or any equivalent), cuisine, price, and atmosphere are open; never ask about them. The city is the only thing you may still ask for. Once a city is confirmed in this conversation, search it using only hard requirements already in context (dietary needs such as vegan or gluten-free, passed as keyword) and recommend one restaurant plus alternatives. Location: always store city in tonight, never in saved. People eat in different cities from day to day, so a city counts only once the user says they are eating there for this outing, or confirms it. Where they live, work, or are based is background, not tonight's location: ask "Eating in <that city> tonight?" before storing or searching it. ${previousCity ? `Their last-used city was ${previousCity}. Whenever you ask for a location, your question MUST name it as a quick confirmation, for example "Still eating in ${previousCity}, or somewhere else?"; never store or search it until they confirm.` : ''}` },
    { role: 'system', content: 'Non-negotiable location wording: this catalog only has city names, not coordinates. Never describe a different city as nearby, closest, local to, within a radius, or a short drive. When coverage is missing, say only that the catalog includes records in named other cities.' },
    { role: 'system', content: `Outings: when the user signals a new outing (they are back, it is a different meal or time, or they are with different people), the previous tonight plans no longer apply. In that turn's update_context, remove the old tonight fields (city, companions, group, occasion, time, budget, and any diet that belonged to a companion), then confirm the city again before searching; do not assume the old city. A companion's dietary need ("my girlfriend is vegan") is a tonight diet, never saved. Record who they are with in companions. If the user names a city and leaves the rest open ("anything around here", "whatever's good"), that is delegation: search and recommend in that turn without asking about cuisine or vibe. Hours: ${userTime ? `the user's local time is ${userTime} (for reasoning only; store time in context only when the user states one). ` : ''}When the user mentions a meal, a time, or "now", read each candidate's hours_text and prefer places open then; never recommend a place listed as closed at that time without saying so in the caveat. Also prefer places whose listed context fits the stated group and occasion.` },
    { role: 'user', content: `Current context: ${JSON.stringify(current)}\nRecent conversation: ${JSON.stringify(recentHistory)}\nUser message: ${message.trim()}` }
  ]
}

// ---------------------------------------------------------------------------
// Agent turn
// ---------------------------------------------------------------------------

export async function chat({ message, context = [], history = [], locationPromptCount = 0, lastCity = '', localTime = '' }) {
  if (typeof message !== 'string' || !message.trim() || message.length > 12000) throw new Error('A message up to 12,000 characters is required.')

  // --- Normalize the request ---
  let current = normalizeContext(context)
  const previousCity = typeof lastCity === 'string' ? lastCity.trim().slice(0, 80) : ''
  const userTime = typeof localTime === 'string' ? localTime.trim().slice(0, 60) : ''
  // events: activity log returned to the UI. records: every restaurant a tool returned this turn,
  // which is the allowlist for what the final answer may recommend.
  const events = [], records = new Map()
  const recentHistory = normalizeHistory(history)
  await backfillRecommendationIds(recentHistory)
  // IDs already shown in the conversation: the only IDs the model may exclude or recall.
  const priorRecommendationIds = new Set(recentHistory.flatMap(item => [item.recommendation?.restaurantId, ...(item.alternatives || []).map(alt => alt.restaurantId)]).filter(Number.isInteger))
  const isOpeningTurn = !recentHistory.some(item => item.role === 'user')
  const lastAssistant = [...recentHistory].reverse().find(item => item.role === 'assistant')
  const hasCity = () => current.some(item => item.key === 'city' && item.value?.trim())

  // --- Location gate: after three unanswered location questions, offer the catalog's cities instead ---
  const priorLocationPrompts = Math.max(0, Math.min(Number(locationPromptCount) || 0, 3))
  const coverageCities = !hasCity() && priorLocationPrompts >= 3 ? await catalogCities() : []

  const messages = buildMessages({ message, current, recentHistory, priorRecommendationIds, coverageCities, isOpeningTurn, previousCity, userTime })

  // --- Tool loop: each round is one model call; it ends when the model answers without tool calls ---
  let corrected = false, requirementRetried = false, toolCalls = 0
  const deadline = Date.now() + TURN_DEADLINE_MS
  // Ends the turn gracefully (keeping any context already captured) when time or steps run out.
  const stopEarly = reason => ({
    reply: 'I’m having trouble narrowing this down right now. Could you try again in a moment?',
    alternatives: [],
    context: current,
    activity: [...events, event('concierge', 'error', reason)],
    degraded: true,
    locationState: hasCity() ? 'resolved' : priorLocationPrompts >= 3 ? 'exhausted' : 'asked'
  })
  for (let round = 0; round < MAX_ROUNDS; round++) {
    if (Date.now() >= deadline) return stopEarly('Stopped: took too long')
    // Corrective retries need a spare round and spare time.
    const canRetry = round < MAX_ROUNDS - 1 && deadline - Date.now() > 3000
    // The first call is forced to update_context so preferences are captured before anything else.
    // On the last round, or once the tool budget is spent, tools are disabled so the model must answer.
    const toolChoice = round === 0 ? { type: 'function', function: { name: 'update_context' } } : round === MAX_ROUNDS - 1 || toolCalls >= MAX_TOOL_CALLS ? 'none' : 'auto'
    let response
    try {
      response = await ai.chat.completions.create({ model: env.OPENROUTER_MODEL || 'openai/gpt-4.1-mini', messages, tools, tool_choice: toolChoice, temperature: 0.2 }, { timeout: Math.max(1000, Math.min(MODEL_TIMEOUT_MS, deadline - Date.now())) })
    } catch (error) {
      if (error?.name === 'APIConnectionTimeoutError' || /timed? ?out/i.test(errorText(error))) return stopEarly('Stopped: the model timed out')
      throw error
    }
    const assistant = response.choices[0]?.message
    if (!assistant) throw new Error('The model returned no response.')
    messages.push(assistant)

    // --- Final answer: validate it and build the response ---
    if (!assistant.tool_calls?.length) {
      let final
      try { final = JSON.parse(assistant.content || '{}') } catch { final = { reply: assistant.content || 'I could not complete that request.' } }

      // A follow-up may re-reference an earlier recommendation without searching again; reload it from the catalog so its card can be shown.
      const recallIds = [final.recommendation_id, ...(Array.isArray(final.alternatives) ? final.alternatives.map(item => item?.id) : [])]
        .filter(id => Number.isInteger(id) && !records.has(id) && priorRecommendationIds.has(id))
      if (recallIds.length) {
        const { data } = await db.from('restaurants').select(select).in('id', recallIds)
        const recalled = recallIds.map(id => (data || []).find(item => item.id === id) || recentCatalog.get(id)).filter(Boolean)
        recalled.forEach(item => records.set(item.id, item))
        if (recalled.length) events.push(event('get_restaurant_details', 'complete', `Recalled ${recalled.map(item => item.name).join(', ')}`, { restaurant_ids: recallIds }, recalled.map(item => ({ id: item.id, name: item.name }))))
      }
      const record = Number.isInteger(final.recommendation_id) ? records.get(final.recommendation_id) : null

      // Backchecks. Each failure sends one corrective user message and loops again; at most one correction per turn.
      // 1. An ID that no tool returned, or another question after the user already answered one while candidates exist.
      const alreadyAsked = lastAssistant && !lastAssistant.recommendation && recentHistory.some(item => item.role === 'user')
      if (!record && !corrected && canRetry && records.size && (Number.isInteger(final.recommendation_id) || alreadyAsked)) {
        corrected = true
        messages.push({ role: 'user', content: `Correction: ${Number.isInteger(final.recommendation_id) ? 'that recommendation_id was not returned by a tool this turn.' : 'the user already answered your previous question.'} Recommend now using only these tool-returned IDs: ${[...records.keys()].join(', ')}. Do not ask another preference question. Return the same JSON shape.` })
        continue
      }
      // 2. The reply names a newly found restaurant but attaches no card.
      // 3. The reply asks a question mid-conversation while a confirmed city exists and no search ran this turn.
      const reply = String(final.reply || '')
      const namedWithoutCard = !record && [...records.values()].some(item => !priorRecommendationIds.has(item.id) && reply.toLowerCase().includes(item.name.toLowerCase()))
      const askedInsteadOfSearching = !record && !isOpeningTurn && hasCity() && !events.some(item => item.tool === 'search_restaurants') && /\?\s*$/.test(reply.trim())
      if (!corrected && canRetry && (namedWithoutCard || askedInsteadOfSearching)) {
        corrected = true
        messages.push({ role: 'user', content: namedWithoutCard ? `Correction: your reply names a restaurant returned by a tool but recommendation_id is null. Set recommendation_id (and alternatives) to the IDs you describe: ${[...records.keys()].join(', ')}. Return the same JSON shape.` : 'Correction: the city is confirmed. Do not ask about cuisine, price, or vibe. Search that city now with only the hard requirements in context and recommend; ask a question only if the search returns no candidates. Return the same JSON shape.' })
        continue
      }

      // 4. Hard requirements (city, dietary needs). A failing pick gets one corrective retry; if it still
      //    fails, its card is shown with a warning rather than hidden.
      const problems = record ? requirementProblems(record, current) : []
      if (problems.length && !requirementRetried && canRetry) {
        requirementRetried = true
        messages.push({ role: 'user', content: `Correction: ${record.name} does not meet the user's hard requirements (${problems.join('; ')}). Choose a tool-returned restaurant that does, or search again keeping the city and dietary needs; if none qualify, say so plainly. Return the same JSON shape.` })
        continue
      }
      const warning = problems.length ? `Heads up: ${problems.join('; ')}. Double-check before you go.` : undefined

      // 5. If every search this turn failed outright (no live or cached data), the model cannot know what the
      //    catalog contains, so its reply is replaced rather than risking "there are no X" claims.
      const searches = events.filter(item => item.tool === 'search_restaurants' && item.outcome)
      const searchDown = !record && searches.length > 0 && searches.every(item => item.outcome === 'unavailable')
      if (searchDown) final.reply = 'I’m having trouble checking restaurants right now. Give me a moment and try again?'

      // Tells the client how to update its location-prompt counter.
      const locationState = hasCity() ? 'resolved' : priorLocationPrompts >= 3 ? 'exhausted' : 'asked'
      // Alternatives: tool-returned, distinct from the primary, de-duplicated, at most two.
      const alternatives = record && Array.isArray(final.alternatives)
        ? [...new Map(final.alternatives.filter(item => Number.isInteger(item?.id) && item.id !== record.id && records.has(item.id) && !requirementProblems(records.get(item.id), current).length).map(item => [item.id, item])).values()]
          .slice(0, 2).map(item => card(records.get(item.id), item.why, item.caveat))
        : []
      // Cards already on screen in the latest reply that showed cards (e.g. the user just picked one of them) are not repeated.
      const lastWithCards = [...recentHistory].reverse().find(item => item.role === 'assistant' && item.recommendation)
      const lastShown = [lastWithCards?.recommendation?.restaurantId, ...(lastWithCards?.alternatives || []).map(item => item.restaurantId)].filter(Number.isInteger)
      const repeatsLast = !!record && [record.id, ...alternatives.map(item => item.restaurantId)].every(id => lastShown.includes(id))
      return {
        reply: final.reply || 'What sounds good?',
        recommendation: record && !repeatsLast ? card(record, final.why, final.caveat, warning) : undefined,
        alternatives: repeatsLast ? [] : alternatives,
        context: current,
        activity: events,
        noMatches: events.some(x => x.outcome === 'empty'),
        degraded: events.some(x => x.outcome === 'fallback' || x.outcome === 'unavailable'),
        locationState
      }
    }

    // --- Run the requested tools; each result goes back to the model as a tool message ---
    for (const call of assistant.tool_calls) {
      toolCalls++
      const { args, problems } = validateToolArgs(call.function.name, call.function.arguments, new Set([...records.keys(), ...priorRecommendationIds]))
      let output
      // Every tool call needs a tool message back, so over-budget and invalid calls are answered, not dropped.
      if (toolCalls > MAX_TOOL_CALLS || problems.length) {
        output = toolCalls > MAX_TOOL_CALLS ? { status: 'budget_exhausted' } : { status: 'invalid_arguments', problems }
        events.push(event(call.function.name, 'error', toolCalls > MAX_TOOL_CALLS ? 'Skipped: step limit reached' : 'Rejected invalid request', args, problems.length ? { problems } : null))
        messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(output) })
        continue
      }
      try {
        if (call.function.name === 'update_context') {
          // A location only counts once the user states it, or answers a question that named it; a remembered city is never assumed.
          // The previous reply only counts as offering a city when it asked a question.
          const previousReply = lastAssistant?.text || ''
          const lastQuestion = previousReply.includes('?') ? previousReply : ''
          const unconfirmed = unconfirmedLocations(args.set, message, lastQuestion)
          if (unconfirmed.length) args.set = Object.fromEntries(Object.entries(args.set).filter(([field]) => !unconfirmed.includes(field)))
          // A tonight value that merely repeats a saved preference the user did not mention this turn is not a new plan;
          // copying it into tonight would turn a soft preference into an apparent request.
          if (args.scope !== 'saved' && args.set) args.set = Object.fromEntries(Object.entries(args.set).filter(([field, value]) => {
            const saved = current.find(item => item.kind === 'saved' && contextKey(field) === item.key)?.value
            return !(saved && looselyMentions(saved, String(value)) && !looselyMentions(message, String(value)))
          }))
          const result = applyContext(current, args)
          current = result.next
          output = unconfirmed.length ? { ...result, not_saved: unconfirmed, reason: 'The user has not confirmed this location in this conversation. Ask them to confirm it.' } : result
          result.changes.forEach(change => events.push(event('update_context', 'complete', `Updated ${change.field}`, args, null, change)))
        } else if (call.function.name === 'search_restaurants') {
          // Hard location gate: never search without a confirmed city in context.
          const city = current.find(item => item.key === 'city' && item.value?.trim())?.value
          if (!city) {
            output = { status: 'location_required' }
            events.push(event('search_restaurants', 'complete', 'Waiting for location', args, output))
            messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(output) })
            continue
          }
          // The context city always wins over whatever city the model passed.
          args.city = city
          // Only earlier recommendations may be excluded; excluding a restaurant from another city is a no-op, so drop it to keep the trace honest.
          const excluded = (Array.isArray(args.exclude_restaurant_ids) ? args.exclude_restaurant_ids : [])
            .filter(id => Number.isInteger(id) && priorRecommendationIds.has(id))
            .filter(id => !recentCatalog.get(id) || recentCatalog.get(id).city.toLowerCase() === city.toLowerCase())
          args.exclude_restaurant_ids = excluded
          // The same term in both filters (e.g. "vegan") would require it in the cuisine label too; keep it only as a keyword.
          if (typeof args.cuisine === 'string' && typeof args.keyword === 'string' && args.cuisine.trim().toLowerCase() === args.keyword.trim().toLowerCase()) args.cuisine = ''
          // A cuisine that comes only from saved preferences (not tonight's plans, not this message) is a soft signal,
          // never a filter: it may bias the pick among results but must not empty the search.
          const savedCuisine = current.find(item => item.kind === 'saved' && item.key === 'cuisine')?.value
          const tonightCuisine = current.find(item => item.kind === 'tonight' && item.key === 'cuisine')?.value
          if (typeof args.cuisine === 'string' && args.cuisine.trim() && savedCuisine && !tonightCuisine && looselyMentions(savedCuisine, args.cuisine) && !looselyMentions(message, args.cuisine)) args.cuisine = ''
          const filters = { min_price_level: args.min_price_level, max_price_level: args.max_price_level, cuisine: args.cuisine, keyword: args.keyword, excluded }
          const { data, error } = await applyFilters(db.from('restaurants').select(select).limit(SEARCH_LIMIT).ilike('city', city), filters)
          if (error) throw error
          // Exclusions only make sense when other options exist. If excluding earlier picks empties the search,
          // re-run without them: those earlier picks are the honest answer, marked as already shown.
          let rows = data, previouslyShown = false
          if (!rows?.length && excluded.length) {
            const retry = await applyFilters(db.from('restaurants').select(select).limit(SEARCH_LIMIT).ilike('city', city), { ...filters, excluded: [] })
            if (retry.error) throw retry.error
            if (retry.data?.length) { rows = retry.data; previouslyShown = true }
          }
          cacheRecords(rows)
          for (const item of rows || []) records.set(item.id, item)
          output = rows?.length ? { status: 'ok', candidates: rows, ...(previouslyShown ? { note: 'Nothing new matches; these include restaurants already shown to the user.' } : {}) } : { status: 'empty', candidates: [], diagnostic: await emptyResultDiagnostic(city, filters) }
          events.push(event('search_restaurants', 'complete', rows?.length ? `${rows.length} candidates found${previouslyShown ? ' (including earlier picks)' : ''}` : 'No candidates found', args, rows?.map(x => ({ id: x.id, name: x.name })) || [], null, rows?.length ? 'ok' : 'empty'))
        } else if (call.function.name === 'get_restaurant_details') {
          const { data, error } = await db.from('restaurants').select(select).eq('id', args.restaurant_id).maybeSingle()
          if (error) throw error
          if (data) records.set(data.id, data)
          output = data || { status: 'not_found' }
          events.push(event('get_restaurant_details', 'complete', data ? `Loaded ${data.name}` : 'Restaurant not found', args, output))
        } else throw new Error('Unsupported tool')
      } catch (error) {
        // Supabase failures fall back to recently seen catalog records; anything else is reported to the model as an error.
        if (call.function.name === 'search_restaurants') {
          const fallback = cachedSearch(args)
          cacheRecords(fallback)
          for (const item of fallback) records.set(item.id, item)
          // Fallback results are labeled so neither the model nor the activity panel mistakes them for a live search.
          output = fallback.length ? { status: 'fallback', note: 'Live search failed; these are recently seen catalog records and may be incomplete.', candidates: fallback } : { status: 'unavailable', candidates: [] }
          events.push(event('search_restaurants', fallback.length ? 'complete' : 'error', fallback.length ? `Used ${fallback.length} recent catalog matches` : 'Search temporarily unavailable', args, fallback.length ? fallback.map(item => ({ id: item.id, name: item.name })) : { error: errorText(error) }, null, fallback.length ? 'fallback' : 'unavailable'))
        } else if (call.function.name === 'get_restaurant_details' && recentCatalog.has(args.restaurant_id)) {
          const fallback = recentCatalog.get(args.restaurant_id)
          records.set(fallback.id, fallback)
          output = { status: 'fallback', restaurant: fallback }
          events.push(event('get_restaurant_details', 'complete', `Used recent details for ${fallback.name}`, args, { id: fallback.id, name: fallback.name }, null, 'fallback'))
        } else {
          output = { error: errorText(error) }
          events.push(event(call.function.name, 'error', 'Tool failed', args, output))
        }
      }
      messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(output) })
    }
  }
  // Unreachable in practice (the last round disables tools), kept as a safety net.
  return stopEarly('Stopped: step limit reached')
}
