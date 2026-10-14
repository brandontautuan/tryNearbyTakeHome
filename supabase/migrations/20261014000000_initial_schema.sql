create extension if not exists pgcrypto;

create table public.sessions (
  id uuid primary key default gen_random_uuid(),
  token_hash text not null unique,
  preferences_json jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.conversations (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.sessions(id) on delete cascade,
  outing_context_json jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.messages (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  request_id uuid,
  role text not null check (role in ('user', 'assistant', 'system')),
  content text not null check (char_length(content) <= 12000),
  created_at timestamptz not null default now()
);

create unique index messages_one_user_request
  on public.messages (conversation_id, request_id)
  where role = 'user' and request_id is not null;

create table public.restaurants (
  id integer primary key,
  name text not null,
  address text not null,
  city text not null,
  cuisine_tags text[] not null default '{}',
  price_band integer not null check (price_band between 1 and 4),
  hours_text text not null,
  context_text text not null,
  attributes_json jsonb not null default '{}'::jsonb
);

create table public.agent_events (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  message_id uuid references public.messages(id) on delete set null,
  sequence integer not null check (sequence >= 0),
  type text not null,
  payload_json jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique (conversation_id, sequence)
);

create index conversations_session_id_idx on public.conversations (session_id);
create index messages_conversation_created_at_idx on public.messages (conversation_id, created_at);
create index agent_events_conversation_sequence_idx on public.agent_events (conversation_id, sequence);
create index restaurants_city_price_band_idx on public.restaurants (city, price_band);

alter table public.sessions enable row level security;
alter table public.conversations enable row level security;
alter table public.messages enable row level security;
alter table public.restaurants enable row level security;
alter table public.agent_events enable row level security;

-- This schema is backend-only: no browser policies are created. The service role
-- bypasses RLS and must only be used by trusted server routes or Edge Functions.
