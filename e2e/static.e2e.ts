import { expect, test } from "@playwright/test";

// the entry bundle and the stylesheet are named after their content, so their
// urls come from the document the server just sent
const assetUrls = async (request: { get: (url: string) => Promise<{ text: () => Promise<string> }> }) => {
  const html = await (await request.get("/")).text();
  const urls = [...html.matchAll(/(?:src|href)="(\/assets\/[^"]+)"/g)].map((m) => m[1]);
  const find = (re: RegExp) => {
    const url = urls.find((u) => re.test(u));
    expect(url, `the document names no ${re}`).toBeTruthy();
    return url!;
  };
  return { entry: find(/\/assets\/client-.*\.js$/), style: find(/\/assets\/style-.*\.css$/) };
};

// decided 9/9: a route beats an extension-less file of the same name (the
// shadowing was an operator mistake wearing a feature's clothes), and the
// page path stopped paying a disk stat per request for it - while an
// extension-less file that collides with nothing is still served after the
// router comes up empty
test("a route outranks an extension-less file, which still serves where no route is", async ({ request }) => {
  const { mkdirSync, rmSync, writeFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  const pub = join(process.cwd(), "examples", "tasks", "public");
  writeFileSync(join(pub, "about"), "the impostor file");
  mkdirSync(join(pub, "downloads"), { recursive: true });
  writeFileSync(join(pub, "downloads", "notes"), "a real extension-less file");
  try {
    const page = await request.get("/about");
    expect(page.status()).toBe(200);
    expect(await page.text()).toContain("<h1>About</h1>");
    expect(await page.text()).not.toContain("impostor");

    const file = await request.get("/downloads/notes");
    expect(file.status()).toBe(200);
    expect(await file.text()).toBe("a real extension-less file");
  } finally {
    rmSync(join(pub, "about"), { force: true });
    rmSync(join(pub, "downloads"), { recursive: true, force: true });
  }
});

test("percent-encoded asset paths decode to the real file", async ({ request }) => {
  const { entry } = await assetUrls(request);
  const res = await request.get(entry.replace(/\.js$/, "%2Ejs"));
  expect(res.status()).toBe(200);
  expect(res.headers()["content-type"]).toContain("javascript");
});

test("encoded traversal attempts never escape public/", async ({ request }) => {
  const attempts = [
    "/assets/%2e%2e/%2e%2e/main.go",
    "/%2e%2e/go.mod",
    "/assets/..%5C..%5Cmain.go",
    "/assets/%2e%2e%5C%2e%2e%5Cgo.mod",
  ];
  for (const path of attempts) {
    const res = await request.get(path);
    expect(res.status(), path).toBe(404);
  }
});

test("head requests carry real status and headers, but no body", async ({ request }) => {
  const ok = await request.head("/");
  expect(ok.status()).toBe(200);
  expect(ok.headers()["content-type"]).toContain("text/html");
  expect((await ok.body()).length).toBe(0);

  const missing = await request.head("/definitely/not/here");
  expect(missing.status()).toBe(404);
});

test("the build emits a precache manifest listing live assets", async ({ request }) => {
  const res = await request.get("/assets/precache.json");
  expect(res.status()).toBe(200);
  const { stamp, assets } = await res.json();
  expect(String(stamp).length).toBeGreaterThan(0);
  const { entry, style } = await assetUrls(request);
  // the names the document actually references: a worker precaching anything
  // else fills its cache with files no page asks for and misses the ones it does
  expect(assets).toContain(entry);
  expect(assets).toContain(style);
  for (const asset of assets) {
    const hit = await request.get(asset);
    expect(hit.status(), asset).toBe(200);
  }
});
