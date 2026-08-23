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
  // a flag right after `--template` is the user's next flag, not its value: ""
  // reaches the same unknown-value message as `--template=` instead of undefined
  const value = (): string => {
    const next = args[i + 1];
    if (next === undefined || next.startsWith("-")) return "";
    i++;
    return next;
  };
  if (arg === "--template" || arg === "-t") template = value();
  else if (arg.startsWith("--template=")) template = arg.slice("--template=".length);
  else if (arg === "--linter") linter = value();
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

// the prompt's spelling is accepted as a flag value too
if (linter === "eslint+prettier" || linter === "prettier") linter = "eslint";

if (linter !== undefined && !isLinter(linter)) {
  console.error(`unknown linter "${linter}" - available: ${LINTERS.map((l) => l.name).join(", ")}`);
  process.exit(1);
}

// BORGO_FORCE_PROMPT drives the question path without a pty: a pipe is never a
// tty, and the stdin bugs below only appear once something is actually read
const interactive =
  process.env.BORGO_FORCE_PROMPT === "1" ||
  (process.stdin.isTTY === true && process.stdout.isTTY === true);

// a pending stdin read keeps the event loop alive: open only when asked, and
// release before the summary prints
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

const askYesNo = async (label: string, fallback: boolean): Promise<boolean> => {
  const answer = await ask(`  ${label} ${dim(fallback ? "(Y/n)" : "(y/N)")} `);
  if (answer === "") return fallback;
  return answer === "y" || answer === "yes";
};

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

// one question, two flags: a script may want dependencies without a server that
// never exits. --no-install exits before start is read, so don't ask for it
if (install === false) start ??= false;

if (install === undefined || start === undefined) {
  // keyed off a real terminal, not `interactive`: a test driving the prompts
  // over a pipe with BORGO_FORCE_PROMPT must not start installing things
  const terminal = process.stdin.isTTY === true && process.stdout.isTTY === true;
  const label = [
    install === undefined ? "install dependencies" : null,
    start === undefined ? "start the dev server" : null,
  ]
    .filter(Boolean)
    .join(" and ");
  const answer = shouldAsk ? await askYesNo(label, terminal) : terminal;
  install ??= answer;
  start ??= answer;
}
// release stdin or the process sits there after its summary
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

// a literal key is shared by every scaffold and one derived from the name is
// public; .env is gitignored, bun loads it and borgo passes its env to the go binary
if (template === "full") {
  write(
    ".env",
    "# generated by create-borgo, unique to this app, never commit it.\n" +
      "# regenerate with: openssl rand -base64 48 - every existing session becomes invalid.\n" +
      `SESSION_SECRET=${randomBytes(48).toString("base64url")}\n`,
  );
}

