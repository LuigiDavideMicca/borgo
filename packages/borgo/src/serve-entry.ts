import { describeParentMismatch, parentGone, readParent } from "./parent-watch";
import { serve } from "./server";
import { resolveSwitches } from "./util";

// every switch read once, above the try: a value borgo refuses must fail the
// boot, not be thrown inside the catch that binds a port to serve failures
const switches = resolveSwitches(process.env);
const dev = switches.dev;

if (import.meta.main) {
  // a force-killed dev session delivers no signal: on posix this watch is what
  // frees the port; on windows bun's job object already takes the child down
  const parentPid = Number(process.env.BORGO_PARENT_PID || 0);
  if (parentPid > 1) {
    const direct = process.ppid === parentPid;
    // probe before binding: a parent already gone would otherwise get 2 s of port
    if (parentGone(parentPid, readParent(parentPid, direct))) process.exit(0);
    const mismatch = describeParentMismatch(parentPid, process.ppid);
    if (mismatch) console.error(mismatch);
    setInterval(() => {
      if (parentGone(parentPid, readParent(parentPid, direct))) process.exit(0);
    }, 2_000);
  }

  try {
    await serve({ dev, switches });
  } catch (error) {
    if (!dev) throw error;
    // a broken build keeps the port: serve the error, the next rebuild reloads
    console.error(error);
    const { overlayHtml } = await import("./overlay");
    const port = Number(process.env.PORT || 3000);
    const stamp = Date.now();
    const sockets = new Set<import("bun").ServerWebSocket<undefined>>();
    let server: import("bun").Server<undefined>;
    // the original failure may have been the port itself
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
