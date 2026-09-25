import { describeParentMismatch, parentGone, readParent } from "./parent-watch";
import { serve } from "./server";
import { INTERNAL_KEY_HEADER, decodeChanged, resolveSwitches } from "./util";

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
    // the same address serve() would have bound: in render mode that is the
    // loopback render port, and the public one belongs to the go front
    const port = switches.render ? switches.renderPort : Number(process.env.PORT || 3000);
    const hostname = switches.render ? "127.0.0.1" : undefined;
    // the original failure may have been the port itself
    try {
      Bun.serve({
        port,
        ...(hostname ? { hostname } : {}),
        fetch(req) {
          const url = new URL(req.url);
          // the css poke: nothing to compile here, and the header sends the
          // orchestrator to restart this process instead
          if (req.method === "POST" && url.pathname.startsWith("/__borgo/dev/")) {
            return new Response(null, { status: 204, headers: { "x-borgo-fallback": "1" } });
          }
          // every browser waits on the go front's channel: the poke below,
          // and the next boot that builds, tell it, and the overlay reloads
          return new Response(overlayHtml(error), {
            status: 500,
            headers: { "Content-Type": "text/html; charset=utf-8", "x-borgo-fallback": "1" },
          });
        },
      });
      // bound: the browsers are told there is a new page to show - the
      // overlay of this error, in place of the one before it, or of the page
      // that was there. The same poke serve() sends for a build that worked
      if (switches.render) {
        const api = process.env.API_URL || `http://127.0.0.1:${process.env.API_PORT || 3501}`;
        const files = decodeChanged(process.env.BORGO_CHANGED);
        fetch(`${api}/__borgo/dev/js`, {
          method: "POST",
          headers: { [INTERNAL_KEY_HEADER]: switches.internalKey, "Content-Type": "application/json" },
          body: JSON.stringify({ files: files.length ? files : ["(build)"], chunks: {}, stamp: Date.now() }),
          signal: AbortSignal.timeout(2_000),
        }).catch((pokeError) =>
          console.error(`  the go front was not told about this build: ${pokeError instanceof Error ? pokeError.message : pokeError}`),
        );
      }
    } catch (fallbackError) {
      if ((fallbackError as { code?: string }).code === "EADDRINUSE") {
        console.error(`port ${port} is in use - stop whatever holds it (borgo doctor names it) or set PORT`);
        process.exit(1);
      }
      throw fallbackError;
    }
  }
}
