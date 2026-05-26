# Session: Scrape job persistence and reconnect

## Goal
Persist batch scrape jobs in the database so they survive page reload (reconnect to running jobs, show results of recent completed jobs).

## Files Changed
- `apps/rom-manager-ui/server/db.js` — added `scrape_jobs` table to SCHEMA
- `apps/rom-manager-ui/server/index.js` — persist jobs on start/progress/done/cancel; added `GET /api/games/scrape-jobs` endpoint; fixed route ordering (moved before `:id` wildcard)
- `apps/rom-manager-ui/src/api.js` — added `getScrapeJobs()`
- `apps/rom-manager-ui/src/components/GameBrowser.jsx` — reconnect on mount via `getScrapeJobs()`, SSE resubscribe for running jobs; removed `batchResult` gate so Scrape button always shows

## Commands Run
- `opencode export` (timed out)
- `git add`, `git commit`
- Server restart, curl tests, API tests (14 passed), Playwright tests (7 passed)
