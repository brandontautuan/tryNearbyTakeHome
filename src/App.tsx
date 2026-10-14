import { FormEvent, useEffect, useRef, useState } from 'react'
import { ArrowUp, ChevronLeft, ChevronRight, CircleAlert, Download, LoaderCircle, MessageSquarePlus, Pencil, RotateCcw, Sparkles, Trash2, X } from 'lucide-react'
import { Activity, askConcierge, ConciergeResponse, defaultContext, Detail, HistoryItem, Recommendation } from './mockConcierge'

type Message = { id: string; role: 'user' | 'assistant'; text: string; recommendation?: Recommendation; alternatives?: Recommendation[]; noMatches?: boolean }
type Stored = { messages: Message[]; context: Detail[]; activity: Activity[]; locationPromptCount?: number }
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
function restoreConversation(): Stored | null {
  try {
    const raw = localStorage.getItem('nearby-concierge')
    if (!raw) return null
    const state: Stored = JSON.parse(raw)
    return {
      messages: Array.isArray(state.messages) ? state.messages : [],
      context: Array.isArray(state.context) ? state.context : [],
      activity: Array.isArray(state.activity) ? state.activity : [],
      locationPromptCount: state.locationPromptCount || 0,
    }
  } catch {
    localStorage.removeItem('nearby-concierge')
    return null
  }
}
function storedConversation() { return restoreConversation() || { messages: [], context: [], activity: [], locationPromptCount: 0 } }
function downloadStoredLogs() { const payload = { exported_at: new Date().toISOString(), ...storedConversation() }; const url = URL.createObjectURL(new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' })); const link = document.createElement('a'); link.href = url; link.download = `nearby-agent-log-${new Date().toISOString().slice(0, 10)}.json`; link.click(); URL.revokeObjectURL(url) }
function clearStoredLogs() { const state = storedConversation(); localStorage.setItem('nearby-concierge', JSON.stringify({ ...state, activity: [] })); window.location.reload() }
const examples = ['Cheap dinner in Irvine', 'A quiet date spot', 'Dinner with a vegan friend']

function ContextPanel({ context, onDelete, onEdit, onForget, onClearPlan }: { context: Detail[], onDelete: (key: string) => void, onEdit: (detail: Detail) => void, onForget: () => void, onClearPlan: () => void }) {
  return <aside className="side-card context-card"><div className="panel-heading"><div><p className="eyebrow">YOUR PREFERENCES</p><h2>What I know</h2></div><Sparkles size={18} /></div><p className="muted">You’re always in control of what I remember.</p>{(['saved', 'tonight'] as const).map(kind => <section className="context-group" key={kind}><h3>{kind === 'saved' ? 'Saved preferences' : 'Tonight’s plans'}</h3>{context.filter(x => x.kind === kind).length ? context.filter(x => x.kind === kind).map(detail => <div className="detail" key={detail.key}><span><b>{detail.label}</b><em>{detail.value}</em></span><button onClick={() => onEdit(detail)} aria-label={`Edit ${detail.label}`}><Pencil size={14}/></button><button onClick={() => onDelete(detail.key)} aria-label={`Remove ${detail.label}`}><X size={15}/></button></div>) : <p className="empty">Nothing captured yet.</p>}</section>)}{context.some(detail => detail.kind === 'tonight') && <button className="forget" onClick={onClearPlan} title="Starts a fresh conversation and keeps saved preferences">Clear this meal plan</button>}{context.some(detail => detail.kind === 'saved') && <button className="forget" onClick={onForget}>Forget saved preferences</button>}</aside>
}
function parseJson(text?: string) { try { return text ? JSON.parse(text) : undefined } catch { return undefined } }
function priceRange(min?: number, max?: number) { const lo = min ?? 1, hi = max ?? 4; if (lo === 1 && hi === 4) return undefined; return lo === hi ? '$'.repeat(lo) : `${'$'.repeat(lo)}–${'$'.repeat(hi)}` }
// Turns a raw tool event into a plain-language line plus optional details.
function describe(event: Activity): { title: string; detail: string; tags: string[]; names: string[]; was?: string } {
  const input = parseJson(event.input), result = parseJson(event.result)
  if (event.tool === 'update_context' && event.change) {
    const field = event.change.field.replaceAll('_', ' ').toLowerCase(), removed = event.change.to === 'removed'
    return { title: removed ? `Forgot ${field}` : `Noted ${field}`, detail: removed ? event.change.from : event.change.to, tags: [], names: [], was: !removed && event.change.from !== '—' ? event.change.from : undefined }
  }
  if (event.tool === 'search_restaurants') {
    const names: string[] = Array.isArray(result) ? result.map(item => item?.name).filter(Boolean) : []
    const excluded = Array.isArray(input?.exclude_restaurant_ids) ? input.exclude_restaurant_ids.length : 0
    const tags = [input?.cuisine, priceRange(input?.min_price_level, input?.max_price_level), input?.keyword && `“${input.keyword}”`, excluded && `skipping ${excluded} shown`].filter((tag, i, all) => tag && all.findIndex(other => String(other).replace(/[“”]/g, '').toLowerCase() === String(tag).replace(/[“”]/g, '').toLowerCase()) === i) as string[]
    const detail = event.status === 'error' ? 'Search unavailable' : /location/i.test(event.summary) ? 'Waiting for a city' : names.length ? `${names.length} ${names.length === 1 ? 'match' : 'matches'}` : 'No matches'
    return { title: input?.city ? `Searched ${input.city}` : 'Searched restaurants', detail, tags, names }
  }
  if (event.tool === 'get_restaurant_details') return Array.isArray(result) ? { title: 'Recalled earlier picks', detail: result.map(item => item?.name).filter(Boolean).join(', '), tags: [], names: [] } : { title: 'Checked details', detail: result?.name || event.summary, tags: [], names: [] }
  return { title: event.tool.replaceAll('_', ' '), detail: event.summary, tags: [], names: [] }
}
function ActivityPanel({ activity, onClear = clearStoredLogs, onDownload = downloadStoredLogs }: { activity: Activity[], onClear?: () => void, onDownload?: () => void }) {
  const [open, setOpen] = useState<string | null>(null)
  return <aside className="side-card activity-card"><div className="panel-heading"><h2>Agent activity</h2><span className="simulated">Live</span></div>{activity.length ? <><ol className="events">{activity.slice(0, 6).map(event => { const d = describe(event), expandable = d.tags.length > 0 || d.names.length > 0 || !!d.was, isOpen = open === event.id; const row = <><span className={`dot dot-${event.status}`}/><span><b>{d.title}</b><em>{d.detail}</em></span>{expandable && <ChevronRight className={isOpen ? 'turned' : ''} size={15}/>}</>; return <li className="event" key={event.id}>{expandable ? <button className="event-row" aria-expanded={isOpen} onClick={() => setOpen(isOpen ? null : event.id)}>{row}</button> : <div className="event-row">{row}</div>}{isOpen && <div className="event-detail">{d.was && <p>Was <s>{d.was}</s></p>}{d.tags.length > 0 && <span className="event-tags">{d.tags.map(tag => <i key={tag}>{tag}</i>)}</span>}{d.names.length > 0 && <ul>{d.names.map(name => <li key={name}>{name}</li>)}</ul>}</div>}</li> })}</ol><div className="activity-actions"><button onClick={onDownload}><Download size={14}/> Download logs</button><button onClick={() => { setOpen(null); onClear() }}><Trash2 size={14}/> Clear logs</button></div></> : <p className="empty">Each step I take will show up here.</p>}</aside>
}
function RestaurantCard({ item }: { item: Recommendation }) { return <article className="restaurant"><div className="restaurant-top"><div><p className="eyebrow">RECOMMENDATION</p><h3>{item.name}</h3><span className="tags"><i>{item.cuisine}</i><i>{item.price}</i></span></div><span className="pin">✦</span></div><div className="meta"><p><b>Address</b>{item.address}</p><p><b>Listed hours</b>{item.hours}</p></div><p className="why">{item.why}</p><p className="caveat"><CircleAlert size={15}/> {item.caveat}</p></article> }
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
  const [greeting, setGreeting] = useState(0), [typing, setTyping] = useState(true)
  const end = useRef<HTMLDivElement>(null)
  useEffect(() => { setTyping(true); const t = setTimeout(() => setTyping(false), 1300); return () => clearTimeout(t) }, [greeting])
  useEffect(() => { localStorage.setItem('nearby-concierge', JSON.stringify({ messages, context, activity, locationPromptCount })) }, [messages, context, activity, locationPromptCount])
  useEffect(() => end.current?.scrollIntoView({ behavior: 'smooth' }), [messages, loading, error])
  async function send(value = draft) { const text = value.trim(); if (!text || loading) return; setDraft(''); setError(null); setLastMessage(text); const history: HistoryItem[] = messages.slice(-12).map(({ role, text, recommendation, alternatives }) => ({ role, text, recommendation, alternatives })); setMessages(m => [...m, { id: crypto.randomUUID(), role: 'user', text }]); setLoading(true); try { const response: ConciergeResponse = await askConcierge(text, context, history, locationPromptCount, localStorage.getItem('nearby-last-city') || undefined); setMessages(m => [...m, { id: crypto.randomUUID(), role: 'assistant', text: response.reply, recommendation: response.recommendation, alternatives: response.alternatives, noMatches: response.noMatches }]); setContext(response.context); const confirmedCity = response.context.find(detail => detail.key === 'city')?.value; if (confirmedCity) localStorage.setItem('nearby-last-city', confirmedCity); setActivity(a => [...[...response.activity].reverse(), ...a]); if (response.locationState === 'resolved') setLocationPromptCount(0); else if (response.locationState === 'asked') setLocationPromptCount(count => Math.min(count + 1, 3)); else if (response.locationState === 'exhausted') setLocationPromptCount(3) } catch (e) { setError(e instanceof Error ? e.message : 'Something went wrong.') } finally { setLoading(false) } }
  function newConversation() { setMessages(starter()); setContext(c => c.filter(x => x.kind === 'saved')); setActivity([]); setLocationPromptCount(0); setError(null); setDraft(''); setGreeting(g => g + 1) }
  function forgetSavedPreferences() { setContext(c => c.filter(detail => detail.kind !== 'saved')) }
  function edit(detail: Detail) { const value = window.prompt(`Update ${detail.label}`, detail.value); if (value?.trim()) setContext(c => c.map(d => d.key === detail.key ? { ...d, value: value.trim() } : d)) }
  return <main><header><a className="brand" href="#"><span>n</span> nearby</a><button className="new-chat" onClick={newConversation} title="Clear this meal plan and keep saved preferences"><MessageSquarePlus size={17}/> New outing</button></header><div className="layout"><section className="conversation"><div className="conversation-head"><div><p className="eyebrow">YOUR LOCAL DINING CONCIERGE</p><h1>Good food, <em>well matched.</em></h1></div><span className="status"><i/> Here to help</span></div><div className="messages">{typing && messages.length === 1 ? <div className="message assistant" key={`typing-${greeting}`}><div className="avatar">n</div><div className="bubble typing" aria-label="Typing"><i/><i/><i/></div></div> : messages.map(msg => <div className={`message ${msg.role}`} key={msg.id === 'hello' ? `hello-${greeting}` : msg.id}><div className="avatar">{msg.role === 'assistant' ? 'n' : 'You'}</div><div className="bubble"><p>{msg.text}</p>{msg.recommendation && <RecommendationCarousel items={[msg.recommendation, ...(msg.alternatives || [])]}/>}</div></div>)}{loading && <div className="message assistant"><div className="avatar">n</div><div className="bubble loading"><LoaderCircle size={17}/> Looking nearby…</div></div>}{error && <div className="error"><CircleAlert size={18}/><span>{error}</span><button onClick={() => send(lastMessage)}><RotateCcw size={15}/> Retry</button></div>}<div ref={end}/></div>{messages.length === 1 && !typing && <div className="examples" key={greeting}>{examples.map((x, i) => <button style={{ animationDelay: `${250 + i * 90}ms` }} onClick={() => send(x)} key={x}>{x}<ArrowUp size={14}/></button>)}</div>}<form className="composer" onSubmit={(e: FormEvent) => { e.preventDefault(); send() }}><textarea value={draft} onChange={e => setDraft(e.target.value)} onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send() } }} rows={1} placeholder="Tell me what sounds good…"/><button type="submit" disabled={!draft.trim() || loading} aria-label="Send message"><ArrowUp size={18}/></button><small>Enter to send <span>·</span> Shift + Enter for a new line</small></form></section><aside className="sidebar"><div className="mobile-tabs"><button className={mobilePanel === 'context' ? 'active' : ''} onClick={() => setMobilePanel('context')}>What I know</button><button className={mobilePanel === 'activity' ? 'active' : ''} onClick={() => setMobilePanel('activity')}>Activity</button></div><div className={mobilePanel === 'context' ? 'mobile-show' : 'mobile-hide'}><ContextPanel context={context} onDelete={key => setContext(c => c.filter(d => d.key !== key))} onEdit={edit} onForget={forgetSavedPreferences} onClearPlan={newConversation}/></div><div className={mobilePanel === 'activity' ? 'mobile-show' : 'mobile-hide'}><ActivityPanel activity={activity}/></div></aside></div></main>
}