// the postcss plugin, not @tailwindcss/cli: the cli drags in @parcel/watcher,
// whose postinstall shows up as `Blocked 1 postinstall` on every install
if (tailwind) {
  rmSync(join(target, "style.scss"));
  renameSync(join(target, "tailwind.css"), join(target, "style.css"));
  // `export` too: without the flag it looks for the deleted style.scss and
  // removes public/assets/style.css while the exported pages still link it
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

// the readme must not describe a Dockerfile or stylesheet that is no longer there
const readmePath = join(target, "README.md");
if (existsSync(readmePath)) {
  let readme = readFileSync(readmePath, "utf8");
  if (!docker) readme = readme.replace(/## Deploy\n[\s\S]*?\n(?=## )/, "");
  if (tailwind) readme = readme.replaceAll("style.scss", "style.css");
  writeFileSync(readmePath, readme);
}

if (chosenLinter === "biome") {
  addDevDeps({ "@biomejs/biome": "^2.5.0" });
  // not `biome check`: it also fails on formatting, so a fresh scaffold could not pass its own lint
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

// the default formatter must be the recommended one, or two formatters fight on every save
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

// every spawn is bounded (a blocking pre-commit hook looks like a hang).
// BORGO_SPAWN_TIMEOUT_MS is validated: `Infinity` means "no timeout" to
// spawnSync, and a negative value makes it throw, which reads as a missing binary
const MAX_BOUND = 3_600_000;
const bound = (fallback: number) => {
  const asked = Number(process.env.BORGO_SPAWN_TIMEOUT_MS);
  return Number.isInteger(asked) && asked > 0 && asked <= MAX_BOUND ? asked : fallback;
};
const GIT_TIMEOUT = bound(20_000);
const GO_TIMEOUT = bound(15_000);
// a bound against a hang, not slowness: cold-cache fetches are slow
const STEP_TIMEOUT = bound(900_000);
const asSeconds = (ms: number) => (ms >= 10_000 ? `${Math.round(ms / 1000)}s` : `${ms}ms`);

// git runs last so the first commit holds the finished scaffold. Ownership is
// verified before staging: a scaffold inside another repo must not stage its files.
// Each outcome is a different fix; a reason is named only when git itself names
// it, else quoted. Never assert from control flow: a command killed at the bound
// may have done all its work, none, or more (blocking post-commit hook), so
// every sentence about the disk is read off the disk when printed.
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

// only ENOENT is "no git": a corrupt git.exe comes back EUNKNOWN (cannot launch)
// or EFTYPE (empty or a library), and must not send the user to install one
const missingBinary = (cause: unknown) =>
  typeof cause === "object" && cause !== null && (cause as { code?: unknown }).code === "ENOENT";

// a hook chooses what crosses stderr, so it is untrusted. Beyond C0/C1: bidi
// controls (U+202E reverses the rest of the line), U+2028/2029 (line breaks to
// any Unicode-aware splitter, so they forge a line) and zero-width/BOM.
// Replaced, not dropped, so the message still shows something was there
const FORGEABLE =
  /[\u0000-\u001f\u007f-\u009f\u00ad\u061c\u180e\u200b-\u200f\u2028\u2029\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/g;
const printable = (text: string) => text.replace(/\t/g, " ").replace(FORGEABLE, "?");

// spawnSync throws on a missing binary: every git call goes through here so
// neither the guard nor the bound can be forgotten
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
  // the bound expiring arrives as a null exitCode
  if (proc.exitCode === null) return { ran: false, reason: "timeout", why: "" };
  return {
    ran: true,
    code: proc.exitCode,
    out: proc.stdout.toString().trim(),
    err: proc.stderr.toString().trim(),
  };
};

const runGit = (...argv: string[]): GitRun => runGitWithin(GIT_TIMEOUT, ...argv);

// never the exit status: that is our reading of the run, not a sentence git wrote
const gitSays = (run: { err: string }) => {
  const line = run.err
    .split("\n")
    .map((l) => printable(l).trim())
    .find((l) => l.length > 0 && !/^warning:/i.test(l));
  if (!line) return "";
  return line.length > 110 ? `${line.slice(0, 107)}...` : line;
};

// `said` is git's stderr and nothing else; `note` is ours. Merged, our advice
// would print under `git said:` as git's own words
type GitReport = { result: GitResult; note: string; said: string };

const report = (result: GitResult, note = "", said = ""): GitReport => ({ result, note, said });

const failed = (result: GitResult, run: { code: number; err: string }, note = ""): GitReport => {
  const said = gitSays(run);
  const ours = [said ? "" : `git exited ${run.code}`, note].filter(Boolean).join(` ${dot} `);
  return report(result, ours, said);
};

// the three entries git's own setup requires, not existsSync(".git"): a
// GIT_COMMON_DIR leaves a .git holding only HEAD and refs. Redundant with the
// REDIRECTING_ENV guard (weakening one alone passes the suite, both does not),
// kept because that guard is a list and a list can miss a member
const isRepo = () => {
  const dir = join(target, ".git");
  return (
    existsSync(join(dir, "HEAD")) &&
    existsSync(join(dir, "objects")) &&
    existsSync(join(dir, "refs"))
  );
};

// what an interrupted git left behind is asked of git under a tenth of the
// bound, never read out of .git: packed-refs, reftable and zero-byte ref files
// each broke a hand parser, always as "no commit" while the commit was made
const PROBE_TIMEOUT = Math.max(250, Math.round(GIT_TIMEOUT / 10));

const repoState = (): string => {
  const unsure =
    `the repository is at ${name}/ ${dot} ` +
    "check it with `git log` and `git status` before retrying";

  const head = runGitWithin(PROBE_TIMEOUT, "rev-parse", "--verify", "--quiet", "HEAD");
  if (!head.ran) return unsure;
  const staged = runGitWithin(PROBE_TIMEOUT, "diff", "--cached", "--name-only");
  // without this answer an unborn HEAD and a repository git will not open are indistinguishable
  if (!staged.ran || staged.code !== 0) return unsure;

  // the lock only adds to git's answer: none of the plumbing above mentions it
  const locked = existsSync(join(target, ".git", "index.lock"))
    ? ` ${dot} remove .git/index.lock before retrying`
    : "";

  const count = staged.out.split("\n").filter(Boolean).length;
  const tree = count > 0 ? `${count} file${count === 1 ? "" : "s"} staged` : "nothing staged";
  // the negative is safe only because `diff --cached` answered: git opened the
  // repository and still did not resolve HEAD
  if (head.code === 0 && head.out.length > 0) {
    return `the commit was made ${dot} ${tree}${locked}`;
  }
  return `no commit yet ${dot} ${tree}${locked}`;
};

// not a regex over stderr, which a hook also writes to; `git var` runs no hooks
const identityMissing = () => {
  const ident = runGit("var", "GIT_COMMITTER_IDENT");
  return ident.ran && ident.code !== 0;
};

// any of these means `git init` would not produce a repository *here*; the
// summary names the variable and claims nothing about what is at the other end
const REDIRECTING_ENV = [
  "GIT_DIR",
  "GIT_COMMON_DIR",
  "GIT_OBJECT_DIRECTORY",
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_WORK_TREE",
  "GIT_INDEX_FILE",
  "GIT_NAMESPACE",
  // an injection, not a relocation: it decides what `git init` puts into .git, hooks and refs included
  "GIT_TEMPLATE_DIR",
] as const;

// the config twin of GIT_TEMPLATE_DIR: a template holding a commit gives the
// scaffold a HEAD git does name, so the "only when git names one" rule passes
// on someone else's history. Asked of `git config`, which resolves scopes,
// includes and GIT_CONFIG_COUNT as the git about to run will. core.worktree
// (GIT_WORK_TREE's twin) was tested and is deliberately absent: in global
// config it does not relocate a fresh init. The other six have no twin
const REDIRECTING_CONFIG = ["init.templateDir"] as const;

const initGit = (): GitReport => {
  // git exports these to hooks, `rebase --exec`, `bisect run` and !-aliases;
  // skipping keeps `add -A` out of an unrelated repo
  const redirected = REDIRECTING_ENV.find((key) => process.env[key]);
  if (redirected) return report("git-env", redirected);

  const inRepo = runGit("rev-parse", "--is-inside-work-tree");
  if (!inRepo.ran) {
    if (inRepo.reason === "missing") return report("unavailable");
    return inRepo.reason === "unrunnable" ? report("unrunnable", inRepo.why) : report("unresponsive");
  }
  if (inRepo.code === 0 && inRepo.out === "true") return report("nested");

  // after the reachability checks, so a missing git is not reported as a config problem
  for (const key of REDIRECTING_CONFIG) {
    const set = runGit("config", "--get", key);
    if (set.ran && set.code === 0 && set.out.length > 0) return report("git-env", key);
  }

  const init = runGit("init", "-q");
  // ownership is checked on disk, not by comparing `--show-toplevel` with
  // target: on a subst drive the physical and the given path never match
  if (!init.ran) return report("unresponsive", repoState());
  // a refused init leaves a half-written .git that breaks the user's own `git init`
  if (init.code !== 0) {
    const partial = existsSync(join(target, ".git")) ? "remove the partial .git first" : "";
    return failed("init-failed", init, partial);
  }
  if (!isRepo()) return report("init-failed", "git init left no usable repository in the scaffold");

  const add = runGit("add", "-A");
  if (!add.ran) return report("unresponsive", repoState());
  if (add.code !== 0) return failed("stage-failed", add);

  const commit = runGit("commit", "-q", "-m", "initial commit");
  if (!commit.ran) return report("unresponsive", repoState());
  if (commit.code === 0) return report("created");
  return identityMissing() ? report("no-identity") : failed("commit-failed", commit);
};

const { result: gitResult, note: gitNote, said: gitSaid } = git ? initGit() : report("unavailable");

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

// detail is our own words only; git's go to quoted()
const detail = gitNote ? ` ${dot} ${gitNote}` : "";
// a hook may write text that reads like a summary line, but printable() took
// every line break, so nothing it writes can start one: this line stays labelled
const quoted = (text: string) => (text ? `\n${" ".repeat(18)}${dim(`git said: ${text}`)}` : "");
const gitLine: Record<GitResult, string> = {
  created: `${sage(ok)} git         ${dim("repository initialised " + dot + " initial commit")}`,
  nested: `${dim(dot)} git         ${dim("skipped " + dot + " already inside a repository")}`,
  "git-env": `${dim(dot)} git         ${dim(`skipped ${dot} ${gitNote} is set ${dot} unset it for a repository in the scaffold itself`)}`,
  "no-identity": `${dim(dot)} git         ${dim("initialised, files staged " + dot + " set user.name/user.email, then commit")}`,
  unavailable: `${dim(dot)} git         ${dim("skipped " + dot + " git is not available here")}`,
  unrunnable: `${terracotta(err)} git         ${dim(`git could not be run ${dot} ${gitNote}`)}`,
  unresponsive: `${terracotta(err)} git         ${dim(`git did not finish in ${asSeconds(GIT_TIMEOUT)}${detail}`)}`,
  "init-failed": `${terracotta(err)} git         ${dim(`not initialised${detail}`)}${quoted(gitSaid)}`,
  "stage-failed": `${terracotta(err)} git         ${dim(`initialised, nothing staged${detail}`)}${quoted(gitSaid)}`,
  "commit-failed": `${terracotta(err)} git         ${dim(`initialised, files staged ${dot} not committed${detail}`)}${quoted(gitSaid)}`,
};
const linterLine: Record<LinterName, string> = {
  biome: `${sage(ok)} linter      ${dim("biome " + dot + " biome.json " + dot + " bun run lint / format")}`,
  eslint: `${sage(ok)} linter      ${dim("eslint + prettier " + dot + " eslint.config.js " + dot + " bun run lint / format")}`,
  none: `${dim(dot)} linter      ${dim("none")}`,
};

const included = [
  git ? gitLine[gitResult] : `${dim(dot)} git         ${dim("skipped")}`,
  // with --no-docker the README's Deploy section is gone, so this is the only
  // place the key is named
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

// 1.25 is what the templates' go.mod asks for: the `tool` directive pinning borgogen needs it
const GO_MIN = [1, 25] as const;
const goCheck = (): { ok: true; version: string } | { ok: false; reason: string } => {
  let probe;
  try {
    probe = Bun.spawnSync(["go", "version"], {
      stdout: "pipe",
      stderr: "pipe",
      timeout: GO_TIMEOUT,
    });
  } catch (cause) {
    if (missingBinary(cause)) return { ok: false, reason: "go is not on PATH" };
    return { ok: false, reason: `go could not be run ${dot} ${printable(String(cause)).slice(0, 110)}` };
  }
  if (probe.exitCode === null) {
    return { ok: false, reason: `go version did not finish in ${asSeconds(GO_TIMEOUT)}` };
  }
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

// output is inherited, never captured: a failing install must say why
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

// spawn throws on a missing binary exactly as spawnSync does; that install
// just succeeded is control flow, not a guard
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
// forward ctrl-c and let the child decide the exit code
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => dev.kill(signal));
}
process.exit(await dev.exited);
