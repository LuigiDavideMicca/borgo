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
const arrow = unicode ? "›" : ">";
const err = unicode ? "✗" : "x";

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
let install: boolean | undefined;
let start: boolean | undefined;
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
  else if (arg === "--install") install = true;
  else if (arg === "--no-install") install = false;
  // --start is the whole point of the flag, so it carries its own install
  // rather than failing on a node_modules that was never fetched
  else if (arg === "--start") (start = true), (install ??= true);
  else if (arg === "--no-start") start = false;
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
    --install               run bun install and go mod tidy after scaffolding
    --start                 install, then hand over to the dev server
    -y, --yes               take every default, ask nothing
    -h, --help              this text

  every on/off option has a --no- twin: --no-tailwind, --no-git, --no-docker,
  --no-vscode, --no-linter, --no-install, --no-start.

  the linter choice wires "lint" and "format" scripts and writes its config:
  biome writes biome.json, eslint writes eslint.config.js and .prettierrc.

  without flags, an interactive terminal asks every question; anywhere else
  (CI, piped stdin) the defaults above are taken and nothing blocks.

  install and start default to ON in a terminal and OFF everywhere else, so
  a scaffold in CI or a pipeline still exits on its own. --start in a script
  is honoured: it is a request to block on a server, and it will. -y in a
  terminal takes the terminal's defaults, so it installs and starts too.
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
  vscode === undefined ||
  install === undefined ||
  start === undefined;

const banner =
  `  ${terracotta(home)} ${bold("create-borgo")} ${dim(`v${version}`)}\n` +
  `    ${dim("the self-hosted react framework " + dot + " react + go + bun")}`;
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

