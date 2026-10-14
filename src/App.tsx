import { FormEvent, useEffect, useRef, useState } from 'react'
import { ArrowUp, ChevronDown, ChevronLeft, ChevronRight, CircleAlert, LoaderCircle, MessageSquarePlus, Pencil, RotateCcw, Sparkles, X } from 'lucide-react'
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
const examples = ['Cheap dinner in Irvine', 'A quiet date spot', 'Dinner with a vegan friend']

function ContextPanel({ context, onDelete, onEdit, onForget }: { context: Detail[], onDelete: (key: string) => void, onEdit: (detail: Detail) => void, onForget: () => void }) {
  return <aside className="side-card context-card"><div className="panel-heading"><div><p className="eyebrow">YOUR PREFERENCES</p><h2>What I know</h2></div><Sparkles size={18} /></div><p className="muted">You’re always in control of what I remember.</p>{(['saved', 'tonight'] as const).map(kind => <section className="context-group" key={kind}><h3>{kind === 'saved' ? 'Saved preferences' : 'Tonight’s plans'}</h3>{context.filter(x => x.kind === kind).length ? context.filter(x => x.kind === kind).map(detail => <div className="detail" key={detail.key}><span><b>{detail.label}</b><em>{detail.value}</em></span><button onClick={() => onEdit(detail)} aria-label={`Edit ${detail.label}`}><Pencil size={14}/></button><button onClick={() => onDelete(detail.key)} aria-label={`Remove ${detail.label}`}><X size={15}/></button></div>) : <p className="empty">Nothing captured yet.</p>}</section>)}{context.some(detail => detail.kind === 'saved') && <button className="forget" onClick={onForget}>Forget saved preferences</button>}</aside>
}
function ActivityPanel({ activity }: { activity: Activity[] }) {
  const [open, setOpen] = useState<string | null>(null)
  return <aside className="side-card activity-card"><div className="panel-heading"><div><p className="eyebrow">BEHIND THE SCENES</p><h2>Agent activity</h2></div><span className="simulated">Live</span></div><p className="muted">A concise trace of how I got here.</p>{activity.length ? <div className="events">{activity.slice(0, 5).map(event => <div className="event" key={event.id}><button className="event-row" onClick={() => setOpen(open === event.id ? null : event.id)}><span className={`dot ${event.status}`}/><span><b>{event.tool.replaceAll('_', ' ')}</b><em>{event.summary}</em></span>{open === event.id ? <ChevronDown size={16}/> : <ChevronRight size={16}/>}</button>{open === event.id && <div className="event-detail">{event.input && <p><small>INPUT</small>{event.input}</p>}{event.result && <p><small>RESULT</small>{event.result}</p>}{event.change && <p><small>CONTEXT CHANGE</small>{event.change.field}: <s>{event.change.from}</s> → {event.change.to}</p>}</div>}</div>)}</div> : <p className="empty">Activity will appear as we chat.</p>}</aside>
}
function RestaurantCard({ item }: { item: Recommendation }) { return <article className="restaurant"><div className="restaurant-top"><div><p className="eyebrow">RECOMMENDATION</p><h3>{item.name}</h3><span className="tags"><i>{item.cuisine}</i><i>{item.price}</i></span></div><span className="pin">✦</span></div><div className="meta"><p><b>Address</b>{item.address}</p><p><b>Listed hours</b>{item.hours}</p></div><p className="why">{item.why}</p><p className="caveat"><CircleAlert size={15}/> {item.caveat}</p></article> }
function RecommendationCarousel({ items }: { items: Recommendation[] }) {
  const [index, setIndex] = useState(0), touchX = useRef<number | null>(null)
  if (items.length < 2) return <RestaurantCard item={items[0]}/>
  const go = (step: number) => setIndex(i => (i + step + items.length) % items.length)
  return <div className="carousel" onTouchStart={e => { touchX.current = e.touches[0].clientX }} onTouchEnd={e => { if (touchX.current === null) return; const dx = e.changedTouches[0].clientX - touchX.current; touchX.current = null; if (Math.abs(dx) > 40) go(dx < 0 ? 1 : -1) }}><div className="carousel-track" style={{ transform: `translateX(-${index * 100}%)` }}>{items.map((item, i) => <div className="carousel-slide" key={`${item.restaurantId}-${i}`} aria-hidden={i !== index}><RestaurantCard item={item}/></div>)}</div><div className="carousel-nav"><button onClick={() => go(-1)} aria-label="Previous recommendation"><ChevronLeft size={16}/></button><span className="carousel-dots">{items.map((item, i) => <button key={i} className={i === index ? 'active' : ''} onClick={() => setIndex(i)} aria-label={`Show ${item.name}`}/>)}</span><small>{index + 1} of {items.length}</small><button onClick={() => go(1)} aria-label="Next recommendation"><ChevronRight size={16}/></button></div></div>
}

