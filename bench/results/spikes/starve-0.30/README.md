# A starved render service against two streams (0.30)

The measurement behind docs/realtime.md, "A starved render service no
longer cuts a stream". Copy `starve.go.txt` to `api/starve.go`, `heavy.tsx.txt` and `late.tsx.txt`
to `pages/` without the `.txt` (kept so the repo's own builds skip them),
in a scaffolded `base` app, `bun run build`, start
it with `PORT=3200 NODE_ENV=production BUN_CONFIG_MAX_HTTP_REQUESTS=16384
bun run start`, then run `bun starve.ts http://localhost:3200 <concurrency>`.

Run on 2026-10-07, Windows 11, i7-1165G7, default timeouts:

| concurrency | renders | each (ms, min-median-max) | go stream | page stream |
| --- | --- | --- | --- | --- |
| 24 | 168 | 6143-7205-7719 | event at +6.2 s | whole, +0.1 s |
| 24 | 168 | 1767-6489-7196 | event at +2.4 s | whole, +1.1 s |
| 24 | 144 | 6946-7543-7804 | event at +1.7 s | whole, +0.5 s |
| 24 | 144 | 6920-7423-8004 | event at +1.4 s | whole, +0.2 s |
| 24 | 144 | 6166-7415-8296 | event at +0.0 s | whole, +0.0 s |
| 48 | 144 | 15397-16190-16957 | event at +5.1 s | whole, +2.6 s |
| 48 | 144 | 14717-15387-15846 | event at +2.9 s | whole, +0.4 s |

"Whole" is the 1519-byte document an idle server sends, ending in
`</html>` with the late content in it; times are after the event
published at 45 s. The first three page results were judged by length:
the script's text check then had a bug, fixed since.
