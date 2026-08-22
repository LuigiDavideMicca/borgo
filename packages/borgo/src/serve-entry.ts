import { parentGone, readParent } from "./parent-watch";
import { serve } from "./server";
import { resolveSwitches } from "./util";

// EVERY SWITCH, ONCE, ABOVE THE TRY - not just BORGO_DEV.
//
// One reading is used by the boot and by the catch alike: a process that starts
// in one mode and then decides whether a build error kills it or is served as a
// page in the other is a defect of its own. And it happens HERE because the
// catch below deliberately BINDS A PORT: a value borgo refuses must fail the
// boot, not be re-thrown from inside the handler that exists to serve failures
// and answered from a listening socket with fewer security headers than a
// server that had accepted it. That held for BORGO_DEV alone while BORGO_CSP,
// BORGO_CSRF, BORGO_METRICS, BORGO_RELOAD, BORGO_SECURITY_HEADERS and
// SESSION_SECURE were all read inside serve(). resolveSwitches has the measured
// account.
const switches = resolveSwitches(process.env);
const dev = switches.dev;

// import.meta.main, so that this module can be imported without booting a
// server as a side effect of the import. dev.ts spawns this file as the entry
// point (bun <path>), where it is true.
if (import.meta.main) {
  // die with the watcher: a force-killed dev session delivers no signal, and an
  // orphaned front server would hold the port forever. That is measured on
  // posix; on windows it is defence in depth rather than the only defence, because
  // bun puts a spawned child in a job object that takes it down with the parent
  // - taskkill /F on a `borgo dev` shaped parent left no child behind here.
  const parentPid = Number(process.env.BORGO_PARENT_PID || 0);
  if (parentPid > 1) {
    // read once, at boot, while the parent is still there to be recognised
    const direct = process.ppid === parentPid;
    // probe before binding, as the go side does before mounting: dev.ts names
    // its own pid and then spawns, so a parent already gone here is never the
    // spawn racing the probe - it is a supervisor that died in between, and
    // the first tick would hand it 2 s of the port
    if (parentGone(parentPid, readParent(parentPid, direct))) process.exit(0);
    setInterval(() => {
      if (parentGone(parentPid, readParent(parentPid, direct))) process.exit(0);
    }, 2_000);
  }

  try {
    await serve({ dev, switches });
  } catch (error) {
    if (!dev) throw error;
    // a broken build must not take the port down: serve the error instead, keep
    // the dev channel alive, and the next successful rebuild reloads the browser
    console.error(error);
    const { overlayHtml } = await import("./overlay");
    const port = Number(process.env.PORT || 3000);
    const stamp = Date.now();
    const sockets = new Set<import("bun").ServerWebSocket<undefined>>();
    let server: import("bun").Server<undefined>;
    // the original failure may have been the port itself: the fallback would
    // then rethrow the same EADDRINUSE, unhandled and without a hint
    try {
      server = Bun.serve<undefined, never>({
        port,
        websocket: {
          open(ws) {
            sockets.add(ws);
            ws.send(JSON.stringify({ type: "js", file: process.env.BORGO_CHANGED ?? "(build)", chunks: {}, stamp }));
          },
          close(ws) {
            sockets.delete(ws);
          },
          message() {},
        },
        fetch(req) {
          const url = new URL(req.url);
          if (url.pathname === "/__borgo/dev" && server.upgrade(req)) return undefined as never;
          if (req.method === "POST" && url.pathname.startsWith("/__borgo/dev/")) {
            if (url.pathname.endsWith("/reload")) {
              const data = JSON.stringify({ type: "reload" });
              for (const ws of sockets) ws.send(data);
            }
            return new Response(null, { status: 204, headers: { "x-borgo-fallback": "1" } });
          }
          return new Response(overlayHtml(error), {
            status: 500,
            headers: { "Content-Type": "text/html; charset=utf-8", "x-borgo-fallback": "1" },
          });
        },
      });
    } catch (fallbackError) {
      if ((fallbackError as { code?: string }).code === "EADDRINUSE") {
        console.error(`port ${port} is in use - stop whatever holds it (borgo doctor names it) or set PORT`);
        process.exit(1);
      }
      throw fallbackError;
    }
  }
}
