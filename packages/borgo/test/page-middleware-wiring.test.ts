// Phase 2, step 4b: middleware.ts wired into the manifest, the page cache's
// policy table and serve()'s three doors.
import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateManifest, refuseApiMatchers } from "../src/build";
import { isrPolicyTable } from "../src/isr";
import { answerForDoor } from "../src/page-middleware";

describe("a page middleware.ts guards is never shared", () => {
  const routes = [
    { pattern: "/app/dashboard", module: { revalidate: 60 } },
    { pattern: "/news", module: { revalidate: 60, tags: ["posts"] } },
    { pattern: "/app/settings", module: {} },
  ];
  const guarded = (pattern: string) => pattern.startsWith("/app");

  test("a guarded page that exports revalidate is served fresh, and says why", () => {
    const lines: string[] = [];
    const table = isrPolicyTable(routes, (l) => lines.push(l), guarded);
    expect(table).toEqual([
      { pattern: "/app/dashboard", seconds: null, tags: [] },
      { pattern: "/news", seconds: 60, tags: ["posts"] },
      { pattern: "/app/settings", seconds: null, tags: [] },
    ]);
    // said once, for the page that asked to be shared; nothing for one that did not
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("/app/dashboard");
    expect(lines[0]).toContain("middleware.ts guards it");
  });

  test("without a guard the policy stands", () => {
    expect(isrPolicyTable(routes, () => {})[0]).toEqual({ pattern: "/app/dashboard", seconds: 60, tags: [] });
  });
});

describe("the build refuses a matcher the boot would refuse", () => {
  test("a literal entry naming /api fails the build", () => {
    expect(() => refuseApiMatchers(`export const matcher = ["/app/:path*", "/api/:path*"];`)).toThrow(/api\/middleware.go/);
    expect(() => refuseApiMatchers(`export const matcher: string[] = [\n  '/__borgo/x',\n];`)).toThrow(/__borgo/);
  });

  test("page matchers pass, and an entry built at runtime is left to the boot", () => {
    expect(() => refuseApiMatchers(`export const matcher = ["/app/:path*", "/w/:slug/:path*"];`)).not.toThrow();
    expect(() => refuseApiMatchers("export const matcher = [`/${base}/:path*`];")).not.toThrow();
    expect(() => refuseApiMatchers("export async function middleware() {}")).not.toThrow();
  });
});

describe("generateManifest imports middleware.ts into the server manifest only", () => {
  const withApp = async (files: Record<string, string>, fn: (dir: string) => Promise<void>) => {
    const dir = mkdtempSync(join(tmpdir(), "borgo-page-mw-"));
    const cwd = process.cwd();
    try {
      for (const [path, content] of Object.entries(files)) {
        mkdirSync(join(dir, path, ".."), { recursive: true });
        writeFileSync(join(dir, path), content);
      }
      process.chdir(dir);
      await fn(dir);
    } finally {
      process.chdir(cwd);
      rmSync(dir, { recursive: true, force: true });
    }
  };
  const page = { "pages/index.tsx": "export default function Home() { return null; }" };

  test("with a middleware.ts", async () => {
    await withApp({ ...page, "middleware.ts": `export const matcher = ["/app/:path*"];\nexport function middleware() {}` }, async (dir) => {
      await generateManifest();
      const manifest = readFileSync(join(dir, ".borgo/routes.gen.tsx"), "utf8");
      expect(manifest).toContain('import * as pageMiddlewareModule from "../middleware";');
      expect(manifest).toContain("export const pageMiddleware: unknown = pageMiddlewareModule;");
      // never in a browser bundle: no client entry names it
      for (const client of ["client-routes.gen.ts", "client.tsx"]) {
        const path = join(dir, ".borgo", client);
        if (existsSync(path)) expect(readFileSync(path, "utf8")).not.toContain("middleware");
      }
    });
  }, 30_000);

  test("without one", async () => {
    await withApp(page, async (dir) => {
      await generateManifest();
      expect(readFileSync(join(dir, ".borgo/routes.gen.tsx"), "utf8")).toContain("export const pageMiddleware: unknown = null;");
    });
  }, 30_000);

  test("with a matcher naming /api, the build stops", async () => {
    await withApp({ ...page, "middleware.ts": `export const matcher = ["/api/:path*"];\nexport function middleware() {}` }, async () => {
      await expect(generateManifest()).rejects.toThrow(/api\/middleware.go/);
    });
  }, 30_000);
});

describe("the answer takes the shape its door follows", () => {
  const sendJson = (_req: Request, value: unknown, init?: ResponseInit) => Response.json(value, init);
  const redirect = () => new Response(null, { status: 303, headers: { Location: "/login" } });

  test("a document takes the redirect as it is", async () => {
    const res = answerForDoor(new Request("http://app.example/app"), new URL("http://app.example/app"), redirect(), sendJson);
    expect(res.status).toBe(303);
  });

  test("the props endpoint gets { redirect }, which client navigation follows", async () => {
    const url = new URL("http://app.example/app?__borgo=props");
    const res = answerForDoor(new Request(url), url, redirect(), sendJson);
    expect(await res.json()).toEqual({ redirect: "/login" });
    expect(res.headers.get("Cache-Control")).toBe("private, no-store");
  });

  test("an enhanced action gets { redirect } marked as an action answer", async () => {
    const url = new URL("http://app.example/app");
    const req = new Request(url, { method: "POST", headers: { "x-borgo-action": "1" } });
    const res = answerForDoor(req, url, redirect(), sendJson);
    expect(await res.json()).toEqual({ redirect: "/login" });
    expect(res.headers.get("X-Borgo")).toBe("action");
  });

  test("a response that is not a redirect goes through untouched, at every door", async () => {
    const url = new URL("http://app.example/app?__borgo=props");
    const forbidden = new Response("no", { status: 403 });
    expect(answerForDoor(new Request(url), url, forbidden, sendJson)).toBe(forbidden);
  });
});

// serve() is not booted in this suite; the order inside handle() is the
// design, pinned in the source
describe("serve() puts the decision in front of every door", () => {
  const server = readFileSync(join(import.meta.dir, "../src/server.ts"), "utf8").replaceAll("\r\n", "\n");
  const handle = server.slice(server.indexOf("async function handle(req: Request, url: URL)"));

  test("the middleware decides before the action, the props and the document", () => {
    const decided = handle.indexOf("decidePage(pageMw, req, url");
    expect(decided).toBeGreaterThan(0);
    for (const door of ['if (req.method === "POST")', "if (wantsProps)", "SHARED_RENDER_HEADER", "return renderPage(req, matched.route"]) {
      expect(`${door} after the decision: ${handle.indexOf(door) > decided}`).toBe(`${door} after the decision: true`);
    }
  });

  test("the page is matched on the path the middleware decided, at both matches", () => {
    expect(handle).toContain("const target = matchRoute(pathname, routes);");
    expect(handle).toContain("const matched = matchRoute(pathname, routes);");
    expect(handle).not.toContain("matchRoute(url.pathname, routes)");
  });

  test("the headers next() added reach the response, and the boot refuses a bad middleware.ts", () => {
    expect(server).toContain("const added = middlewareHeaders.get(req);");
    expect(server).toContain("const pageMw = resolvePageMiddleware(pageMiddleware ?? null);");
    expect(server).toContain("(pattern) => pageMw?.guardsRoute(pattern) ?? false,");
  });
});
