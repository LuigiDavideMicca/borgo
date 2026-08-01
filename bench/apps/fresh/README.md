# fresh — not implemented

This directory is a placeholder with a manifest, not a working app. The runner
skips it and the report lists it under "not measured".

Deno was not available on the machine where this harness was built, so a Fresh
implementation could only have been written blind. A competitor implementation
nobody has run is worse than no competitor implementation: if it is slow because
we got it wrong, the table says Fresh is slow.

## To implement it

1. Install Deno.
2. Scaffold Fresh 2 into this directory.
3. Implement, exactly per [CONTRACT.md](../../CONTRACT.md):
   - `routes/api/hello.ts` → `{"message":"hello, world"}`
   - `routes/api/items.ts` → `{"items":[…],"count":n}`, `n` clamped to `[1,1000]`,
     generated per request; import `../../shared/items.js` rather than
     reimplementing the dataset
   - `routes/api/events.ts` → SSE with an **immediate** `: ping` flush, then held
     open until the client disconnects
   - `routes/page.tsx` → the contract's page: `data-bench-page="ssr"`, an `<h1>`,
     a five-link `<nav>`, twenty rows, one hydrated island. Server-rendered per
     request — not prerendered.
   - the shared payload copied to `static/static/payload.json`
4. Check by hand that all five routes answer as specified.
5. In `bench.manifest.json`, set `status` to `"implemented"`, fill `implements`,
   and delete `todo`.

Note that Fresh renders Preact and is islands-first, so its page scenario is not
a like-for-like React comparison. Say so in `notes` rather than letting the
table imply otherwise.
