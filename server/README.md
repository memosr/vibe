# Vibe Arena leaderboard server

Small Node server for the Vibe Arena weekly leaderboard.

- Players sign in with a free MetaMask signature (no gas).
- Each run is started and finished on the server; impossible scores and too-fast runs are rejected.
- Weekly board resets Monday 00:00 UTC. Only a player's best run of the week counts.

## Railway
- Root directory: `server`
- Variables: `DATABASE_URL` (from the Postgres service), `SECRET` (any long random text)
- Optional: `ORIGINS` (comma separated allowed sites, default `https://vibe-nine-woad.vercel.app`)

## Local
```
cd server && npm install && PORT=8790 node index.js
```
Without `DATABASE_URL` the data lives in memory.
