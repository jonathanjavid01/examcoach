# ExamCoach backend — deploy in ~15 minutes (free tier)

The web page alone cannot grade with AI or collect emails: an API key must never
sit in a public page. This zero-dependency Node server does both jobs.

## What it does
- `POST /api/grade` — grades an essay with Google Gemini using the Operations
  Pack prompt (public band descriptors, structured JSON, evidence quotes),
  then runs a verification second pass and averages the two. Rate limits:
  2 grades/day per visitor without an email, 10/day with a captured email,
  and a hard daily cap (cost guard, default 200/day).
- `POST /api/subscribe` — stores captured emails in `data/leads.jsonl`.
- `GET /api/leads?token=<ADMIN_TOKEN>` — downloads leads as CSV.
- Serves the static site (`../index.html`) at the same origin, so the page's
  `/api/...` calls work with no CORS setup.

## 1. Get the API key (free)
Google AI Studio → "Get API key" → create key. The Gemini free tier is enough
to launch; the key goes only into the server's environment variables — never
into the web page, git, or chat.

## 2. Run it
```bash
cd server
GEMINI_API_KEY=your-key ADMIN_TOKEN=a-long-random-string node examcoach-server.mjs
# http://localhost:8787  (health: /api/health)
```

## 3. Deploy free (pick one)
- **Render / Railway free web service:** start command
  `node server/examcoach-server.mjs`, repo/root set so `../index.html` resolves,
  env vars `GEMINI_API_KEY`, `ADMIN_TOKEN`, optional `GEMINI_MODEL`,
  `DAILY_GRADE_CAP`. Note: free tiers may sleep and may not persist `data/`
  across restarts — for durable leads, move storage to Supabase (free Postgres)
  before running ads.
- **A small VPS** works the same way behind any reverse proxy with HTTPS.

## 4. If the page is hosted somewhere else (e.g. the Muse public link)
Set the two endpoints at the top of the page script to full URLs:
`EC_CONFIG = { gradeEndpoint: 'https://YOUR-BACKEND/api/grade', subscribeEndpoint: 'https://YOUR-BACKEND/api/subscribe' }`.
The server already sends open CORS headers. Without a reachable backend, the
page automatically falls back to the in-browser rule-based estimator and keeps
captured emails on the visitor's device — it always labels which grader ran.

## 5. Before charging anyone
Run the 100-essay calibration from the Operations Pack against this endpoint
(target: mean error ≤ 0.5 band), and keep the monthly 5% human review.
