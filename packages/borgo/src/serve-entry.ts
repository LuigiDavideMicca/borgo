import { serve } from "./server";

// die with the watcher: a force-killed dev session delivers no signal on
// windows, and an orphaned front server would hold the port forever
const parentPid = Number(process.env.BORGO_PARENT_PID || 0);
if (parentPid > 1) {
  setInterval(() => {
    try {
      process.kill(parentPid, 0);
    } catch {
      process.exit(0);
    }
  }, 2_000);
}

try {
  await serve({ dev: !!process.env.BORGO_DEV });
} catch (error) {
  if (!process.env.BORGO_DEV) throw error;
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
