import { FormEvent, useEffect, useRef, useState } from 'react'
import { ArrowUp, Check, ChevronLeft, ChevronRight, CircleAlert, Download, Leaf, LoaderCircle, MessageSquarePlus, Pencil, RotateCcw, Sparkles, Trash2, X } from 'lucide-react'
import { Activity, askConcierge, Change, ConciergeResponse, defaultContext, Detail, HistoryItem, LogEntry, Recommendation } from './mockConcierge'

// The chat UI. All agent work happens on the server (server/concierge.mjs); this file holds the
// conversation, context, and activity log in state and mirrors them to localStorage.

type Message = { id: string; role: 'user' | 'assistant'; text: string; recommendation?: Recommendation; alternatives?: Recommendation[]; noMatches?: boolean }
// One request in the Logs view: what was sent, how it went, and the server's trace for that turn.
type TurnLog = { id: string; at: string; message: string; ms: number; status: number | 'network'; error?: string; entries: LogEntry[] }
type Stored = { messages: Message[]; context: Detail[]; activity: Activity[]; logs?: TurnLog[]; locationPromptCount?: number }
// Only the most recent turns are kept so localStorage stays small.
const MAX_TURN_LOGS = 25
const intros = [
  'What are you in the mood for?',
  'Hungry? Tell me what sounds good.',
  'Where are we eating tonight?',
  'What’s the craving today?',
  'Looking for somewhere good to eat? Tell me where you are and what you’re after.',
  'Tell me the city and the vibe, and I’ll find you a spot.',
  'Date night, quick bite, or big group dinner? Where should we start?',
  'What kind of food are you feeling right now?',
  'Got a place in mind, or want me to surprise you?',
  'Tacos, ramen, something fancy? Tell me what sounds good.',
  'Let’s find you something to eat. Which city are you in?',
  'Craving something specific, or open to ideas?'
]
// Picks a random intro, never the one shown last time.
function starter(): Message[] {
  const last = localStorage.getItem('nearby-last-intro')
  const choices = intros.filter(text => text !== last)
  const text = choices[Math.floor(Math.random() * choices.length)]
  localStorage.setItem('nearby-last-intro', text)
  return [{ id: 'hello', role: 'assistant', text }]
}
// Loads the saved conversation, tolerating missing fields; a corrupt entry is discarded.
function restoreConversation(): Stored | null {
  try {
    const raw = localStorage.getItem('nearby-concierge')
    if (!raw) return null
    const state: Stored = JSON.parse(raw)
    return {
      messages: Array.isArray(state.messages) ? state.messages : [],
      context: Array.isArray(state.context) ? state.context : [],
      activity: Array.isArray(state.activity) ? state.activity : [],
      logs: Array.isArray(state.logs) ? state.logs : [],
      locationPromptCount: state.locationPromptCount || 0,
    }
  } catch {
    localStorage.removeItem('nearby-concierge')
    return null
  }
}
function storedConversation() { return restoreConversation() || { messages: [], context: [], activity: [], locationPromptCount: 0 } }
function downloadStoredLogs() { const payload = { exported_at: new Date().toISOString(), ...storedConversation() }; const url = URL.createObjectURL(new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' })); const link = document.createElement('a'); link.href = url; link.download = `nearby-agent-log-${new Date().toISOString().slice(0, 10)}.json`; link.click(); URL.revokeObjectURL(url) }
function clearStoredLogs() { const state = storedConversation(); localStorage.setItem('nearby-concierge', JSON.stringify({ ...state, activity: [], logs: [] })); window.location.reload() }
const examples = ['Cheap dinner in Irvine', 'A quiet date spot', 'Dinner with a vegan friend']

// "What I know": saved preferences and tonight's plans, each editable and removable.
function ContextPanel({ context, onDelete, onEdit, onForget, onClearPlan }: { context: Detail[], onDelete: (detail: Detail) => void, onEdit: (detail: Detail) => void, onForget: () => void, onClearPlan: () => void }) {
  return <aside className="side-card context-card"><div className="panel-heading"><div><p className="eyebrow">YOUR PREFERENCES</p><h2>What I know</h2></div><Sparkles size={18} /></div><p className="muted">You’re always in control of what I remember.</p>{(['saved', 'tonight'] as const).map(kind => <section className="context-group" key={kind}><h3>{kind === 'saved' ? 'Saved preferences' : 'Tonight’s plans'}</h3>{context.filter(x => x.kind === kind).length ? context.filter(x => x.kind === kind).map(detail => <div className="detail" key={`${detail.kind}:${detail.key}`}><span><b>{detail.label}</b><em>{detail.value}</em></span><button onClick={() => onEdit(detail)} aria-label={`Edit ${detail.label}`}><Pencil size={14}/></button><button onClick={() => onDelete(detail)} aria-label={`Remove ${detail.label}`}><X size={15}/></button></div>) : <p className="empty">Nothing captured yet.</p>}</section>)}{context.some(detail => detail.kind === 'tonight') && <button className="forget" onClick={onClearPlan} title="Starts a fresh conversation and keeps saved preferences">Clear this meal plan</button>}{context.some(detail => detail.kind === 'saved') && <button className="forget" onClick={onForget}>Forget saved preferences</button>}</aside>
}
function parseJson(text?: string) { try { return text ? JSON.parse(text) : undefined } catch { return undefined } }
function priceRange(min?: number, max?: number) { const lo = min ?? 1, hi = max ?? 4; if (lo === 1 && hi === 4) return undefined; return lo === hi ? '$'.repeat(lo) : `${'$'.repeat(lo)}–${'$'.repeat(hi)}` }
// Turns a raw tool event into a plain-language line plus optional details.
function describe(event: Activity): { title: string; detail: string; tags: string[]; names: string[]; was?: string } {
  const input = parseJson(event.input), result = parseJson(event.result)
  const changeLine = (change: Change) => change.to === 'removed' ? `${change.field}: removed` : `${change.field}: ${change.to}`
  if (event.tool === 'update_context' && event.outcome === 'rejected') return { title: 'Location not saved', detail: event.summary.replace(/^Did not save /, ''), tags: [], names: [] }
  // One row per update_context call; a no-op call is shown too, so every tool execution appears.
  if (event.tool === 'update_context' && event.changes) {
    if (!event.changes.length) return { title: 'Checked preferences', detail: 'Nothing new to note', tags: [], names: [] }
    if (event.changes.length === 1) { const [change] = event.changes; return { title: change.to === 'removed' ? 'Forgot' : 'Noted', detail: changeLine(change), tags: [], names: [], was: change.to !== 'removed' && change.from !== '—' ? change.from : undefined } }
    return { title: `Noted ${event.changes.length} changes`, detail: event.changes.map(changeLine).join(' · '), tags: [], names: event.changes.map(changeLine) }
  }
  if (event.tool === 'manual_edit' && event.change) return { title: 'You edited your preferences', detail: changeLine(event.change), tags: [], names: [], was: event.change.to !== 'removed' ? event.change.from : undefined }
  // Logs saved before update_context events carried `changes`.
  if (event.tool === 'update_context' && event.change) {
    const field = event.change.field.replaceAll('_', ' ').toLowerCase(), removed = event.change.to === 'removed'
    return { title: removed ? `Forgot ${field}` : `Noted ${field}`, detail: removed ? event.change.from : event.change.to, tags: [], names: [], was: !removed && event.change.from !== '—' ? event.change.from : undefined }
  }
  if (event.tool === 'backcheck') return { title: event.status === 'error' ? 'Withheld a pick' : 'Double-checked the answer', detail: event.summary.replace(/^Asked the model to retry: /, ''), tags: [], names: [] }
  if (event.tool === 'search_restaurants') {
    // The result is exactly what the model received ({ status, candidates }); older logs stored a bare list.
    const list: { name?: string; city?: string }[] = Array.isArray(result) ? result : Array.isArray(result?.candidates) ? result.candidates : []
    const open = /^anywhere\b/i.test(input?.city || '')
    const names = list.map(item => open && item?.city ? `${item.name} · ${item.city}` : item?.name).filter(Boolean) as string[]
    const excluded = Array.isArray(input?.exclude_restaurant_ids) ? input.exclude_restaurant_ids.length : 0
    const tags = [input?.cuisine, priceRange(input?.min_price_level, input?.max_price_level), input?.keyword && `“${input.keyword}”`, excluded && `skipping ${excluded} shown`].filter((tag, i, all) => tag && all.findIndex(other => String(other).replace(/[“”]/g, '').toLowerCase() === String(tag).replace(/[“”]/g, '').toLowerCase()) === i) as string[]
    const count = `${names.length} ${names.length === 1 ? 'match' : 'matches'}`
    const detail = event.outcome === 'fallback' ? `${count} from recent results · live search down` : event.status === 'error' ? (event.outcome === 'unavailable' || /unavailable/i.test(event.summary) ? 'Search unavailable' : event.summary) : /checking location/i.test(event.summary) ? 'Confirming where first' : /location/i.test(event.summary) ? 'Waiting for a city' : names.length ? count : 'No matches'
    return { title: input?.city ? `Searched ${input.city}` : 'Searched restaurants', detail, tags, names }
  }
  if (event.tool === 'get_restaurant_details') return Array.isArray(result) ? { title: 'Recalled earlier picks', detail: result.map(item => item?.name).filter(Boolean).join(', '), tags: [], names: [] } : { title: 'Checked details', detail: result?.name || result?.restaurant?.name || event.summary, tags: [], names: [] }
  return { title: event.tool.replaceAll('_', ' '), detail: event.summary, tags: [], names: [] }
}
// The six most recent agent steps; rows with tags, names, or a previous value expand.
function formatLogData(data: unknown) { return typeof data === 'string' ? data : JSON.stringify(data, null, 2) }
// Raw per-turn trace, newest turn first; each line expands to its JSON payload.
function LogView({ logs }: { logs: TurnLog[] }) {
  const [open, setOpen] = useState<string | null>(null)
  return <div className="log-view">{logs.map(turn => <section className="log-turn" key={turn.id}><header><b>{new Date(turn.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</b><span className={`log-status ${turn.error ? 'error' : ''}`}>{turn.status} · {turn.ms}ms</span></header><p className="log-message">“{turn.message}”</p>{turn.error && <p className="log-line error"><span>ERROR</span>{turn.error}</p>}{turn.entries.map((entry, i) => { const key = `${turn.id}-${i}`, isOpen = open === key, hasData = entry.data !== undefined; return <div key={key}><button className={`log-line ${entry.level}`} disabled={!hasData} aria-expanded={hasData ? isOpen : undefined} onClick={() => setOpen(isOpen ? null : key)}><time>+{entry.t}ms</time><span>{entry.level.toUpperCase()}</span>{entry.message}</button>{isOpen && <pre>{formatLogData(entry.data)}</pre>}</div> })}</section>)}</div>
}
function ActivityPanel({ activity, logs, onClear = clearStoredLogs, onDownload = downloadStoredLogs }: { activity: Activity[], logs: TurnLog[], onClear?: () => void, onDownload?: () => void }) {
  const [open, setOpen] = useState<string | null>(null), [view, setView] = useState<'steps' | 'logs'>('steps')
  const actions = <div className="activity-actions"><button onClick={onDownload}><Download size={14}/> Download logs</button><button onClick={() => { setOpen(null); onClear() }}><Trash2 size={14}/> Clear logs</button></div>
  return <aside className="side-card activity-card"><div className="panel-heading"><h2>Agent activity</h2><span className="simulated">Live</span></div><div className="activity-tabs" role="tablist"><button role="tab" aria-selected={view === 'steps'} className={view === 'steps' ? 'active' : ''} onClick={() => setView('steps')}>Steps</button><button role="tab" aria-selected={view === 'logs'} className={view === 'logs' ? 'active' : ''} onClick={() => setView('logs')}>Logs</button></div>{view === 'logs' ? logs.length ? <><LogView logs={logs}/>{actions}</> : <p className="empty">Raw logs for each request will show up here.</p> : activity.length ? <><ol className="events">{activity.slice(0, 6).map(event => { const d = describe(event), expandable = d.tags.length > 0 || d.names.length > 0 || !!d.was, isOpen = open === event.id; const row = <><span className={`dot dot-${event.outcome === 'fallback' ? 'working' : event.status}`}/><span><b>{d.title}</b><em>{d.detail}</em></span>{expandable && <ChevronRight className={isOpen ? 'turned' : ''} size={15}/>}</>; return <li className="event" key={event.id}>{expandable ? <button className="event-row" aria-expanded={isOpen} onClick={() => setOpen(isOpen ? null : event.id)}>{row}</button> : <div className="event-row">{row}</div>}{isOpen && <div className="event-detail">{d.was && <p>Was <s>{d.was}</s></p>}{d.tags.length > 0 && <span className="event-tags">{d.tags.map(tag => <i key={tag}>{tag}</i>)}</span>}{d.names.length > 0 && <ul>{d.names.map(name => <li key={name}>{name}</li>)}</ul>}</div>}</li> })}</ol>{actions}</> : <p className="empty">Each step I take will show up here.</p>}</aside>
}
function RestaurantCard({ item }: { item: Recommendation }) { return <article className="restaurant"><div className="restaurant-top"><div><p className="eyebrow">RECOMMENDATION</p><h3>{item.name}</h3><span className="tags"><i>{item.cuisine}</i><i>{item.price}</i></span></div><span className="pin">✦</span></div><div className="meta"><p><b>Address</b>{item.address}</p><p><b>Listed hours</b>{item.hours}</p></div>{item.reasons?.length ? <ul className="reasons">{item.reasons.map(reason => <li key={reason}><Check size={13}/>{reason}</li>)}</ul> : <p className="why">{item.why}</p>}{item.dietNote && <p className="diet-note"><Leaf size={15}/> {item.dietNote}</p>}{item.caveat && <p className="caveat"><CircleAlert size={15}/> {item.caveat}</p>}</article> }
// The primary recommendation plus alternatives; swipe or use the arrows. A single card renders without the carousel.
function RecommendationCarousel({ items }: { items: Recommendation[] }) {
  const [index, setIndex] = useState(0), touchX = useRef<number | null>(null)
  if (items.length < 2) return <RestaurantCard item={items[0]}/>
  const go = (step: number) => setIndex(i => (i + step + items.length) % items.length)
  return <div className="carousel" onTouchStart={e => { touchX.current = e.touches[0].clientX }} onTouchEnd={e => { if (touchX.current === null) return; const dx = e.changedTouches[0].clientX - touchX.current; touchX.current = null; if (Math.abs(dx) > 40) go(dx < 0 ? 1 : -1) }}><div className="carousel-track" style={{ transform: `translateX(-${index * 100}%)` }}>{items.map((item, i) => <div className="carousel-slide" key={`${item.restaurantId}-${i}`} aria-hidden={i !== index}><RestaurantCard item={item}/></div>)}</div><div className="carousel-nav"><button onClick={() => go(-1)} aria-label="Previous recommendation"><ChevronLeft size={16}/></button><span className="carousel-dots">{items.map((item, i) => <button key={i} className={i === index ? 'active' : ''} onClick={() => setIndex(i)} aria-label={`Show ${item.name}`}/>)}</span><small>{index + 1} of {items.length}</small><button onClick={() => go(1)} aria-label="Next recommendation"><ChevronRight size={16}/></button></div></div>
}

export default function App() {
  const [restored] = useState<Stored | null>(() => restoreConversation())
  const [messages, setMessages] = useState<Message[]>(() => restored?.messages.length ? restored.messages : starter()), [context, setContext] = useState<Detail[]>(() => restored?.context || defaultContext), [activity, setActivity] = useState<Activity[]>(() => restored?.activity || [])
  const [draft, setDraft] = useState(''), [loading, setLoading] = useState(false), [error, setError] = useState<string | null>(null), [lastMessage, setLastMessage] = useState(''), [mobilePanel, setMobilePanel] = useState<'context'|'activity'>('context')
  const [locationPromptCount, setLocationPromptCount] = useState(() => restored?.locationPromptCount || 0)
  const [logs, setLogs] = useState<TurnLog[]>(() => restored?.logs || [])
  const [greeting, setGreeting] = useState(0), [typing, setTyping] = useState(true)
  const end = useRef<HTMLDivElement>(null)
  // Show a brief typing indicator before each new greeting.
  useEffect(() => { setTyping(true); const t = setTimeout(() => setTyping(false), 1300); return () => clearTimeout(t) }, [greeting])
  // Persist the whole conversation so a reload picks up where it left off.
  useEffect(() => { localStorage.setItem('nearby-concierge', JSON.stringify({ messages, context, activity, logs, locationPromptCount })) }, [messages, context, activity, logs, locationPromptCount])
  useEffect(() => { end.current?.scrollIntoView({ behavior: 'smooth' }) }, [messages, loading, error])
  // Bumped by "New outing", so a response still in flight from the old conversation is ignored when it lands.
  const conversation = useRef(0)
  // One user turn: POST to /api/chat, then fold the response back into state. A retry re-sends the failed
  // message, which is already on screen, so it is not appended again.
  async function send(value = draft, retry = false) {
    const text = value.trim()
    if (!text || loading) return
    setDraft(''); setError(null); setLastMessage(text)
    const turn = conversation.current
    // History is the conversation before this message (for a retry, without the failed message itself); the server trims it again.
    const history: HistoryItem[] = (retry ? messages.slice(0, -1) : messages).slice(-12).map(({ role, text, recommendation, alternatives }) => ({ role, text, recommendation, alternatives }))
    if (!retry) setMessages(m => [...m, { id: crypto.randomUUID(), role: 'user', text }])
    setLoading(true)
    const started = performance.now(), at = new Date().toISOString()
    const addLog = (turn: Omit<TurnLog, 'id' | 'at' | 'message' | 'ms'>) => setLogs(l => [{ id: crypto.randomUUID(), at, message: text, ms: Math.round(performance.now() - started), ...turn }, ...l].slice(0, MAX_TURN_LOGS))
    try {
      const lastCity = localStorage.getItem('nearby-last-city') || undefined
      const localTime = new Date().toLocaleString('en-US', { weekday: 'long', hour: 'numeric', minute: '2-digit' })
      const response: ConciergeResponse = await askConcierge(text, context, history, locationPromptCount, lastCity, localTime)
      addLog({ status: 200, entries: response.logs || [] })
      if (turn !== conversation.current) return
      setMessages(m => [...m, { id: crypto.randomUUID(), role: 'assistant', text: response.reply, recommendation: response.recommendation, alternatives: response.alternatives, noMatches: response.noMatches }])
      // The server returns the full updated context; it replaces ours.
      setContext(response.context)
      // Remember the confirmed city so the next outing can offer "Still eating in …?". "Anywhere" is not a city to offer back.
      const confirmedCity = response.context.find(detail => detail.key === 'city')?.value
      if (confirmedCity && !/^anywhere\b/i.test(confirmedCity)) localStorage.setItem('nearby-last-city', confirmedCity)
      // Newest first.
      setActivity(a => [...[...response.activity].reverse(), ...a])
      // Location prompt counter: reset once a city is known, count each unanswered ask, stop at 3.
      if (response.locationState === 'resolved') setLocationPromptCount(0)
      else if (response.locationState === 'asked') setLocationPromptCount(count => Math.min(count + 1, 3))
      else if (response.locationState === 'exhausted') setLocationPromptCount(3)
    } catch (e) {
      // No status means the request never got a response (offline, blocked, or the server is down).
      const status = (e as { status?: number })?.status
      addLog({ status: status ?? 'network', error: e instanceof Error ? e.message : String(e), entries: [] })
      if (turn !== conversation.current) return
      setError(e instanceof Error ? e.message : 'Something went wrong.')
    } finally {
      if (turn === conversation.current) setLoading(false)
    }
  }
  // "New outing": a fresh chat that keeps saved preferences but drops tonight's plans.
  function newConversation() { conversation.current++; setLoading(false); setMessages(starter()); setContext(c => c.filter(x => x.kind === 'saved')); setActivity([]); setLocationPromptCount(0); setError(null); setDraft(''); setGreeting(g => g + 1) }
  // Manual changes in the "What I know" panel are logged like the agent's own steps.
  function logManual(field: string, from: string, to: string) { setActivity(a => [{ id: crypto.randomUUID(), tool: 'manual_edit', status: 'complete', summary: `You changed ${field}`, change: { field, from, to } }, ...a]) }
  // A detail is identified by scope and key together: tonight's diet and the saved diet are separate entries.
  const same = (a: Detail, b: Detail) => a.kind === b.kind && a.key === b.key
  const scopeLabel = (detail: Detail) => `${detail.kind === 'saved' ? 'saved' : 'tonight’s'} ${detail.label.toLowerCase()}`
  function forgetSavedPreferences() { context.filter(detail => detail.kind === 'saved').forEach(detail => logManual(scopeLabel(detail), detail.value, 'removed')); setContext(c => c.filter(detail => detail.kind !== 'saved')) }
  function edit(detail: Detail) { const value = window.prompt(`Update ${detail.label}`, detail.value)?.trim(); if (value && value !== detail.value) { logManual(scopeLabel(detail), detail.value, value); setContext(c => c.map(d => same(d, detail) ? { ...d, value } : d)) } }
  function remove(detail: Detail) { logManual(scopeLabel(detail), detail.value, 'removed'); setContext(c => c.filter(d => !same(d, detail))) }
  return <main><header><a className="brand" href="#"><span>n</span> nearby</a><button className="new-chat" onClick={newConversation} title="Clear this meal plan and keep saved preferences"><MessageSquarePlus size={17}/> New outing</button></header><div className="layout"><section className="conversation"><div className="conversation-head"><div><p className="eyebrow">YOUR LOCAL DINING CONCIERGE</p><h1>Good food, <em>well matched.</em></h1></div><span className="status"><i/> Here to help</span></div><div className="messages">{typing && messages.length === 1 ? <div className="message assistant" key={`typing-${greeting}`}><div className="avatar">n</div><div className="bubble typing" aria-label="Typing"><i/><i/><i/></div></div> : messages.map(msg => <div className={`message ${msg.role}`} key={msg.id === 'hello' ? `hello-${greeting}` : msg.id}><div className="avatar">{msg.role === 'assistant' ? 'n' : 'You'}</div><div className="bubble"><p>{msg.text}</p>{msg.recommendation && <RecommendationCarousel items={[msg.recommendation, ...(msg.alternatives || [])]}/>}</div></div>)}{loading && <div className="message assistant"><div className="avatar">n</div><div className="bubble loading"><LoaderCircle size={17}/> Looking nearby…</div></div>}{error && <div className="error"><CircleAlert size={18}/><span>{error}</span><button onClick={() => send(lastMessage, true)}><RotateCcw size={15}/> Retry</button></div>}<div ref={end}/></div>{messages.length === 1 && !typing && <div className="examples" key={greeting}>{examples.map((x, i) => <button style={{ animationDelay: `${250 + i * 90}ms` }} onClick={() => send(x)} key={x}>{x}<ArrowUp size={14}/></button>)}</div>}<form className="composer" onSubmit={(e: FormEvent) => { e.preventDefault(); send() }}><textarea value={draft} onChange={e => setDraft(e.target.value)} onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send() } }} rows={1} placeholder="Tell me what sounds good…"/><button type="submit" disabled={!draft.trim() || loading} aria-label="Send message"><ArrowUp size={18}/></button><small>Enter to send <span>·</span> Shift + Enter for a new line</small></form></section><aside className="sidebar"><div className="mobile-tabs"><button className={mobilePanel === 'context' ? 'active' : ''} onClick={() => setMobilePanel('context')}>What I know</button><button className={mobilePanel === 'activity' ? 'active' : ''} onClick={() => setMobilePanel('activity')}>Activity</button></div><div className={mobilePanel === 'context' ? 'mobile-show' : 'mobile-hide'}><ContextPanel context={context} onDelete={remove} onEdit={edit} onForget={forgetSavedPreferences} onClearPlan={newConversation}/></div><div className={mobilePanel === 'activity' ? 'mobile-show' : 'mobile-hide'}><ActivityPanel activity={activity} logs={logs}/></div></aside></div></main>
}