export default function App() {
  const [messages, setMessages] = useState<Message[]>(() => localStorage.getItem('nearby-concierge') ? [] : starter()), [context, setContext] = useState<Detail[]>(defaultContext), [activity, setActivity] = useState<Activity[]>([])
  const [draft, setDraft] = useState(''), [loading, setLoading] = useState(false), [error, setError] = useState<string | null>(null), [lastMessage, setLastMessage] = useState(''), [mobilePanel, setMobilePanel] = useState<'context'|'activity'>('context')
  const [locationPromptCount, setLocationPromptCount] = useState(0)
  const [greeting, setGreeting] = useState(0), [typing, setTyping] = useState(true)
  const end = useRef<HTMLDivElement>(null)
  useEffect(() => { setTyping(true); const t = setTimeout(() => setTyping(false), 1300); return () => clearTimeout(t) }, [greeting])
  useEffect(() => { const raw = localStorage.getItem('nearby-concierge'); if (raw) { try { const state: Stored = JSON.parse(raw); setMessages(state.messages); setContext(state.context); setActivity(state.activity); setLocationPromptCount(state.locationPromptCount || 0) } catch { localStorage.removeItem('nearby-concierge'); setMessages(starter()) } } }, [])
  useEffect(() => { localStorage.setItem('nearby-concierge', JSON.stringify({ messages, context, activity, locationPromptCount })) }, [messages, context, activity, locationPromptCount])
  useEffect(() => end.current?.scrollIntoView({ behavior: 'smooth' }), [messages, loading, error])
  async function send(value = draft) { const text = value.trim(); if (!text || loading) return; setDraft(''); setError(null); setLastMessage(text); const history: HistoryItem[] = messages.slice(-12).map(({ role, text, recommendation }) => ({ role, text, recommendation })); setMessages(m => [...m, { id: crypto.randomUUID(), role: 'user', text }]); setLoading(true); try { const response: ConciergeResponse = await askConcierge(text, context, history, locationPromptCount); setMessages(m => [...m, { id: crypto.randomUUID(), role: 'assistant', text: response.reply, recommendation: response.recommendation, alternatives: response.alternatives, noMatches: response.noMatches }]); setContext(response.context); setActivity(a => [...response.activity, ...a]); if (response.locationState === 'resolved') setLocationPromptCount(0); else if (response.locationState === 'asked') setLocationPromptCount(count => Math.min(count + 1, 3)); else if (response.locationState === 'exhausted') setLocationPromptCount(3) } catch (e) { setError(e instanceof Error ? e.message : 'Something went wrong.') } finally { setLoading(false) } }
  function newConversation() { setMessages(starter()); setContext(c => c.filter(x => x.kind === 'saved')); setActivity([]); setLocationPromptCount(0); setError(null); setDraft(''); setGreeting(g => g + 1) }
  function forgetSavedPreferences() { setContext(c => c.filter(detail => detail.kind !== 'saved')) }
  function edit(detail: Detail) { const value = window.prompt(`Update ${detail.label}`, detail.value); if (value?.trim()) setContext(c => c.map(d => d.key === detail.key ? { ...d, value: value.trim() } : d)) }
  return <main><header><a className="brand" href="#"><span>n</span> nearby</a><button className="new-chat" onClick={newConversation}><MessageSquarePlus size={17}/> New conversation</button></header><div className="layout"><section className="conversation"><div className="conversation-head"><div><p className="eyebrow">YOUR LOCAL DINING CONCIERGE</p><h1>Good food, <em>well matched.</em></h1></div><span className="status"><i/> Here to help</span></div><div className="messages">{typing && messages.length === 1 ? <div className="message assistant" key={`typing-${greeting}`}><div className="avatar">n</div><div className="bubble typing" aria-label="Typing"><i/><i/><i/></div></div> : messages.map(msg => <div className={`message ${msg.role}`} key={msg.id === 'hello' ? `hello-${greeting}` : msg.id}><div className="avatar">{msg.role === 'assistant' ? 'n' : 'You'}</div><div className="bubble"><p>{msg.text}</p>{msg.recommendation && <RecommendationCarousel items={[msg.recommendation, ...(msg.alternatives || [])]}/>}</div></div>)}{loading && <div className="message assistant"><div className="avatar">n</div><div className="bubble loading"><LoaderCircle size={17}/> Looking nearby…</div></div>}{error && <div className="error"><CircleAlert size={18}/><span>{error}</span><button onClick={() => send(lastMessage)}><RotateCcw size={15}/> Retry</button></div>}<div ref={end}/></div>{messages.length === 1 && !typing && <div className="examples" key={greeting}>{examples.map((x, i) => <button style={{ animationDelay: `${250 + i * 90}ms` }} onClick={() => send(x)} key={x}>{x}<ArrowUp size={14}/></button>)}</div>}<form className="composer" onSubmit={(e: FormEvent) => { e.preventDefault(); send() }}><textarea value={draft} onChange={e => setDraft(e.target.value)} onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send() } }} rows={1} placeholder="Tell me what sounds good…"/><button type="submit" disabled={!draft.trim() || loading} aria-label="Send message"><ArrowUp size={18}/></button><small>Enter to send <span>·</span> Shift + Enter for a new line</small></form></section><aside className="sidebar"><div className="mobile-tabs"><button className={mobilePanel === 'context' ? 'active' : ''} onClick={() => setMobilePanel('context')}>What I know</button><button className={mobilePanel === 'activity' ? 'active' : ''} onClick={() => setMobilePanel('activity')}>Activity</button></div><div className={mobilePanel === 'context' ? 'mobile-show' : 'mobile-hide'}><ContextPanel context={context} onDelete={key => setContext(c => c.filter(d => d.key !== key))} onEdit={edit} onForget={forgetSavedPreferences}/></div><div className={mobilePanel === 'activity' ? 'mobile-show' : 'mobile-hide'}><ActivityPanel activity={activity}/></div></aside></div></main>
}
