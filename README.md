# Nearby Concierge

A conversational restaurant recommender. The current frontend is deliberately labeled **Mock** while the API and catalog are connected; it persists the mock conversation in the browser so the UI flow can be reviewed now.

## Run the frontend

```bash
npm install
npm run dev
```

## Supabase

This app uses the connected Supabase project managed in the Supabase Dashboard. Its schema and restaurant catalog are already configured there.

All database access belongs in trusted server routes or Edge Functions. Do not expose a Supabase service-role key in this Vite app. `.env.local` is ignored by Git; `.env.example` is the safe template.

## Delivery artifacts

- `restaurant-agent-design.md` — product and engineering design, agent prompt, and architecture diagram

## Live API contract

The UI is designed to replace its mock transport with `POST /api/chat`. The endpoint accepts a conversation ID, idempotency request ID, and message; it returns the reply, grounded recommendation, context, and ordered execution events. The backend is responsible for anonymous session authorization, tool execution, persistence, validation, and enforcing a six-tool-call limit per turn.
