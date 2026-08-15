// verifies the docs mechanically: every internal link (markdown, html
// href/src, bare docs/*.md mention) points at a file that exists with the
// anchors it names, and every ts/tsx fenced block typechecks against the
// example app's tsconfig and generated types. blocks marked `no-check` in
// the fence info string are intentionally partial and skipped. no deps.
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const repoBlob = "https://github.com/LuigiDavideMicca/borgo/blob/main/";
const sources = [
  "README.md",
  "VISION.md",
  "CONTRIBUTING.md",
  // every docs/*.md is picked up here, new pages included: listing one
  // explicitly would check it twice and collide in the go scratch package,
  // where the package directory is named after the source's first index
  ...readdirSync("docs")
    .filter((f) => f.endsWith(".md"))
    .map((f) => `docs/${f}`),
  "packages/borgo/README.md",
  "packages/create-borgo/README.md",
  "packages/create-borgo/templates/base/README.md",
  "packages/create-borgo/templates/minimal/README.md",
  "packages/create-borgo/templates/full/README.md",
];

const slug = (heading: string) =>
  heading
    .toLowerCase()
    .replace(/[`*]/g, "")
    .replace(/[^\p{L}\p{N} -]/gu, "")
    .trim()
    .replace(/ /g, "-");

const anchorsOf = (file: string) => {
  const anchors = new Set<string>();
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = line.match(/^#{1,6}\s+(.*)$/);
    if (m) anchors.add(slug(m[1]));
  }
  return anchors;
};

let failures = 0;
const fail = (msg: string) => {
  failures++;
  console.error(`  x ${msg}`);
};

const stripFences = (text: string) => text.replace(/```[\s\S]*?```/g, "");

const checkTarget = (source: string, raw: string) => {
  let target = raw;
  if (target.startsWith(repoBlob)) target = resolve(target.slice(repoBlob.length));
  else if (/^[a-z]+:/i.test(target)) return;

  const [path, anchor] = target.split("#");
  const file = path === "" ? resolve(source) : path.startsWith("/") || /^[A-Za-z]:/.test(path) ? path : join(dirname(source), path);
  if (!existsSync(file)) {
    fail(`${source}: broken link ${raw}`);
    return;
  }
  if (anchor && file.endsWith(".md") && !anchorsOf(file).has(anchor)) {
    fail(`${source}: missing anchor #${anchor} in ${raw}`);
  }
};

