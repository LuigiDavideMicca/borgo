#!/usr/bin/env bun
import {
  cpSync,
  existsSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const colors = !process.env.NO_COLOR && process.stdout.isTTY === true;
const wrap = (code: string) => (s: string) => (colors ? `\x1b[${code}m${s}\x1b[0m` : s);
const bold = wrap("1");
const dim = wrap("2");
const terracotta = wrap("38;5;173");
const sage = wrap("38;5;108");

// on windows, utf-8 marks survive only a real console in codepage 65001
const unicode = await (async () => {
  if (process.platform !== "win32") return true;
  if (process.stdout.isTTY !== true) return false;
  try {
    const { dlopen, FFIType } = await import("bun:ffi");
    const kernel32 = dlopen("kernel32.dll", {
      GetConsoleOutputCP: { args: [], returns: FFIType.u32 },
    });
    return kernel32.symbols.GetConsoleOutputCP() === 65001;
  } catch {
    return false;
  }
})();
const home = unicode ? "⌂" : "^";
const ok = unicode ? "✓" : "+";
const dot = unicode ? "·" : "-";

const version = JSON.parse(
  readFileSync(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8"),
).version as string;

const TEMPLATES = [
  { name: "base", hint: "the tour: loaders, actions, realtime, islands (default)" },
  { name: "minimal", hint: "bare bones: one page, one go route" },
  { name: "full", hint: "auth + crud: sessions, csrf, protected pages, typed ws" },
] as const;
type TemplateName = (typeof TEMPLATES)[number]["name"];

let name: string | undefined;
let template: string | undefined;
let tailwind: boolean | undefined;
const args = process.argv.slice(2);
for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  if (arg === "--template" || arg === "-t") template = args[++i];
  else if (arg.startsWith("--template=")) template = arg.slice("--template=".length);
  else if (arg === "--tailwind") tailwind = true;
  else if (arg === "--no-tailwind") tailwind = false;
  else if (arg === "--help" || arg === "-h") {
    console.log(`
  usage: bunx create-borgo@latest <name> [--template base|minimal|full] [--tailwind|--no-tailwind]

  templates
${TEMPLATES.map((t) => `    ${t.name.padEnd(8)} ${t.hint}`).join("\n")}

  --tailwind wires the scaffold for tailwind v4 (deps, style.css, the
  --tailwind flag in every script). without flags, an interactive terminal
  asks both questions; anywhere else (CI, piped stdin) the defaults are
  "base" and no tailwind.
`);
    process.exit(0);
  } else if (!arg.startsWith("-") && !name) name = arg;
  else {
    console.error(`unknown argument "${arg}" - see create-borgo --help`);
    process.exit(1);
  }
}

name ??= "borgo-app";

if (!/^[a-z0-9][a-z0-9._-]*$/.test(name)) {
  console.error(`invalid project name "${name}": use lowercase letters, digits, ".", "_" and "-"`);
  process.exit(1);
}

const isTemplate = (t: string): t is TemplateName => TEMPLATES.some((k) => k.name === t);
// BORGO_FORCE_PROMPT exists so the question path can be exercised without a
// pseudo-terminal: a pipe is never a tty, and the bug this guards against
// only appears once something is actually read from stdin
const interactive =
  process.env.BORGO_FORCE_PROMPT === "1" ||
  (process.stdin.isTTY === true && process.stdout.isTTY === true);

// one shared iterator, opened only if something is actually asked: a pending
// read keeps the event loop alive, so an unasked run must never open stdin
// and an asked one must let go of it before the summary prints
let stdinLines: AsyncIterator<string> | null = null;
const ask = async (prompt: string): Promise<string> => {
  stdinLines ??= console[Symbol.asyncIterator]();
  process.stdout.write(prompt);
  const { value } = await stdinLines.next();
  return String(value ?? "")
    .trim()
    .toLowerCase();
};
const doneAsking = async () => {
  await stdinLines?.return?.();
  stdinLines = null;
};

const banner = `  ${terracotta(home)} ${bold("create-borgo")} ${dim(`v${version}`)}`;
const asked = interactive && (template === undefined || tailwind === undefined);
if (asked) console.log(`\n${banner}\n`);

if (template === undefined) {
  if (interactive) {
    for (const [i, t] of TEMPLATES.entries()) {
      console.log(`  ${bold(String(i + 1))}  ${terracotta(t.name.padEnd(8))} ${dim(t.hint)}`);
    }
    let prompt = `\n  template ${dim(`(1-${TEMPLATES.length}, enter for base)`)} `;
    while (template === undefined) {
      const answer = await ask(prompt);
      if (answer === "") template = "base";
      else if (/^[0-9]+$/.test(answer)) template = TEMPLATES[Number(answer) - 1]?.name;
      else if (isTemplate(answer)) template = answer;
      prompt = `  ${dim(`pick 1-${TEMPLATES.length}, or a name`)} `;
    }
  } else {
    template = "base";
  }
}

if (!isTemplate(template)) {
  console.error(
    `unknown template "${template}" - available: ${TEMPLATES.map((t) => t.name).join(", ")}`,
  );
  process.exit(1);
}

if (tailwind === undefined) {
  if (interactive) {
    const answer = await ask(`  tailwind ${dim("(y/N)")} `);
    tailwind = answer === "y" || answer === "yes";
  } else {
    tailwind = false;
  }
}

// every question is answered: let go of the terminal, or the process sits
// there after printing its summary and the user has to interrupt it
await doneAsking();

const target = join(process.cwd(), name);
if (existsSync(target) && readdirSync(target).length > 0) {
  console.error(`directory "${name}" already exists and is not empty`);
  process.exit(1);
}

const source = fileURLToPath(new URL(`../templates/${template}`, import.meta.url));
cpSync(source, target, { recursive: true });

// npm strips dotfiles from published packages, so the templates ship them unprefixed
renameSync(join(target, "gitignore"), join(target, ".gitignore"));
renameSync(join(target, "dockerignore"), join(target, ".dockerignore"));
// pregenerated api types, so the api client is typed before the first `dev` run
renameSync(join(target, "_borgo"), join(target, ".borgo"));

// stamp {{name}} and {{version}} across the whole scaffold
const stamp = (dir: string) => {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      stamp(path);
      continue;
    }
    const text = readFileSync(path, "utf8");
    if (!text.includes("{{name}}") && !text.includes("{{version}}")) continue;
    writeFileSync(
      path,
      text.replaceAll("{{name}}", name).replaceAll("{{version}}", `^${version}`),
    );
  }
};
stamp(target);