// installing and starting are one question, because "yes, set it up" is one
// intent - but two flags, because a script that wants the dependencies
// without a server that never exits has no other way to say so.
// The default is off without a terminal: a scaffold step in CI that ends with
// a dev server would hang the pipeline rather than finish it.
if (install === undefined || start === undefined) {
  // the default keys off a real terminal, not off `interactive`, which
  // BORGO_FORCE_PROMPT also turns on: a test driving the prompts over a pipe
  // must not inherit "there is a human here, install things"
  const terminal = process.stdin.isTTY === true && process.stdout.isTTY === true;
  // the prompt's default is the terminal's default, so the (Y/n) the user
  // reads is always the answer enter actually gives
  const both = shouldAsk
    ? await askYesNo("install dependencies and start the dev server", terminal)
    : terminal;
  install ??= both;
  start ??= both;
}
// no `start && !install` guard here: without install the run reports the
// manual steps and exits before start is ever consulted, so a guard would be
// a line no test could ever fail on

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
  // every borgo command that compiles css, not just the three that were
  // obvious. `borgo export` compiles it too, and without the flag it looked
  // for the style.scss this branch had just deleted, found none, and removed
  // public/assets/style.css - the app's only stylesheet, in a gitignored
  // directory, while the pages it exported still linked it.
  for (const script of ["dev", "build", "start", "export"]) {
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

// Every spawned tool is bounded. A tool that never answers is worse than one
// that fails: the scaffold is already on disk, so an unbounded wait is a user
// staring at a blank terminal with no summary, no next steps and no idea
// whether anything was written. A pre-commit hook that blocks and a stalled
// filesystem both look like this.
// BORGO_SPAWN_TIMEOUT_MS overrides all three, so a test can drive a tool that
// never answers without waiting out the real bound - but a seam is an input
// like any other and is validated like one. `Infinity` is the dangerous value:
// Number() accepts it and spawnSync reads it as "no timeout", which removes the
// bound entirely rather than lengthening it. A negative or absurd value makes
// spawnSync throw instead, and a throw here would be read as a missing binary.
// Anything that is not a plain, sane, positive integer is not a bound.
const MAX_BOUND = 3_600_000;
const bound = (fallback: number) => {
  const asked = Number(process.env.BORGO_SPAWN_TIMEOUT_MS);
  return Number.isInteger(asked) && asked > 0 && asked <= MAX_BOUND ? asked : fallback;
};
const GIT_TIMEOUT = bound(20_000);
const GO_TIMEOUT = bound(15_000);
// bun install and go mod tidy fetch over the network on a cold cache, so this
// one is a bound against a hang, not against slowness
const STEP_TIMEOUT = bound(900_000);
const asSeconds = (ms: number) => (ms >= 10_000 ? `${Math.round(ms / 1000)}s` : `${ms}ms`);

// git: initialised last, so the first commit contains the finished scaffold.
// every command is scoped with -C, and the scaffold is verified to own the
// repository before anything is staged - scaffolding into a directory inside
// another repo must never stage that repo's files.
//
// The summary has one job here: say what actually happened to git. That is why
// there are nine outcomes and not four. Every way this can go wrong is a
// disagreement between the sentence printed and the filesystem, in one of two
// directions, and both are equally wrong:
//
//   - claiming no repository when one is on disk. A user told "git is not
//     available here" does not go and run `git init`, so a real repo with an
//     unborn HEAD sits there unnoticed. This is what a subst drive, a
//     safecrlf refusal or an invalid init.defaultBranch used to produce.
//   - claiming a repository, or a reason for one, that is not there. An
//     instruction that is confidently wrong - "set user.name/user.email" when
//     the identity is set and it was gpg or a hook that refused - costs more
//     than no instruction, because following it changes nothing.
//
// So: absent, unresponsive, refused-at-init, refused-at-add and refused-at-
// commit are different sentences, the reason is only named when git itself
// identifies it, and anything unclassified is quoted rather than guessed at.
//
// The one rule the whole section is built on: OBSERVE OR QUOTE, NEVER ASSERT.
// The code's own idea of how far it got is not evidence. A command killed at
// the bound may have done all of its work, none of it, or - with a post-commit
// hook that blocks - all of it and more, so every sentence about what is on
// the disk is read back off the disk at the moment it is printed.
type GitResult =
  | "created"
  | "nested"
  | "git-env"
  | "unavailable"
  | "unrunnable"
  | "unresponsive"
  | "init-failed"
  | "stage-failed"
  | "no-identity"
  | "commit-failed";

type GitRun =
  | { ran: true; code: number; out: string; err: string }
  | { ran: false; reason: "missing" | "unrunnable" | "timeout"; why: string };

// ENOENT is "there is no git"; anything else thrown by spawnSync is this
// process failing to make a call, and telling the user to install a git they
// already have sends them to fix the wrong machine.
// No test reaches the second branch, and that is the point: the bound is now
// validated before it is passed, so the out-of-range values that used to throw
// here never get that far. A corrupt git.exe does NOT come back ENOENT, which
// an earlier version of this comment claimed: libuv reports EUNKNOWN for a file
// it cannot launch and EFTYPE for one that is empty or is a library, and both
// land in "unrunnable", which is the right answer. Collapsing this distinction
// is what turned one bad environment variable into three tools declared missing.
const missingBinary = (cause: unknown) =>
  typeof cause === "object" && cause !== null && (cause as { code?: unknown }).code === "ENOENT";

// git's own words rather than a guess at them: an unclassified message the
// user can read beats an instruction that does not apply to their problem.
// A hook chooses what crosses that stream, so it is untrusted input.
//
// The filter is defined by what a consumer ACTS ON, not by a byte range. C0 and
// C1 cover ESC (clears the screen), CR (overwrites the line above) and NUL
// (turns the summary into a binary stream). Beyond them: the bidi controls,
// because U+202E renders the whole rest of the line reversed and a reader
// cannot see it happen; and U+2028/U+2029, which are line breaks to everything
// that follows the Unicode rules even though they are not \n - a log viewer or
// a JS consumer splits on them, which forges a line this program never wrote.
// Zero-width and BOM characters go too: text that cannot be seen cannot be read
// back to anyone. Replaced rather than dropped, so the message still shows that
// something was there.
const FORGEABLE =
  /[\u0000-\u001f\u007f-\u009f\u00ad\u061c\u180e\u200b-\u200f\u2028\u2029\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/g;
const printable = (text: string) => text.replace(/\t/g, " ").replace(FORGEABLE, "?");

// spawnSync throws on a binary that is not there, rather than returning a
// code - so the common case, git not installed at all, arrives as an exception
// that would kill the run at its very last step with the whole scaffold
// already written. Every git call goes through this helper so neither the
// guard nor the bound can be forgotten on a later one, and the three ways a
// call can fail to produce an exit code stay apart: absent, unrunnable and
// unresponsive have three different fixes.
const runGitWithin = (ms: number, ...argv: string[]): GitRun => {
  let proc;
  try {
    proc = Bun.spawnSync(["git", "-C", target, ...argv], {
      stdout: "pipe",
      stderr: "pipe",
      timeout: ms,
    });
  } catch (cause) {
    if (missingBinary(cause)) return { ran: false, reason: "missing", why: "" };
    return { ran: false, reason: "unrunnable", why: printable(String(cause)).slice(0, 110) };
  }
  // a killed process has no exit code of its own: the bound expiring arrives as
  // a null exitCode, and defaulting that to 0 would report a commit that never
  // happened, while defaulting it to non-zero would blame git for a clock
  if (proc.exitCode === null) return { ran: false, reason: "timeout", why: "" };
  return {
    ran: true,
    code: proc.exitCode,
    out: proc.stdout.toString().trim(),
    err: proc.stderr.toString().trim(),
  };
};

const runGit = (...argv: string[]): GitRun => runGitWithin(GIT_TIMEOUT, ...argv);

const gitSays = (run: { code: number; err: string }) => {
  const line = run.err
    .split("\n")
    .map((l) => printable(l).trim())
    .find((l) => l.length > 0 && !/^warning:/i.test(l));
  if (!line) return `git exited ${run.code}`;
  return line.length > 110 ? `${line.slice(0, 107)}...` : line;
};

// git's own answer to "is there a repository here", applied to the scaffold's
// own .git. `existsSync(".git")` is a weaker claim than the summary makes -
// GIT_COMMON_DIR leaves a .git holding only HEAD and refs, which is not
// somewhere `git log` will ever answer - and the summary must not outrun what
// is actually on the disk. These are the three entries git's own setup code
// requires, checked as files rather than asked of a git that the environment
// can redirect.
// Second line, and deliberately so: the REDIRECTING_ENV guard below already
// turns away every case known to reach here, so weakening this back to
// existsSync(".git") on its own survives the whole suite - weakening both
// together does not. It stays because that guard is a list, and a list can
// miss a member.
const isRepo = () => {
  const dir = join(target, ".git");
  return (
    existsSync(join(dir, "HEAD")) &&
    existsSync(join(dir, "objects")) &&
    existsSync(join(dir, "refs"))
  );
};

// WHAT AN INTERRUPTED GIT LEFT BEHIND - ASKED OF GIT, NOT READ OUT OF IT.
//
// This used to parse .git by hand, on the reasoning that whatever hung the
// first git would hang an observer. The reasoning was sound and the conclusion
// was wrong, because there is a third option between hanging and guessing:
// ask git under a much shorter bound, and if that does not answer either, say
// we do not know.
//
// Hand-reading failed three times in a row, each time on a different shape of
// the same mistake - a ref in packed-refs, then reftable's `ref:
// refs/heads/.invalid` stub with the real refs in .git/reftable/, then a
// zero-byte ref file that exists and means nothing. Each was repaired and the
// next one arrived, because git's on-disk state is not a format we are owed:
// ref backends, packing, and index layout all change under us, and every
// repair reimplemented a little more of git slightly wrong. The failures all
// pointed the same way - "no commit was made" while the commit was made -
// which is the direction that tells a user their work is gone.
//
// The first bound already established that this repository is slow, so the
// follow-up gets a tenth of it. What it cannot confirm, it does not claim.
const PROBE_TIMEOUT = Math.max(250, Math.round(GIT_TIMEOUT / 10));

const repoState = (): string => {
  const unsure =
    `the repository is at ${name}/ ${dot} ` +
    "check it with `git log` and `git status` before retrying";

  const head = runGitWithin(PROBE_TIMEOUT, "rev-parse", "--verify", "--quiet", "HEAD");
  if (!head.ran) return unsure;
  const staged = runGitWithin(PROBE_TIMEOUT, "diff", "--cached", "--name-only");
  // a refusal here is not an answer: without it we cannot tell an unborn HEAD
  // from a repository git will not open, and those are different sentences
  if (!staged.ran || staged.code !== 0) return unsure;

  // the only file this still looks at, and it may only add to an answer git
  // already gave - never stand in for one. A lock is not evidence about
  // commits or staging; it is a leftover that blocks the user's next command
  // and that none of these plumbing commands mentions.
  const locked = existsSync(join(target, ".git", "index.lock"))
    ? ` ${dot} remove .git/index.lock before retrying`
    : "";

  const count = staged.out.split("\n").filter(Boolean).length;
  const tree = count > 0 ? `${count} file${count === 1 ? "" : "s"} staged` : "nothing staged";
  // a commit is claimed only when git named one, in whatever ref format it
  // keeps them. `diff --cached` having answered is what makes the negative
  // safe too: git could open the repository and still would not resolve HEAD,
  // so there is genuinely nothing committed yet.
  if (head.code === 0 && head.out.length > 0) {
    return `the commit was made ${dot} ${tree}${locked}`;
  }
  return `no commit yet ${dot} ${tree}${locked}`;
};

// git decides whether it knows who is committing, not a regex over a stream a
// hook also writes to. A pre-commit hook printing "please tell me who you are"
// used to steal this classification and discard git's real message - the exact
// failure this section exists to prevent, coming back through text we do not
// control. `git var` runs no hooks, so its answer is git's own.
const identityMissing = () => {
  const ident = runGit("var", "GIT_COMMITTER_IDENT");
  return ident.ran && ident.code !== 0;
};

// the GIT_* variables that relocate where git keeps its state. Any one of them
// means a `git init` here would not produce a repository *here*, so the scaffold
// is left alone - and the sentence names the variable rather than claiming
// something about a repository that may not exist at the other end of it.
const REDIRECTING_ENV = [
  "GIT_DIR",
  "GIT_COMMON_DIR",
  "GIT_OBJECT_DIRECTORY",
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_WORK_TREE",
  "GIT_INDEX_FILE",
  "GIT_NAMESPACE",
  // not a relocation but an injection: it decides what `git init` puts into the
  // new .git, including hooks and refs, so the repository this would report is
  // not the one this program made
  "GIT_TEMPLATE_DIR",
] as const;

// The config twin of a guarded environment variable is the same power with a
// different spelling, and guarding one of a pair is guarding neither.
// init.templateDir decides what `git init` copies into the new .git, refs
// included, so a template pointed at a repository that already holds a commit
// produces a scaffold whose HEAD names a commit this run never made. That
// passes the rule this section is built on - a commit is claimed only when git
// names one - because git did name a commit. It was not ours.
//
// HOW THIS FAILS IF IT IS WRONG, in the two directions:
//   - too narrow, and the summary reports "the commit was made" over someone
//     else's history, which is the original defect wearing a config key;
//   - too wide, and a scaffold that would have got a perfectly good repository
//     is refused one for a setting that changes nothing. That is why the sweep
//     below is by demonstrated effect and not by name.
//
// Asked of git rather than read out of config files, for the reason repoState
// asks: `git config` resolves every scope, include.path, includeIf and
// GIT_CONFIG_COUNT injection, and any parser written here would resolve a
// different subset than the git that is about to run.
//
// The sweep for the asymmetry - a guarded variable whose config twin is open -
// finds exactly one more key across REDIRECTING_ENV. GIT_WORK_TREE's twin
// core.worktree was tested and is deliberately absent: set in global config it
// does not relocate a fresh init at all, so guarding it would refuse a
// repository that would have been correct. The other six have no config twin.
const REDIRECTING_CONFIG = ["init.templateDir"] as const;

const initGit = (): [GitResult, string] => {
  // git exports these to hooks, `rebase --exec`, `bisect run` and !-aliases, so
  // a scaffolder invoked from any of those inherits an environment that points
  // git's state somewhere else entirely. Skipping is right and is what keeps
  // `add -A` out of an unrelated repo. Guarding only GIT_DIR was guarding one
  // member of a family: GIT_OBJECT_DIRECTORY sent every object elsewhere while
  // the summary reported an initial commit that no git command could find.
  const redirected = REDIRECTING_ENV.find((key) => process.env[key]);
  if (redirected) return ["git-env", redirected];

  const inRepo = runGit("rev-parse", "--is-inside-work-tree");
  if (!inRepo.ran) {
    if (inRepo.reason === "missing") return ["unavailable", ""];
    return inRepo.reason === "unrunnable" ? ["unrunnable", inRepo.why] : ["unresponsive", ""];
  }
  // already tracked by an enclosing repo: that repo is the undo history
  if (inRepo.code === 0 && inRepo.out === "true") return ["nested", ""];

  // after the reachability checks, so a missing or unrunnable git is still
  // reported as itself rather than as a configuration problem
  for (const key of REDIRECTING_CONFIG) {
    const set = runGit("config", "--get", key);
    if (set.ran && set.code === 0 && set.out.length > 0) return ["git-env", key];
  }

  const init = runGit("init", "-q");
  // the disk, not a path comparison. `rev-parse --show-toplevel` answers with
  // the physical path while target keeps whatever process.cwd() handed over,
  // so on a subst drive - ordinary practice for shortening source paths, and
  // no unusual configuration at all - the two never matched and a perfectly
  // real repository was reported as no git at all. What has to be true is that
  // the scaffold owns the repository `add -A` will stage into: a fact about
  // the filesystem, which has no second spelling.
  if (!init.ran) return ["unresponsive", repoState()];
  // a refused init still leaves a half-written .git behind, and that .git then
  // breaks the user's own `git init` and `git status` until it is removed
  if (init.code !== 0) {
    const partial = existsSync(join(target, ".git")) ? ` ${dot} remove the partial .git first` : "";
    return ["init-failed", gitSays(init) + partial];
  }
  if (!isRepo()) return ["init-failed", "git init left no usable repository in the scaffold"];

  const add = runGit("add", "-A");
  if (!add.ran) return ["unresponsive", repoState()];
  if (add.code !== 0) return ["stage-failed", gitSays(add)];

  const commit = runGit("commit", "-q", "-m", "initial commit");
  if (!commit.ran) return ["unresponsive", repoState()];
  if (commit.code === 0) return ["created", ""];
  // the repo and the staged tree survive either way; only the reason differs,
  // and only one of the reasons is fixed by identifying yourself
  return identityMissing() ? ["no-identity", ""] : ["commit-failed", gitSays(commit)];
};

const [gitResult, gitDetail]: [GitResult, string] = git ? initGit() : ["unavailable", ""];

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
// that could not run says so here rather than leaving the user to find out.
// The lines that carry a detail carry git's own message or a fact read back
// off the filesystem, so the ones that stay fixed sentences are only the
// outcomes that can be named with certainty.
// The GIT_DIR line names the variable and stops there: whether there is a
// repository at the other end of it is not something this knows, and
// "points at another repository" was false for a path with nothing there.
const detail = gitDetail ? ` ${dot} ${gitDetail}` : "";
// git's words go on their own line, under ours. A hook chooses this text and
// may choose text that reads exactly like a summary line; it cannot choose a
// line break, because printable() removes every character any consumer treats
// as one. So the boundary is structural rather than a delimiter it can type:
// nothing it writes can start a line, and this line is already labelled.
const quoted = (text: string) => `\n${" ".repeat(18)}${dim(`git said: ${text}`)}`;
const gitLine: Record<GitResult, string> = {
  created: `${sage(ok)} git         ${dim("repository initialised " + dot + " initial commit")}`,
  nested: `${dim(dot)} git         ${dim("skipped " + dot + " already inside a repository")}`,
  // true of every member of the family, whether it relocates git's state or
  // decides what goes into the new repository: the only claim is that the
  // variable is set, which is a fact about this process and nothing else
  "git-env": `${dim(dot)} git         ${dim(`skipped ${dot} ${gitDetail} is set ${dot} unset it for a repository in the scaffold itself`)}`,
  "no-identity": `${dim(dot)} git         ${dim("initialised, files staged " + dot + " set user.name/user.email, then commit")}`,
  unavailable: `${dim(dot)} git         ${dim("skipped " + dot + " git is not available here")}`,
  unrunnable: `${terracotta(err)} git         ${dim(`git could not be run ${dot} ${gitDetail}`)}`,
  unresponsive: `${terracotta(err)} git         ${dim(`git did not finish in ${asSeconds(GIT_TIMEOUT)}${detail}`)}`,
  "init-failed": `${terracotta(err)} git         ${dim("not initialised")}${quoted(gitDetail)}`,
  "stage-failed": `${terracotta(err)} git         ${dim("initialised, nothing staged")}${quoted(gitDetail)}`,
  "commit-failed": `${terracotta(err)} git         ${dim(`initialised, files staged ${dot} not committed`)}${quoted(gitDetail)}`,
};
const linterLine: Record<LinterName, string> = {
  biome: `${sage(ok)} linter      ${dim("biome " + dot + " biome.json " + dot + " bun run lint / format")}`,
  eslint: `${sage(ok)} linter      ${dim("eslint + prettier " + dot + " eslint.config.js " + dot + " bun run lint / format")}`,
  none: `${dim(dot)} linter      ${dim("none")}`,
};

const included = [
  git ? gitLine[gitResult] : `${dim(dot)} git         ${dim("skipped")}`,
  // the only place a key that exists in exactly one gitignored file gets
  // named. its other mention lives in the README's Deploy section, which
  // --no-docker strips - so an app scaffolded without docker documented its
  // own signing key nowhere at all.
  ...(template === "full"
    ? [
        `${sage(ok)} .env        ${dim("SESSION_SECRET " + dot + " random, unique, gitignored " + dot + " copy it to the server or sessions break")}`,
      ]
    : []),
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
const tailwindNote = tailwind
  ? `\n  ${dim(`tailwind is wired: edit ${bold("style.css")} ${dot} the template's own styles are plain css, replace them freely`)}\n`
  : "";
const signature = `  ${dim(`borgo is built by Luigi Micca ${dot}`)} ${terracotta("https://luigimicca.com")}`;

console.log(`${asked ? "" : `\n${banner}\n`}
  ${sage(ok)} created ${bold(name)}/ ${dim(`${dot} ${stack}`)}
${layouts[template]}

  included
${included}`);

// go is not optional for this stack: `borgo dev` regenerates the typed bridge
// by running borgogen through the go toolchain before it serves anything, so
// a missing or too-old go is reported here rather than as a failure inside a
// dev server the user was told to expect. 1.25 is what the template's go.mod
// asks for - the `tool` directive it uses to pin borgogen needs it.
const GO_MIN = [1, 25] as const;
const goCheck = (): { ok: true; version: string } | { ok: false; reason: string } => {
  // spawnSync throws on a binary that is not there, rather than returning a
  // code - so the common case, go not installed at all, arrives as an
  // exception and would otherwise surface as a stack trace
  let probe;
  try {
    probe = Bun.spawnSync(["go", "version"], {
      stdout: "pipe",
      stderr: "pipe",
      timeout: GO_TIMEOUT,
    });
  } catch (cause) {
    // only ENOENT means "install go": any other throw is this process failing
    // to make the call, and one bad environment variable must not be allowed
    // to declare every tool on the machine missing
    if (missingBinary(cause)) return { ok: false, reason: "go is not on PATH" };
    return { ok: false, reason: `go could not be run ${dot} ${printable(String(cause)).slice(0, 110)}` };
  }
  if (probe.exitCode === null) {
    return { ok: false, reason: `go version did not finish in ${asSeconds(GO_TIMEOUT)}` };
  }
  // a go that is installed and broken is a different problem from a go that is
  // absent, and installing go does not fix the first one
  if (probe.exitCode !== 0) {
    const said = printable(probe.stderr.toString().trim().split("\n")[0] ?? "").trim();
    return {
      ok: false,
      reason: `go version exited ${probe.exitCode}${said ? ` ${dot} ${said.slice(0, 110)}` : ""}`,
    };
  }
  const found = probe.stdout.toString().match(/go(\d+)\.(\d+)(?:\.\d+)?/);
  if (!found) return { ok: false, reason: "could not read the go version" };
  const [major, minor] = [Number(found[1]), Number(found[2])];
  const version = `${major}.${minor}`;
  if (major > GO_MIN[0] || (major === GO_MIN[0] && minor >= GO_MIN[1])) return { ok: true, version };
  return { ok: false, reason: `go ${version} is older than ${GO_MIN.join(".")}` };
};

const secs = (from: number) => `${((performance.now() - from) / 1000).toFixed(1)}s`;

// output is inherited, never captured: an install that fails has to say why on
// the user's own terminal. Swallowing it to keep the summary tidy is how a
// broken scaffold looks like a finished one.
const runStep = (label: string, argv: string[]): boolean => {
  console.log(`\n  ${terracotta(arrow)} ${bold(label)} ${dim(argv.join(" "))}\n`);
  const t0 = performance.now();
  let proc;
  try {
    proc = Bun.spawnSync(argv, {
      cwd: target,
      stdout: "inherit",
      stderr: "inherit",
      stdin: "inherit",
      timeout: STEP_TIMEOUT,
    });
  } catch (cause) {
    const why = missingBinary(cause)
      ? `${argv[0]} is not on PATH`
      : `${argv[0]} could not be run ${dot} ${printable(String(cause)).slice(0, 110)}`;
    console.log(`\n  ${terracotta(err)} ${label} ${dim(`${dot} ${why}`)}`);
    return false;
  }
  if (proc.exitCode === null) {
    console.log(
      `\n  ${terracotta(err)} ${label} ${dim(`${dot} did not finish in ${asSeconds(STEP_TIMEOUT)}`)}`,
    );
    return false;
  }
  if (proc.exitCode === 0) {
    console.log(`\n  ${sage(ok)} ${label} ${dim(dot + " " + secs(t0))}`);
    return true;
  }
  console.log(`\n  ${terracotta(err)} ${label} ${dim(`${dot} exited ${proc.exitCode}`)}`);
  return false;
};

const manual = (lines: string[]) =>
  console.log(`\n  next steps\n${lines.map((l) => `    ${l}`).join("\n")}\n`);

if (!install) {
  manual([`cd ${name}`, "bun install", "go mod tidy", "bun run dev"]);
  console.log(`  then open ${bold("http://localhost:3000")}\n${tailwindNote}\n${signature}\n`);
  process.exit(0);
}

const go = goCheck();
if (!go.ok) {
  console.log(
    `\n  ${terracotta(err)} ${bold("go")} ${dim(`${dot} ${go.reason}`)}` +
      `\n  ${dim(`borgo needs go ${GO_MIN.join(".")}+ to generate the typed api and build the server ${dot} https://go.dev/dl/`)}`,
  );
}

const installed = runStep("dependencies", ["bun", "install"]);
const tidied = installed && go.ok ? runStep("go modules", ["go", "mod", "tidy"]) : false;
const ready = installed && tidied;

if (!ready || !start) {
  const todo: string[] = [`cd ${name}`];
  if (!installed) todo.push("bun install");
  if (!go.ok) todo.push(`install go ${GO_MIN.join(".")}+, then: go mod tidy`);
  else if (!tidied) todo.push("go mod tidy");
  todo.push("bun run dev");
  manual(todo);
  console.log(`  then open ${bold("http://localhost:3000")}\n${tailwindNote}\n${signature}\n`);
  process.exit(ready ? 0 : 1);
}

console.log(
  `\n  ${terracotta(arrow)} ${bold("dev server")} ${dim(`${dot} http://localhost:3000 ${dot} ctrl-c to stop`)}` +
    `\n  ${dim(`start it again any time with: cd ${name} ${dot} bun run dev`)}` +
    `${tailwindNote}\n${signature}\n`,
);

// correct-by-ordering is not correct: this is only reachable because `bun
// install` just succeeded, which is a fact about today's control flow rather
// than a guard. spawn throws on a missing binary exactly as spawnSync does.
let dev;
try {
  dev = Bun.spawn(["bun", "run", "dev"], {
    cwd: target,
    stdout: "inherit",
    stderr: "inherit",
    stdin: "inherit",
  });
} catch {
  console.log(`  ${terracotta(err)} ${bold("dev server")} ${dim(`${dot} bun is not on PATH`)}\n`);
  process.exit(1);
}
// ctrl-c belongs to the dev server now; forward it and let the child decide
// the exit code, so a supervisor sees what actually happened
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => dev.kill(signal));
}
process.exit(await dev.exited);