for (const source of sources) {
  if (!existsSync(source)) {
    fail(`${source}: file listed for checking does not exist`);
    continue;
  }
  const raw = readFileSync(source, "utf8");
  // code spans and fenced blocks are not links: borgo.Bind[T](r) is code
  const text = stripFences(raw).replace(/`[^`\n]*`/g, "");
  for (const m of text.matchAll(/\[[^\]]*\]\(([^)\s]+)\)/g)) checkTarget(source, m[1]);
  // html rides in markdown too: <a href>, <img src>
  for (const m of text.matchAll(/<[a-z][^>]*\s(?:href|src)="([^"]+)"/g)) checkTarget(source, m[1]);
  // bare prose mentions like `docs/realtime.md` are root-relative promises
  for (const m of stripFences(raw).matchAll(/(?<![\w/.([])docs\/[\w.-]+\.md/g)) {
    if (!existsSync(m[0])) fail(`${source}: mentions ${m[0]}, which does not exist`);
  }
}

// ts/tsx snippets become one module each in a scratch dir inside the example
// app, so "borgo-framework" and "../.borgo/api-types" resolve exactly as they
// do from a real pages/ file, and one tsc pass checks them all
const appDir = "examples/tasks";
const scratch = join(appDir, ".doc-snippets");
const goScratch = join(appDir, "docsnippets");

// both are gitignored, and `gofmt -l .` does not read gitignore - nor do `go
// build ./...`, `go vet` or `go test`, which walk the example app's module and
// compile whatever is sitting in it. so a failed run used to hand the next
// person ten unformatted files they did not write and a red gofmt that stayed
// red until someone deleted the directory by hand. removing them only where
// the run succeeds is not enough for the same reason a `finally` exists: the
// path that leaves the mess is the path that fails. an empty snippet list
// leaked too - the mkdir below is unconditional, the old rmSync was not.
process.on("exit", () => {
  const dirs = [scratch, goScratch];
  if (process.env.BORGO_KEEP_DOC_SNIPPETS) {
    const kept = dirs.filter(existsSync);
    if (kept.length) console.error(`\nkept for inspection: ${kept.join(" ")}`);
    return;
  }
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

type Snippet = { file: string; source: string; fenceLine: number };
const snippets: Snippet[] = [];

rmSync(scratch, { recursive: true, force: true });
mkdirSync(scratch, { recursive: true });

for (const source of sources) {
  if (!existsSync(source)) continue;
  const lines = readFileSync(source, "utf8").split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const fence = lines[i].match(/^```(ts|tsx|typescript)\b(.*)$/);
    if (!fence) continue;
    const start = i;
    const body: string[] = [];
    while (++i < lines.length && !/^```\s*$/.test(lines[i])) body.push(lines[i]);
    if (fence[2].includes("no-check")) continue;
    const ext = fence[1] === "tsx" ? "tsx" : "ts";
    const file = `snippet-${snippets.length}.${ext}`;
    // a block without imports or exports must still be a module, not a
    // global script: snippets cannot collide, augmentations must augment
    const isModule = body.some((l) => /^(import|export)[\s{]/.test(l));
    writeFileSync(join(scratch, file), body.join("\n") + (isModule ? "\n" : "\nexport {};\n"));
    snippets.push({ file, source, fenceLine: start + 1 });
  }
}

if (snippets.length) {
  writeFileSync(
    join(scratch, "tsconfig.json"),
    JSON.stringify(
      { extends: "../tsconfig.json", include: ["./**/*", "../.borgo/api-types.d.ts", "../ws-events.d.ts"] },
      null,
      2,
    ),
  );
  const tsc = Bun.spawnSync(["bunx", "tsc", "--noEmit", "-p", ".doc-snippets"], {
    cwd: appDir,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (tsc.exitCode !== 0) {
    const out = tsc.stdout.toString() + tsc.stderr.toString();
    const before = failures;
    for (const line of out.split(/\r?\n/)) {
      // .doc-snippets/snippet-3.tsx(12,5): error ... -> doc file and line
      const m = line.match(/snippet-(\d+)\.tsx?\((\d+),(\d+)\)(.*)$/);
      if (!m) continue;
      const s = snippets[Number(m[1])];
      fail(`${s.source}:${s.fenceLine + Number(m[2])}${m[4]}`);
    }
    if (failures === before) fail(`snippet typecheck failed:\n${out}`);
  }
}

// go snippets get the same treatment: each becomes one file in a scratch
// package inside the example app's module, so "github.com/LuigiDavideMicca/borgo"
// resolves as it does from a real api/ file, and one `go build` checks them
// all. a block that is a fragment (no package-level declaration to hang the
// imports off) marks itself no-check, like its typescript siblings
const goSnippets: Snippet[] = [];
rmSync(goScratch, { recursive: true, force: true });
mkdirSync(goScratch, { recursive: true });

// go imports are file-scoped, so every snippet file carries the block; the
// blank bindings keep an unused import from failing the build and can be
// repeated across files because the blank identifier never collides
const GO_IMPORTS = `import (
	"context"
	"errors"
	"net/http"
	"sync"
	"time"

	"github.com/LuigiDavideMicca/borgo"
)

var (
	_ = context.Background
	_ = errors.New
	_ = http.StatusOK
	_ = sync.Mutex{}
	_ = time.Now
	_ = borgo.Serve
)
`;

// the domain the docs write about. a page gets only the ones it does not
// declare itself, so an example is free to define its own Task
const GO_DOMAIN: Record<string, string> = {
  Task: "type Task struct {\n\tID    int    `json:\"id\"`\n\tTitle string `json:\"title\"`\n\tBody  string `json:\"body\"`\n}",
  TaskList: "type TaskList struct {\n\tTasks []Task `json:\"tasks\"`\n}",
  TaskCreate: "type TaskCreate struct {\n\tTitle string `json:\"title\"`\n\tBody  string `json:\"body\"`\n}",
  User: "type User struct {\n\tUsername string `json:\"username\"`\n\tHash     string `json:\"-\"`\n}",
  Me: "type Me struct {\n\tUsername string `json:\"username\"`\n}",
  TaskItem: "type TaskItem struct {\n\tTask Task `json:\"task\"`\n}",
};

// the app-side pieces docs legitimately elide - a store, a handler, the data
// itself. stubbed so an example that names one still compiles
const GO_STUBS = `var tasks []Task

var db = struct {
	Order func(string) *struct{ Find func(any) *struct{ Error error } }
}{}

func lookupUser(ctx context.Context, username string) (User, string, error) { return User{}, "", nil }

func createUser(ctx context.Context, username, hash string) (User, error) { return User{}, nil }

func currentUser(w http.ResponseWriter, r *http.Request) {}
`;

for (const source of sources) {
  if (!existsSync(source)) continue;
  const lines = readFileSync(source, "utf8").split(/\r?\n/);
  const blocks: Array<{ text: string; fenceLine: number }> = [];
  for (let i = 0; i < lines.length; i++) {
    const fence = lines[i].match(/^```go\b(.*)$/);
    if (!fence) continue;
    const start = i;
    const body: string[] = [];
    while (++i < lines.length && !/^```\s*$/.test(lines[i])) body.push(lines[i]);
    if (fence[1].includes("no-check")) continue;
    const text = body.join("\n");
    // only whole declarations compile on their own; a bare statement or an
    // expression is a fragment the reader will paste into a function
    if (!/^\s*(func|type|var|const)\b/m.test(text)) continue;
    blocks.push({ text, fenceLine: start + 1 });
  }
  if (!blocks.length) continue;

  // one package per page, one file per block: a page's blocks are written to
  // be read in order, so a type declared in an earlier one is in scope for
  // the later ones - exactly as it is for the reader
  const pkg = `p${sources.indexOf(source)}`;
  const dir = join(goScratch, pkg);
  mkdirSync(dir, { recursive: true });
  const declared = new Set<string>();
  for (const b of blocks) for (const m of b.text.matchAll(/^type (\w+)/gm)) declared.add(m[1]);
  for (const b of blocks) for (const m of b.text.matchAll(/^(?:func|var) (\w+)/gm)) declared.add(m[1]);
  const domain = Object.entries(GO_DOMAIN)
    .filter(([name]) => !declared.has(name))
    .map(([, decl]) => decl)
    .join("\n\n");
  const stubs = GO_STUBS.split("\n\n")
    .filter((decl) => {
      const name = decl.match(/^(?:func|var) (\w+)/)?.[1];
      return name && !declared.has(name);
    })
    .join("\n\n");
  writeFileSync(join(dir, "domain.go"), `package ${pkg}\n\n${GO_IMPORTS}\n${domain}\n\n${stubs}\n`);
  for (const b of blocks) {
    const n = goSnippets.length;
    writeFileSync(join(dir, `s${n}.go`), `package ${pkg}\n\n${GO_IMPORTS}\n${b.text}\n`);
    goSnippets.push({ file: `${pkg}/s${n}`, source, fenceLine: b.fenceLine });
  }
}

if (goSnippets.length) {
  const build = Bun.spawnSync(["go", "build", "./docsnippets/..."], {
    cwd: appDir,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (build.exitCode !== 0) {
    const out = build.stdout.toString() + build.stderr.toString();
    const before = failures;
    for (const line of out.split(/\r?\n/)) {
      // ./docsnippets/p7/s12.go:34:2: error -> doc file and line. the file
      // name is what the loop above writes, s<n>.go: matching anything else
      // silently drops every go failure into the raw dump below
      const m = line.match(/[\\/]s(\d+)\.go:(\d+):(\d+):(.*)$/);
      if (!m) continue;
      const s = goSnippets[Number(m[1])];
      // the generated file prepends a package clause and the import block
      const offset = GO_IMPORTS.split("\n").length + 2;
      fail(`${s.source}:${s.fenceLine + Number(m[2]) - offset}:${m[4]}`);
    }
    if (failures === before) fail(`go snippet build failed:\n${out}`);
  }
}

if (failures) {
  console.error(`\n${failures} doc problem(s)`);
  process.exit(1);
}
console.log(
  `docs ok (${sources.length} files, ${snippets.length} ts + ${goSnippets.length} go snippets compiled)`,
);
