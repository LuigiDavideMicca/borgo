// the typescript gate. four questions, in this order; any "no" is exit 1.
//
// 1. is every tsconfig on disk accounted for - a project below, or out of
//    scope with the reason written next to it? the project list used to live
//    here and nowhere else, so a package that arrived with its own tsconfig
//    was checked by nothing and nothing said so: a packages/probe-pkg holding
//    a file that does not compile made this gate exit 0.
// 2. is every .d.ts on disk accounted for? every project sets skipLibCheck,
//    which does not mean "skip node_modules" - it means skip the body of every
//    .d.ts - so only a project that turns it off checks them. same rule: in
//    that project's program, or out of scope with a reason. a new
//    src/__gateprobe.d.ts declaring the same name twice also exited 0.
// 3. does every include entry pull in at least one file? tsc is silent when an
//    entry matches nothing, and exit 0 with no diagnostics is exactly what a
//    green run looks like. the six generated entries under examples/tasks
//    /.borgo - untracked, written by `borgo build` - used to make the gate
//    check nothing at all on a cold clone.
// 4. does tsc pass on each project?
//
// 1-3 read each project through `tsc --showConfig`, which resolves `extends`
// (an include inherited from a parent config is checked too) and expands
// include/exclude into the file list tsc would actually load. the parser is
// therefore tsc's own: this gate accepts exactly the configs tsc accepts,
// trailing commas included, and never invents a severity tsc does not have.
import { readdirSync } from "node:fs";
import { posix } from "node:path";

// a project is a tsconfig path; tsc -p accepts a file or its directory
const projects = [
  "tsconfig.json",
  "tsconfig.dts.json",
  "packages/borgo/tsconfig.json",
  "packages/create-borgo/tsconfig.json",
  "examples/tasks/tsconfig.json",
];

// tsconfigs and .d.ts files this gate deliberately does not cover. a pattern
// that matches nothing is not an error - generated and scratch paths are
// absent on a cold clone, and an excuse that matches nothing can only fail to
// excuse a file, never hide one. an excuse that is too broad is the danger, so
// keep them narrow.
const outOfScope = [
  {
    pattern: "bench/**",
    why: "not a workspace member, so a root install makes no bench/node_modules and this gate cannot run it. bench/tsconfig.json is gated by the 'bench harness' CI step instead (bun install --frozen-lockfile && bun run typecheck, from bench/); bench/apps/* are fixtures of competing frameworks and are gated by nothing, see bench/tsconfig.json for why",
  },
  {
    pattern: "cmd/borgogen/testdata/*/.borgo/api-types.d.ts",
    why: "33 golden borgogen outputs. they are assertions, not sources, and cannot share a program: all 33 augment `declare module \"borgo-framework\"` and they disagree. `go test ./cmd/borgogen` asserts each one byte for byte",
  },
  {
    pattern: "packages/create-borgo/templates/**",
    why: "template sources, not sources of this repo: they import borgo-framework and keep generated types under _borgo/, both of which resolve only once scaffolded. the 'scaffold test' CI steps run `bunx tsc --noEmit` inside each freshly scaffolded app. that covers the .ts/.tsx and the 3 tsconfigs, but not the 4 .d.ts bodies - the template tsconfig sets skipLibCheck too, so scaffolding does not check them either. the 3 generated _borgo/api-types.d.ts are pinned by the same steps a different way, `go tool borgogen` then diff against the shipped copy. full/ws-events.d.ts is the one hand-written declaration here whose body nothing reads: a limit, not a claim. it is a copy of examples/tasks/ws-events.d.ts, which tsconfig.dts.json does check, and nothing asserts the two stay equal",
  },
  {
    pattern: "packages/borgo/test/**/*.d.ts",
    why: "excluded from that project on purpose: a .d.ts under test/ is an ambient declaration for the whole suite, not a fixture. see the exclude in packages/borgo/tsconfig.json and test/tsconfig-program.test.ts",
  },
  {
    pattern: "examples/tasks/.doc-snippets/**",
    why: "scratch, written by scripts/check-doc-links.ts and removed when its own gate passes; survives a failed run only",
  },
  {
    pattern: "examples/tasks/borgo-*/**",
    why: "scratch apps, mkdtempSync'd inside the example app by packages/borgo/test/build.test.ts; survive a killed run only. examples/tasks/tsconfig.json excludes the same paths",
  },
].map((rule) => ({ ...rule, glob: new Bun.Glob(rule.pattern) }));

