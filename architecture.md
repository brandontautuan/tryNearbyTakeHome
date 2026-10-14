# Restaurant Concierge Architecture

```mermaid
flowchart LR
  B[Browser] -->|anonymous HttpOnly session cookie| API[Trusted chat API]
  API -->|load and persist| DB[(Supabase Postgres)]
  API -->|bounded tool loop| LLM[LLM]
  LLM -->|update_context\nsearch_restaurants\nget_restaurant_details| API
  API -->|reply, context, events| B

  DB --- S[sessions]
  DB --- C[conversations]
  DB --- M[messages]
  DB --- R[restaurants]
  DB --- E[agent_events]
```

The browser never queries the database with a service credential. The trusted API validates the anonymous session, owns tool execution, and records the user-visible execution trace.
