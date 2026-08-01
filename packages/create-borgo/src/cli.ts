#!/usr/bin/env bun
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { randomBytes } from "node:crypto";
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

const LINTERS = [
  { name: "biome", hint: "one fast binary, one config, lint + format" },
  { name: "eslint", hint: "eslint + prettier, the familiar pair" },
  { name: "none", hint: "no linter or formatter (default)" },
] as const;
type LinterName = (typeof LINTERS)[number]["name"];

let name: string | undefined;
let template: string | undefined;
let tailwind: boolean | undefined;
let git: boolean | undefined;
let docker: boolean | undefined;
let vscode: boolean | undefined;
let linter: string | undefined;
let yes = false;

const args = process.argv.slice(2);
for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  if (arg === "--template" || arg === "-t") template = args[++i];
  else if (arg.startsWith("--template=")) template = arg.slice("--template=".length);
  else if (arg === "--linter") linter = args[++i];
  else if (arg.startsWith("--linter=")) linter = arg.slice("--linter=".length);
  else if (arg === "--no-linter") linter = "none";
  else if (arg === "--tailwind") tailwind = true;
  else if (arg === "--no-tailwind") tailwind = false;
  else if (arg === "--git") git = true;
  else if (arg === "--no-git") git = false;
  else if (arg === "--docker") docker = true;
  else if (arg === "--no-docker") docker = false;
  else if (arg === "--vscode") vscode = true;
  else if (arg === "--no-vscode") vscode = false;
  else if (arg === "--yes" || arg === "-y") yes = true;
  else if (arg === "--help" || arg === "-h") {
    console.log(`
  usage: bunx create-borgo@latest <name> [options]

  templates
${TEMPLATES.map((t) => `    ${t.name.padEnd(8)} ${t.hint}`).join("\n")}

  options
    -t, --template <name>   template to scaffold (default: base)
    --linter <name>         ${LINTERS.map((l) => l.name).join(" | ")} (default: none)
    --tailwind              wire tailwind v4: deps, style.css, the --tailwind
                            flag in every script (default: off)
    --git                   git init plus an initial commit (default: on)
    --docker                keep the Dockerfile and docker-compose.yml (default: on)
    --vscode                write .vscode/extensions.json and settings.json (default: on)
    -y, --yes               take every default, ask nothing
    -h, --help              this text

  every on/off option has a --no- twin: --no-tailwind, --no-git, --no-docker,
  --no-vscode, --no-linter.

  the linter choice wires "lint" and "format" scripts and writes its config:
  biome writes biome.json, eslint writes eslint.config.js and .prettierrc.

  without flags, an interactive terminal asks every question; anywhere else
  (CI, piped stdin) the defaults above are taken and nothing blocks.
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
const isLinter = (l: string): l is LinterName => LINTERS.some((k) => k.name === l);

// "eslint+prettier" is what the prompt calls it, so accept it as a flag value too
if (linter === "eslint+prettier" || linter === "prettier") linter = "eslint";

if (linter !== undefined && !isLinter(linter)) {
  console.error(`unknown linter "${linter}" - available: ${LINTERS.map((l) => l.name).join(", ")}`);
  process.exit(1);
}

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

// enter takes the default; anything else has to look like yes to mean yes
const askYesNo = async (label: string, fallback: boolean): Promise<boolean> => {
  const answer = await ask(`  ${label} ${dim(fallback ? "(Y/n)" : "(y/N)")} `);
  if (answer === "") return fallback;
  return answer === "y" || answer === "yes";
};

// --yes answers every question with its default without opening stdin at all
const shouldAsk = interactive && !yes;
const pending =
  template === undefined ||
  tailwind === undefined ||
  linter === undefined ||
  git === undefined ||
  docker === undefined ||
  vscode === undefined;

const banner = `  ${terracotta(home)} ${bold("create-borgo")} ${dim(`v${version}`)}`;
const asked = shouldAsk && pending;
if (asked) console.log(`\n${banner}\n`);

if (template === undefined) {
  if (shouldAsk) {
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
  tailwind = shouldAsk ? await askYesNo("tailwind", false) : false;
}

if (linter === undefined) {
  if (shouldAsk) {
    console.log("");
    for (const [i, l] of LINTERS.entries()) {
      console.log(`  ${bold(String(i + 1))}  ${terracotta(l.name.padEnd(8))} ${dim(l.hint)}`);
    }
    let prompt = `\n  linter ${dim(`(1-${LINTERS.length}, enter for none)`)} `;
    while (linter === undefined) {
      const answer = await ask(prompt);
      if (answer === "") linter = "none";
      else if (/^[0-9]+$/.test(answer)) linter = LINTERS[Number(answer) - 1]?.name;
      else if (answer === "eslint+prettier" || answer === "prettier") linter = "eslint";
      else if (isLinter(answer)) linter = answer;
      prompt = `  ${dim(`pick 1-${LINTERS.length}, or a name`)} `;
    }
    console.log("");
  } else {
    linter = "none";
  }
}
const chosenLinter: LinterName = isLinter(linter) ? linter : "none";

if (git === undefined) git = shouldAsk ? await askYesNo("git init", true) : true;
if (docker === undefined) docker = shouldAsk ? await askYesNo("docker files", true) : true;
if (vscode === undefined) vscode = shouldAsk ? await askYesNo("vscode settings", true) : true;

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
    writeFileSync(path, text.replaceAll("{{name}}", name).replaceAll("{{version}}", `^${version}`));
  }
};
stamp(target);

// package.json is edited by several steps below: read once, write once
const pkgPath = join(target, "package.json");
const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as {
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
};
const addDevDeps = (deps: Record<string, string>) => {
  pkg.devDependencies = { ...pkg.devDependencies, ...deps };
};
const write = (rel: string, content: string) => {
  const path = join(target, rel);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, content);
};
const json = (value: unknown) => JSON.stringify(value, null, 2) + "\n";

// A template with login needs a signing key before it can serve a single
// request, and the obvious shortcuts are both wrong: a literal in main.go is
// the same key in every app anyone scaffolds, and one derived from the project
// name is public - the title, the repo and the hostname all carry it, so
// anyone can compute the HMAC and mint a session as anybody. Generated here
// instead, once, from the CSPRNG, and written to .env, which the templates
// already gitignore. bun loads .env for `bun run`, and borgo hands its own
// environment to the go binary it spawns, so both halves see it.
if (template === "full") {
  write(
    ".env",
    "# generated by create-borgo, unique to this app, never commit it.\n" +
      "# regenerate with: openssl rand -base64 48 - every existing session becomes invalid.\n" +
      `SESSION_SECRET=${randomBytes(48).toString("base64url")}\n`,
  );
}

// tailwind: swap the stylesheet, wire the deps and pass the flag to every
// borgo command; without it the pregenerated tailwind.css just goes away.
// the postcss plugin rather than @tailwindcss/cli: the cli drags in
// @parcel/watcher, whose postinstall builds a native watcher from source that
// borgo never uses, and that shows up as `Blocked 1 postinstall` on install
if (tailwind) {
  rmSync(join(target, "style.scss"));
  renameSync(join(target, "tailwind.css"), join(target, "style.css"));
  for (const script of ["dev", "build", "start"]) {
    if (pkg.scripts?.[script]) pkg.scripts[script] += " --tailwind";
  }
  addDevDeps({
    tailwindcss: "^4.3.0",
    "@tailwindcss/postcss": "^4.3.0",
    postcss: "^8.5.0",
  });
} else {
  rmSync(join(target, "tailwind.css"));
}

if (!docker) {
  for (const f of ["Dockerfile", "docker-compose.yml", ".dockerignore"]) {
    rmSync(join(target, f), { force: true });
  }
}

// the template readme documents the tree it was written for: a deploy section
// about a Dockerfile that was just deleted, or a stylesheet that got renamed,
// is the scaffold contradicting itself on the first file a user opens
const readmePath = join(target, "README.md");
if (existsSync(readmePath)) {
  let readme = readFileSync(readmePath, "utf8");
  if (!docker) readme = readme.replace(/## Deploy\n[\s\S]*?\n(?=## )/, "");
  if (tailwind) readme = readme.replaceAll("style.scss", "style.css");
  writeFileSync(readmePath, readme);
}

// linter: the scripts are the same two names whichever tool is picked, so
// `bun run lint` is muscle memory regardless of the choice
if (chosenLinter === "biome") {
  addDevDeps({ "@biomejs/biome": "^2.5.0" });
  // `biome check` would also fail on formatting and import order, so a fresh
  // scaffold could not pass its own lint script: keep linting and formatting
  // to the two scripts that say so on the tin
  pkg.scripts = { ...pkg.scripts, lint: "biome lint .", format: "biome format --write ." };
  write(
    "biome.json",
    json({
      $schema: "https://biomejs.dev/schemas/2.5.6/schema.json",
      // since biome 2.2 a folder ignore carries no trailing /**
      files: { includes: ["**", "!**/public/assets", "!**/.borgo"] },
      formatter: { enabled: true, indentStyle: "space", indentWidth: 2, lineWidth: 100 },
      linter: { enabled: true },
      javascript: { formatter: { quoteStyle: "double" } },
      assist: { actions: { source: { organizeImports: "on" } } },
    }),
  );
} else if (chosenLinter === "eslint") {
  addDevDeps({
    eslint: "^10.0.0",
    "@eslint/js": "^10.0.0",
    "typescript-eslint": "^8.65.0",
    prettier: "^3.9.0",
    "eslint-config-prettier": "^10.1.0",
  });
  pkg.scripts = { ...pkg.scripts, lint: "eslint .", format: "prettier --write ." };
  write(
    "eslint.config.js",
    `import js from "@eslint/js";
import ts from "typescript-eslint";
import prettier from "eslint-config-prettier";

export default ts.config(
  { ignores: ["public/assets/**", ".borgo/**"] },
  js.configs.recommended,
  ...ts.configs.recommended,
  {
    files: ["**/*.ts", "**/*.tsx"],
    // typescript resolves globals and imports already
    rules: { "no-undef": "off" },
  },
  prettier,
);
`,
  );
  write(".prettierrc", json({ semi: true, singleQuote: false, printWidth: 100, tabWidth: 2 }));
}

// vscode: recommend exactly the extensions the chosen stack needs, and set
// the formatter those extensions provide - recommending biome while leaving
// prettier as the default formatter would fight on every save
if (vscode) {
  const recommendations = ["golang.go"];
  if (tailwind) recommendations.push("bradlc.vscode-tailwindcss");
  if (chosenLinter === "biome") recommendations.push("biomejs.biome");
  if (chosenLinter === "eslint") recommendations.push("dbaeumer.vscode-eslint", "esbenp.prettier-vscode");
  write(".vscode/extensions.json", json({ recommendations }));

  const settings: Record<string, unknown> = {
    "editor.formatOnSave": true,
    "[go]": { "editor.defaultFormatter": "golang.go" },
  };
  if (chosenLinter === "biome") {
    settings["editor.defaultFormatter"] = "biomejs.biome";
    settings["editor.codeActionsOnSave"] = { "source.organizeImports.biome": "explicit" };
  } else if (chosenLinter === "eslint") {
    settings["editor.defaultFormatter"] = "esbenp.prettier-vscode";
    settings["eslint.useFlatConfig"] = true;
  } else {
    // nothing formats ts/tsx here, so format-on-save would be a silent no-op
    settings["editor.formatOnSave"] = false;
    settings["[go]"] = { "editor.defaultFormatter": "golang.go", "editor.formatOnSave": true };
  }
  write(".vscode/settings.json", json(settings));
}

writeFileSync(pkgPath, json(pkg));

// git: initialised last, so the first commit contains the finished scaffold.
// every command is scoped with -C and the repo root is verified to be the
// scaffold itself before anything is staged - scaffolding into a directory
// inside another repo must never stage that repo's files
type GitResult = "created" | "nested" | "unavailable" | "no-identity";
let gitResult: GitResult = "unavailable";

const runGit = (...argv: string[]) =>
  Bun.spawnSync(["git", "-C", target, ...argv], { stdout: "pipe", stderr: "pipe" });

if (git) {
  const inRepo = Bun.spawnSync(["git", "-C", target, "rev-parse", "--is-inside-work-tree"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  if (inRepo.exitCode === 0 && inRepo.stdout.toString().trim() === "true") {
    // already tracked by an enclosing repo: that repo is the undo history
    gitResult = "nested";
  } else if (runGit("init", "-q").exitCode !== 0) {
    gitResult = "unavailable";
  } else {
    const root = runGit("rev-parse", "--show-toplevel");
    const sameRepo =
      root.exitCode === 0 &&
      root.stdout.toString().trim().replaceAll("\\", "/").toLowerCase() ===
        target.replaceAll("\\", "/").toLowerCase();
    if (!sameRepo) {
      gitResult = "unavailable";
    } else if (runGit("add", "-A").exitCode !== 0) {
      gitResult = "unavailable";
    } else if (runGit("commit", "-q", "-m", "initial commit").exitCode !== 0) {
      // usually no user.name/user.email: the repo and the staged tree are
      // still there, the user just has to identify themselves and commit
      gitResult = "no-identity";
    } else {
      gitResult = "created";
    }
  }
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

// the summary reports what is on disk, not what was asked for: a git init
// that could not run says so here rather than leaving the user to find out
const gitLine: Record<GitResult, string> = {
  created: `${sage(ok)} git         ${dim("repository initialised " + dot + " initial commit")}`,
  nested: `${dim(dot)} git         ${dim("skipped " + dot + " already inside a repository")}`,
  "no-identity": `${dim(dot)} git         ${dim("initialised, files staged " + dot + " set user.name/user.email, then commit")}`,
  unavailable: `${dim(dot)} git         ${dim("skipped " + dot + " git is not available here")}`,
};
const linterLine: Record<LinterName, string> = {
  biome: `${sage(ok)} linter      ${dim("biome " + dot + " biome.json " + dot + " bun run lint / format")}`,
  eslint: `${sage(ok)} linter      ${dim("eslint + prettier " + dot + " eslint.config.js " + dot + " bun run lint / format")}`,
  none: `${dim(dot)} linter      ${dim("none")}`,
};

const included = [
  git ? gitLine[gitResult] : `${dim(dot)} git         ${dim("skipped")}`,
  docker
    ? `${sage(ok)} docker      ${dim("Dockerfile " + dot + " docker-compose.yml " + dot + " .dockerignore")}`
    : `${dim(dot)} docker      ${dim("no docker files")}`,
  vscode
    ? `${sage(ok)} vscode      ${dim("extensions.json " + dot + " settings.json")}`
    : `${dim(dot)} vscode      ${dim("no editor config")}`,
  linterLine[chosenLinter],
]
  .map((l) => `    ${l}`)
  .join("\n");

// the banner is already on screen when the questions were asked: repeating it
// would push the answers the user just gave off the top of a short terminal
const stack = tailwind ? `${template} + tailwind` : template;
console.log(`${asked ? "" : `\n${banner}\n`}
  ${sage(ok)} created ${bold(name)}/ ${dim(`${dot} ${stack}`)}
${layouts[template]}

  included
${included}

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
