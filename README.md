# Nearby Concierge

A conversational restaurant recommender. You tell it where you're eating and what you need (for example "me and my gf are vegan, somewhere in Santa Ana"), and it recommends one restaurant from a Supabase catalog, with up to two alternatives in a swipeable carousel. A side panel shows what it remembered and each step the agent took.

## Project layout

| Path | What it is |
|---|---|
| `web/` | React + Vite frontend (`web/src/App.tsx`, `web/src/mockConcierge.ts` for the API client and types) |
| `server/concierge.mjs` | The agent: prompts, tool loop, validation, and every server-side check. Runs only on the server. |
| `api/chat.js` | Vercel serverless function for `POST /api/chat` |
| `web/vite.config.ts` | Dev server; serves the same `POST /api/chat` locally |
| `docs/restaurant-agent-design.md` | Product and engineering design |

## Run locally

1. Create `.env` in the repo root (see `.env.example`):

   ```
   SUPABASE_URL=...
   SUPABASE_SERVICE_ROLE_KEY=...
   OPENROUTER_API_KEY=...
   OPENROUTER_MODEL=        # optional, defaults to openai/gpt-4.1-mini
   ```

2. Install and start:

   ```bash
   npm install
   npm run dev
   ```

The dev server reloads `server/concierge.mjs` whenever the file changes, so agent changes apply without a restart. Changes to `web/vite.config.ts` restart the dev server automatically.

Keys stay on the server. Never put the service-role key in a `VITE_`/`NEXT_PUBLIC_` variable or in frontend code.

## Deploy (Vercel)

`vercel.json` deploys `api/chat.js` with `server/**` bundled and a 60-second limit. Set the same environment variables in the Vercel project. `npm run build` type-checks `web/` and builds to `dist/`.

## How a turn works

Each `POST /api/chat` is one user turn:

1. **Capture context.** The first model call is forced to `update_context`, which records the user's plans in fixed fields (city, budget, time, companions, group size, occasion, atmosphere, diet, cuisine). Anything else is dropped.
2. **Search.** `search_restaurants` queries the catalog by city, price range, cuisine, and a keyword matched against each listing (used for diets and atmosphere). `get_restaurant_details` loads a restaurant already returned.
3. **Answer.** The model returns JSON naming one restaurant ID, two short reasons, one caveat, and up to two alternatives. The server checks this answer before anything is shown (see below) and builds the cards from catalog data, not from the model's text.

### What the server enforces

- **Grounding:** a card can only show a restaurant a tool returned in this turn, or one shown earlier in the conversation.
- **Location:**
  - A city counts only once the user says they're eating there, or confirms it ("Still eating in Irvine?"). "I live in X" alone isn't enough, and a remembered city is never assumed.
  - Location is never saved as a lasting preference.
  - "Anywhere" is recorded as an open location, so the agent stops asking.
- **Hard requirements:** a pick must meet them all. A failing pick gets one retry and is withheld if it still fails.
  - **City:** the confirmed city.
  - **Dietary needs:** read from the listing text, so "vegan options unclear" fails. Conditions such as "if you ask them to hold the ghee" pass, and are shown on the card.
  - **Opening hours for the planned meal:** for example, "dinner"/"tonight" means open from 6:30pm until at least 8:30pm. The meal comes from the message, tonight's plans, or the conversation; "now" uses the browser's local time.
- **Soft preferences:**
  - Budget only influences the pick.
  - A cuisine that comes only from saved preferences never becomes a search filter.
- **Decisions, not lists:** when candidates exist, the agent must pick one. A list-style or long reply gets one retry and is then trimmed. If only one restaurant qualifies, the reply says so.
- **New outings:** "I'm back", a different meal, or different companions clears tonight's plans, and the city is confirmed again.
- **Tool calls:** every call is validated before it runs (fields, types, price range 1–4, known IDs). Invalid calls are returned to the model with the problems listed.
- **Limits:**
  - At most 6 model calls and 8 tool calls per turn.
  - A 25-second turn deadline, 15 seconds per model call, and 5 seconds per database request.
  - Running out ends the turn with a friendly "try again" reply instead of an error.
- **Database outages:** if a search fails, results come from recently seen catalog records and are marked as fallback. If nothing is cached, the reply says the agent is having trouble rather than claiming nothing matches.

### Cards

Each card shows:
- the name, cuisine, and price (`$ · Under $15/person`, `$$ · $15–30/person`, `$$$ · $30–60/person`, `$$$$ · $60+/person`)
- the address and listed hours
- two reasons it fits
- a green diet line when a dietary need comes with a condition
- one caveat

Price bands are defined in `PRICE_BANDS` in `server/concierge.mjs`. Only the level-1 band was specified, so the others are conventional estimates.

## API contract

`POST /api/chat`

**Request:**

```json
{
  "message": "me and my gf are vegan, somewhere in santa ana",
  "context": [{ "key": "diet", "label": "Dietary needs", "value": "vegan", "kind": "saved" }],
  "history": [{ "role": "assistant", "text": "...", "recommendation": { "restaurantId": 21 }, "alternatives": [] }],
  "locationPromptCount": 0,
  "lastCity": "Irvine",
  "localTime": "Wednesday, 6:10 PM"
}
```

- `context`: what the agent remembers; `kind` is `saved` (lasting) or `tonight` (this outing).
- `history`: the last 12 turns.
- `lastCity`: offered only as a "still eating in…?" confirmation.
- `localTime`: the browser's local day and time.

**Response:**
- `reply`: the message text.
- `recommendation` and `alternatives`: the cards.
- `context`: the updated context.
- `activity`: one entry per step, shown in the Agent activity panel.
- `logs`: the raw trace for the Logs view.
- `noMatches`, `degraded` (fallback or unavailable search), and `locationState` (`asked` / `resolved` / `exhausted`).

Errors return status 502 with `{ "error": "..." }`.

## In the browser

- The conversation, context, activity, and logs are saved in `localStorage`. The last confirmed city is also kept, so the agent can offer it as a confirmation.
- **New conversation** or **Clear this meal plan** keeps saved preferences and clears tonight's plans.
- **Forget saved preferences** clears the lasting ones.
- The Agent activity panel can download or clear the logs.

## Known limitations

- Diet and hours checks read free-text listings. Unusual wording can be misread, and unparseable hours never count against a restaurant.
- Meal-type fit beyond hours is left to the model. For example, an ice-cream shop that is open at lunchtime can still appear as a lunch alternative.
- Search results are unranked and capped at 5 per search.
- The catalog has city names only (no coordinates), so the agent never claims a place is "nearby".
