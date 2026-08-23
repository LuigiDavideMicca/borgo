# Why borgo works this way

Six questions a skeptical engineer asks before adopting a framework, and six answers with the bill attached. The [README](../README.md#why-borgo) states the positions; this page argues them, and says what each one costs you. If you are evaluating borgo for a team, read this and [what this is not](../README.md#what-this-is-not) together — between them they describe the shape of the hole borgo will leave in your stack.

## Why Go for the backend

The API server is the process that runs forever. It is the thing on call at three in the morning, the thing whose memory graph you stare at, the thing you will still be running long after the front end has been rewritten twice. That process should be boring, and Go is the most boring good option available.

Concretely: a compiled static binary with no runtime to install and no dependency tree to audit at deploy time. A goroutine per request, so a handler that blocks on a database is just a function that blocks — no async coloring, no promise chains, no worrying about which call accidentally became synchronous. Resident memory in the tens of megabytes for a real app rather than the hundreds. `net/http` in the standard library is not a starting point you build a framework on top of; it is the production HTTP server, with the mux, the timeouts, the graceful shutdown and the `http.ResponseController` escape hatches already there. borgo's entire Go side is a route registry and bootstrap, a gzip middleware, a cache helper, sessions, auth, SSE and push — a few hundred lines each — plus a parent-process watchdog whose platform branches are the one part that is not small, because the standard library did the hard part everywhere else.

There is a second-order reason. When the long-lived process is Go, the interesting invariants of your system live in a language with a compiler that enforces them, and they stay there. Business logic does not creep into the rendering layer, because the rendering layer is on the other side of an HTTP boundary and moving logic across it is visible work.

**What it costs.** Two languages in one repository, permanently. You cannot share a validation function between the browser and the server — you write it twice, or you push it into Go and call it. You give up the entire npm backend ecosystem: no Prisma, no Zod on the server, no Drizzle; you get `database/sql`, or GORM if you want an ORM, and Go's smaller but sturdier set of libraries. Every developer on the team needs enough Go to add a route, and code review spans two idioms.

The subtler cost is that "server code" is now split across two runtimes. A page's `loader` runs in Bun; the handler it calls runs in Go. Which side does a piece of logic belong on? Usually Go, but the boundary is a judgment call you will make repeatedly, and getting it wrong shows up as a loader that has grown a business rule. Errors crossing that boundary lose their type: a Go error becomes an HTTP status and a body, and the loader gets an `ApiError` with a status and a string.

## Why Bun for the front server rather than Node

Because the thing borgo is trying not to be is a bundler configuration.

Bun collapses four tools into one. `Bun.build` is the bundler — borgo's entire asset pipeline is one call to it with one plugin. `Bun.Transpiler` is the transform that strips `loader` and `action` exports from pages so server code cannot reach the browser. `Bun.serve` is the HTTP server, with WebSockets and streaming bodies built in. And the runtime executes TypeScript directly, which is why `borgo-framework` ships its `src/` and nothing else: there is no build step for the framework itself, so the code you read on npm is the code that runs.

The same thing on Node needs esbuild or Rollup or Vite for bundling, a separate loader hook or a compile step for TypeScript, a server framework or a lot of `node:http`, and glue holding the three in agreement about module resolution. That glue is exactly the layer that makes meta-frameworks large and their upgrades painful. Skipping it is most of the reason borgo is small enough to read in a sitting.

**What it costs.** Bun is a hard requirement, not a preference. `Bun.serve`, `Bun.file`, `Bun.build`, `Bun.Transpiler`, `Bun.spawn` and `Bun.hash` appear throughout the source, unabstracted, because an abstraction over them would be a portability layer for a port nobody is doing. There is no Node fallback and there will not be one. A Bun bug in the HTTP server or the bundler is your bug until it is fixed upstream, and borgo already carries workarounds for a couple of them — the SSR stream is drained by async iteration rather than a manual reader pump because React's Bun build misbehaves under the latter.

You also inherit Bun's npm compatibility surface. It is very good now and was not two years ago; packages that reach into Node internals can still surprise you. If your organization's policy is "the runtime must be Node LTS", borgo is not adoptable, and that is a legitimate reason to walk away.

## Why code generation instead of runtime reflection or a spec

There are three ways to make a TypeScript client know the shape of a Go handler's response, and two of them have a failure mode borgo refuses to accept.

**Runtime reflection** answers the question at the wrong time. Go's reflection can describe a value you hand it, but it cannot tell you which routes exist, which types they answer with, or which body they bind — not without you annotating that separately, at which point the annotation is the source of truth and reflection is just an expensive way to read it. And whatever you learn at runtime is not available to `tsc`, so you would still need a generated artifact for the compiler. Reflection buys nothing here and costs work on every request.

**A specification** — OpenAPI, protobuf, a hand-written `.d.ts` — is a second source of truth. Someone has to keep it in agreement with the handlers. The failure is not that people are careless; it is that the drift is *silent*. Nothing breaks when the spec is stale. It breaks later, in production, in the one field nobody thought to re-check. Every team that has run an OpenAPI document alongside a service knows the ritual of not quite trusting it.

**Generation from source** removes the question. The Go source *is* the spec, `borgogen` reads it with `go/ast` and `go/types`, and the TypeScript declaration is a derived artifact that cannot disagree with the code it was derived from. Rename a field in a Go struct and `tsc` fails on the page that read it — not at runtime, not in review, in the type checker. Because the bridge is generated, it can never drift, and that is a property no amount of discipline buys you with a spec.

**What it costs.** Static analysis has a horizon, and borgo's is documented rather than hidden. A response written through an encoder stored in a variable, by a helper in a vendored package, or from a value whose static type is `any` comes out as `unknown` — visible at the point of use, not silently wrong. Custom marshalers need a `//borgo:type` directive to describe what they actually put on the wire. [The typed bridge](typed-bridge.md#honest-limits) lists every case.

You also take on a build step and a committed artifact. `.borgo/api-types.d.ts` and `api/borgo.gen.go` live in your repository so a fresh clone typechecks, which means they can conflict in a merge and must be regenerated in CI with a diff check. And a type error in a `.tsx` file can have its cause in a `.go` file, which is an unusual thing to explain to a new hire the first time.

## Why file-based routing

Because a route table is a mapping every developer has to be able to read, and the filesystem is already a named tree that everyone has a browser for.

The practical argument is about a class of bug rather than about typing less. With a central router, the route and the handler are two facts that must agree: delete the file and the router still references it; rename the handler and the route silently points somewhere else; add a page and forget the registration line. With file-based routing there is one fact. `pages/tasks/[id].tsx` *is* `/tasks/:id`. There is no registration to forget and nothing to keep in sync, and the URL in your browser tells you which file to open.

There is also a mechanical reason specific to borgo. Because routes are discoverable without executing the app, the build can enumerate them statically — which is what makes per-route code splitting, the client route manifest, hydration opt-outs read out of the source text, and static export possible at all. A router assembled at runtime would have to be run to be known.

The Go side deliberately went the other way: API routes are `//borgo:route GET /api/tasks` directives on handlers, not one file per route. Go's package model makes a file-per-route split arbitrary, and `net/http`'s method patterns are already a good route language. The property borgo wanted was locality — the pattern sitting next to the handler it mounts — and a directive gives that without pretending the filesystem is the router.

**What it costs.** Your URL space is your directory shape, so anything the filesystem cannot express, you cannot have: no two files serving one URL, no route path computed at build time, no route groups that organize files without appearing in the URL. Renaming a file is a URL change with no compiler error anywhere — it is the one refactor in borgo that types do not protect. `[id]` in a filename is legal but irritating on some tooling and in some shells. And route precedence is a convention you have to know rather than read: static segments win over dynamic ones, which the build enforces by sorting, but nothing in your `pages/` tree shows it.

Middleware is the sharpest edge. There is no per-route middleware layer; cross-cutting page concerns live in layouts and loaders, and cross-cutting API concerns live in Go handler wrappers like `borgo.Authed`. That is enough for auth guards and not enough for everything.

## Why typed APIs at all

The strongest argument against typing an API boundary is that the types are a lie. TypeScript does not check what arrives on the wire; it checks what you *claimed* would arrive. The server can send anything — and an older deployed version routinely does. A type is not a validator, and treating it as one is how you get a `TypeError` on a field that was `null` in production for the last six hours.

That argument is correct, and borgo's types do not answer it. `borgo.Bind` decodes a body; it does not validate it, and validation of anything crossing a trust boundary is still your job, in Go, on the values that decode actually produced.

What generated types buy is something else: they make refactoring possible. The failure they prevent is not "the server sent garbage", it is "I renamed a field and forgot the four pages that read it." That failure is silent, it is common, it survives review because the diff looks fine, and it is found by users. With a generated bridge it is found by `tsc` in under a second, exhaustively, including the page nobody remembered existed. The same applies to a route that was deleted, a body that gained a required field, and a WebSocket event whose payload changed shape.

The second thing they buy is that they are free. The usual bargain with API types is that you pay maintenance for safety, and teams reasonably decide the trade is not worth it on a small service. Here there is nothing to maintain — the types are a build output. Turning them down would mean deliberately deleting information the compiler already has.

**What it costs.** A version boundary the types cannot see: deploy a new front server against an old API and TypeScript is perfectly happy while the wire disagrees. If you deploy the two halves separately, that risk is real and yours to manage; deploying them as one unit, which is what `borgo build` and the scaffolded `Dockerfile` push you toward, mostly removes it.

There is also a comfort cost. The client's type machinery — conditional types that make `params` required exactly when the pattern has placeholders, and `body` required exactly when the handler binds one — is genuinely useful and produces genuinely bad error messages when you get a call wrong. And `unknown` is a real answer, not a placeholder: when the analysis cannot see a response type you will cast, and a cast is a promise the compiler stops checking.

## Why self-hosted only, no serverless targets

Not ideology — the design does not survive the translation.

Almost everything borgo does assumes a process that stays up. The SSE hub holds a set of subscriber channels in memory. The WebSocket topic relay is a subscription table in the front server. The asset index is one directory walk at boot. The route table is imported once and never reloaded. `borgo.Serve` supervises a graceful shutdown. On a function-per-request platform, every one of those is either a lie or a managed service you now depend on: the hub becomes Redis pub/sub, the topic relay becomes a hosted WebSocket gateway, the boot-time work becomes cold-start work paid per invocation. Supporting serverless would not be a target, it would be a second framework wearing the same name, with its own honest-limits page.

The second reason is the adapter problem. A meta-framework with six deployment targets has six test matrices, six sets of platform-specific caveats, and a documentation page where every paragraph has an exception. That is where the weight in large frameworks comes from, and it is the weight borgo is trying not to carry.

The third is that a single box you understand is an underrated deployment. Two processes and a reverse proxy is a system you can hold in your head, debug with `curl` and `journalctl`, and move to another provider in an afternoon. Nothing is proprietary; nothing has to be emulated locally. Fitting to the name: a *borgo* is a village — small enough that you know where everything is.

**What it costs.** Everything a platform was doing for you. No global edge and no multi-region story at all — your users in Sydney talk to your box in Frankfurt. No scale-to-zero: you pay for the box while it idles, which for a spiky, low-traffic side project is worse than a serverless bill. No per-PR preview deployments, no managed rollbacks, no built-in log aggregation. You own TLS, the reverse proxy, the process supervisor, backups and monitoring. borgo hands you `borgo deploy init` for the proxy and unit files, `/healthz` on both halves and opt-in Prometheus [metrics](deploy.md#health-and-metrics) — and stops there, on purpose.

If your traffic is bursty and idle-heavy, or you need presence in five regions, a platform is genuinely the better engineering choice and you should use one. If what you need is a fully static site, `borgo export` covers that case without a server at all; if what you wanted from ISR was cheap revalidation of shared pages, `borgo.Cache` in front of a proxy covers a useful part of it. Everything else is your box, and that is the trade borgo is making on purpose.

Next: [architecture](architecture.md) for how the pieces fit, or [performance](performance.md) for what these choices buy at request time.
