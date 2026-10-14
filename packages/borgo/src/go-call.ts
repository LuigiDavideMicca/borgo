// The render service's side of //borgo:export: what the generated .borgo/go.ts
// calls. Self-contained on purpose - "borgo-framework/internal" is imported by
// the client entries too, so nothing here may pull a server module into a
// browser bundle; process.env and fetch are only touched when a call is made.

/**
 * An error a Go export returned, or a panic it contained. `message` is the
 * Go error's text; `status` is 200 for a returned error, 400 for a call that
 * did not fit the function (a stale build), 500 for a panic.
 */
export class GoError extends Error {
  constructor(
    public readonly exportName: string,
    message: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = "GoError";
  }
}

// through globalThis and not the bare global: this module is reachable from
// the browser program, where `process` has no type and no value
const env = (): Record<string, string | undefined> =>
  (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env ?? {};

const connRefused = (err: unknown) => {
  const e = err as { code?: string; message?: string };
  return e?.code === "ConnectionRefused" || e?.code === "ECONNREFUSED" || /unable to connect|refused/i.test(e?.message ?? "");
};

/** Not for application code: the generated .borgo/go.ts calls this. */
export async function callExport<T>(name: string, args: unknown[]): Promise<T> {
  const port = env().API_PORT;
  const key = env().BORGO_INTERNAL_KEY;
  if (!port || !key) {
    throw new Error(
      `go export ${name}: this process is not a borgo render service (API_PORT and BORGO_INTERNAL_KEY are unset). Exports are called from middleware.ts, loaders and actions, never from the browser`,
    );
  }
  const url = `http://127.0.0.1:${port}/__borgo/export/${name}`;
  const init = {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Borgo-Internal": key },
    body: JSON.stringify(args),
    // the key stays on loopback: a redirect is never followed with it
    redirect: "manual" as const,
  };
  // dev restarts go on every .go edit, so a refused connection is routine there
  const retries = env().BORGO_DEV === "1" ? 15 : 3;
  let res: Response;
  for (let attempt = 0; ; attempt++) {
    try {
      res = await fetch(url, init);
      break;
    } catch (err) {
      if (attempt >= retries || !connRefused(err)) throw err;
      await new Promise((r) => setTimeout(r, 250));
    }
  }
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    throw new Error(`go export ${name}: answered ${res.status} with a body that is not json`);
  }
  const answer = body as { result?: T; error?: unknown };
  if (answer && typeof answer.error === "string") throw new GoError(name, answer.error, res.status);
  if (!res.ok) throw new Error(`go export ${name}: answered ${res.status}`);
  // an absent result is Go's nil, which json writes as null
  return (answer?.result ?? null) as T;
}