const walk = (dir: string, out: string[] = []) => {
  for (const entry of readdirSync(dir || ".", { withFileTypes: true })) {
    const path = dir ? `${dir}/${entry.name}` : entry.name;
    if (!entry.isDirectory()) out.push(path);
    else if (entry.name !== "node_modules" && entry.name !== ".git") walk(path, out);
  }
  return out;
};

const die = (...lines: string[]): never => {
  console.error(lines.join("\n"));
  process.exit(1);
};

const readProject = (project: string) => {
  const tsc = Bun.spawnSync(["bunx", "tsc", "--showConfig", "-p", project], { stdout: "pipe", stderr: "pipe" });
  const dump = tsc.stdout.toString();
  const said = dump + tsc.stderr.toString();
  if (tsc.exitCode !== 0) die(`typecheck: cannot read ${project}`, said);
  // parse stdout alone: whatever bunx says on stderr is not part of the dump,
  // and concatenating the two turned any word from it into a raw SyntaxError
  if (!dump.trimStart().startsWith("{")) die(`typecheck: ${project} did not dump json`, said);
  return JSON.parse(dump) as {
    compilerOptions?: { skipLibCheck?: boolean };
    files?: string[];
    include?: string[];
  };
};

const configs = projects.map((project) => ({ project, config: readProject(project) }));
// showConfig reports paths relative to the config, "./" prefixed
const filesOf = ({ project, config }: (typeof configs)[number]) =>
  (config.files ?? []).map((file) => posix.join(posix.dirname(project), file));

const onDisk = walk("");
const unexcused = (paths: string[], known: Set<string>) =>
  paths.filter((path) => !known.has(path) && !outOfScope.some((rule) => rule.glob.match(path)));

const tsconfigs = onDisk.filter((path) => /(^|\/)tsconfig[^/]*\.json$/.test(path));
const strays = unexcused(tsconfigs, new Set(projects));
if (strays.length > 0) {
  die(
    "typecheck: tsconfig files this gate has never heard of:\n  " + strays.join("\n  "),
    "\na tsconfig nobody registered is a project nothing typechecks, and the gate",
    "stays green. add each to `projects` in scripts/typecheck.ts, or to",
    "`outOfScope` there with the reason it is not gated.",
  );
}

const gone = projects.filter((project) => !tsconfigs.includes(project));
if (gone.length > 0) {
  die(
    "typecheck: registered projects that are not on disk:\n  " + gone.join("\n  "),
    "\nthey were moved or removed. update `projects` in scripts/typecheck.ts.",
  );
}

// skipLibCheck skips .d.ts bodies, so only a project that turns it off checks
// them. if none does, every .d.ts here is unchecked and this reports all of them
const libChecked = new Set(
  configs
    .filter((entry) => entry.config.compilerOptions?.skipLibCheck === false)
    .flatMap(filesOf),
);
const unchecked = unexcused(
  onDisk.filter((path) => path.endsWith(".d.ts")),
  libChecked,
);
if (unchecked.length > 0) {
  die(
    "typecheck: .d.ts files nothing checks:\n  " + unchecked.join("\n  "),
    "\nevery other project sets skipLibCheck: true, which skips the body of every",
    ".d.ts, this repo's own included - so a declaration lands in the program and",
    "is never read. add each to the include of tsconfig.dts.json, or to",
    "`outOfScope` in scripts/typecheck.ts with the reason it is not checked.",
  );
}

const barren: string[] = [];
for (const entry of configs) {
  const files = (entry.config.files ?? []).map((file) => file.replace(/^\.\//, ""));
  for (const included of entry.config.include ?? []) {
    const pattern = included.replace(/^\.\//, "").replace(/\/+$/, "");
    const covers = /[*?]/.test(pattern)
      ? ((glob) => (file: string) => glob.match(file))(new Bun.Glob(pattern))
      : (file: string) => file === pattern || file.startsWith(`${pattern}/`);
    if (!files.some(covers)) barren.push(`${entry.project} -> ${included}`);
  }
}

if (barren.length > 0) {
  die(
    "typecheck: include entries that contribute no file:\n  " + barren.join("\n  "),
    "\nan include entry that matches nothing is silent in tsc, so this would have",
    "passed while checking less than it claims - a missing file, an empty",
    "directory and a directory holding nothing tsc loads all look the same here.",
    "generated entries come from `bun run build` in the app that owns them.",
  );
}

let failed = false;
for (const { project } of configs) {
  const tsc = Bun.spawnSync(["bunx", "tsc", "--noEmit", "-p", project], { stdio: ["ignore", "inherit", "inherit"] });
  if (tsc.exitCode !== 0) failed = true;
}
process.exit(failed ? 1 : 0);