// tailwind: swap the stylesheet, wire the deps and pass the flag to every
// borgo command; without it the pregenerated tailwind.css just goes away
if (tailwind) {
  rmSync(join(target, "style.scss"));
  renameSync(join(target, "tailwind.css"), join(target, "style.css"));
  const pkgPath = join(target, "package.json");
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as {
    scripts?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };
  for (const script of ["dev", "build", "start"]) {
    if (pkg.scripts?.[script]) pkg.scripts[script] += " --tailwind";
  }
  pkg.devDependencies = {
    ...pkg.devDependencies,
    tailwindcss: "^4.3.0",
    "@tailwindcss/cli": "^4.3.0",
  };
  writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n");
} else {
  rmSync(join(target, "tailwind.css"));
}

const style = tailwind ? "style.css " : "style.scss";
const layouts: Record<TemplateName, string> = {
  minimal: `    pages/      ${dim("react pages, file name = route")}
    api/        ${dim("go api routes, mounted via //borgo:route directives")}
    main.go     ${dim("go entrypoint: import api, borgo.Serve()")}
    index.html  ${dim("html shell")} ${dot} ${style} ${dim("global styles")}`,
  base: `    pages/      ${dim("react pages: loader, form action, hydrate=false, sse")}
    islands/    ${dim("components that hydrate alone inside zero-js pages")}
    api/        ${dim("go api routes, mounted via //borgo:route directives")}
    main.go     ${dim("go entrypoint: import api, borgo.Serve()")}
    index.html  ${dim("html shell")} ${dot} ${style} ${dim("global styles")}`,
  full: `    pages/      ${dim("notes crud, login/register, protected account, live ws")}
    api/        ${dim("go: notes + auth (in-memory stores, swap for a real db)")}
    main.go     ${dim("go entrypoint: import api, borgo.Serve()")}
    index.html  ${dim("html shell")} ${dot} ${style} ${dim("global styles")}`,
};

// the banner is already on screen when the questions were asked: repeating it
// would push the answers the user just gave off the top of a short terminal
const stack = tailwind ? `${template} + tailwind` : template;
console.log(`${asked ? "" : `\n${banner}\n`}
  ${sage(ok)} created ${bold(name)}/ ${dim(`${dot} ${stack}`)}
${layouts[template]}

  next steps
    cd ${name}
    bun install
    go mod tidy
    bun run dev

  then open ${bold("http://localhost:3000")}
${
  tailwind
    ? `\n  ${dim(`tailwind is wired: edit ${bold("style.css")} ${dot} the template's own styles are plain css, replace them freely`)}\n`
    : ""
}
  ${dim(`borgo is built by Luigi Micca ${dot}`)} ${terracotta("https://luigimicca.com")}
`);
