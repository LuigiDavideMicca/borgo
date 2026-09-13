const escapeHtml = (s: string) =>
  s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

export function overlayHtml(error: unknown): string {
  const err = error instanceof Error ? error : new Error(String(error));
  const stack = escapeHtml(err.stack ?? err.message);

  return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>error · borgo</title>
    <style>
      body { margin: 0; background: #221b16; color: #f5ead9; font-family: ui-monospace, monospace; }
      .wrap { max-width: 56rem; margin: 3rem auto; padding: 0 1.5rem; }
      .mark { color: #d9825f; font-weight: bold; letter-spacing: 0.05em; }
      h1 { font-size: 1.2rem; color: #e8a07e; margin: 1rem 0 0.5rem; }
      pre { background: #1a140f; border: 1px solid #3d2f24; border-radius: 8px; padding: 1rem; overflow-x: auto; line-height: 1.5; white-space: pre-wrap; }
      p { color: #b5a08f; }
    </style>
  </head>
  <body>
    <div class="wrap">
      <div class="mark">⌂ borgo</div>
      <h1>error while rendering</h1>
      <pre>${stack}</pre>
      <p>this overlay only appears in dev · fix the error and save, the page reloads on its own</p>
    </div>
    <script>
      (() => {
        const connect = () => {
          try {
            const proto = location.protocol === "https:" ? "wss://" : "ws://";
            const ws = new WebSocket(proto + location.host + "/__borgo/dev");
            ws.onmessage = (e) => {
              const m = JSON.parse(e.data);
              if (m.type === "reload" && (!m.stamp || m.stamp > performance.timeOrigin)) return location.reload();
              if (m.type === "js" && (!m.stamp || m.stamp > performance.timeOrigin)) location.reload();
            };
            ws.onclose = () => setTimeout(connect, 300);
          } catch {
            setTimeout(connect, 300);
          }
        };
        connect();
      })();
    </script>
  </body>
</html>`;
}
