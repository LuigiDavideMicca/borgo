import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// the scaffolder is a script, so it is tested the way a user runs it: spawned
// in a scratch directory, asserted on the tree it leaves behind
const cli = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
let cwd = "";

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "create-borgo-"));
});
afterEach(() => {
  // git leaves pack files read-only on windows, which loses a race with the
  // handle git itself just dropped: retry rather than fail the test after it
  for (let i = 0; i < 5; i++) {
    try {
      rmSync(cwd, { recursive: true, force: true });
      return;
    } catch {
      Bun.sleepSync(50);
    }
  }
});

// a commit needs an identity and this machine may have none configured, so
// the tests carry their own rather than depending on the developer's git
const IDENTITY = {
  GIT_AUTHOR_NAME: "borgo test",
  GIT_AUTHOR_EMAIL: "test@borgo.local",
  GIT_COMMITTER_NAME: "borgo test",
  GIT_COMMITTER_EMAIL: "test@borgo.local",
};

const run = (args: string[], env: Record<string, string | undefined> = {}) => {
  const proc = Bun.spawnSync(["bun", cli, ...args], {
    cwd,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, ...IDENTITY, ...env } as Record<string, string>,
  });
  return {
    code: proc.exitCode,
    out: proc.stdout.toString() + proc.stderr.toString(),
  };
};

const git = (app: string, ...argv: string[]) => {
  const proc = Bun.spawnSync(["git", "-C", join(cwd, app), ...argv], {
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, ...IDENTITY } as Record<string, string>,
  });
  return { code: proc.exitCode, out: proc.stdout.toString().trim() };
};

const pkg = (app: string) =>
  JSON.parse(readFileSync(join(cwd, app, "package.json"), "utf8")) as {
    name: string;
    scripts: Record<string, string>;
    dependencies: Record<string, string>;
    devDependencies: Record<string, string>;
  };

const readJson = (app: string, rel: string) =>
  JSON.parse(readFileSync(join(cwd, app, rel), "utf8"));

// most cases have nothing to do with git, and skipping it keeps the suite
// quick and the scratch directory free of read-only pack files
const NG = "--no-git";

// the same run a user gets, with a PATH that genuinely holds no git, no go and
// no bun. That is not a contrived environment: it is what `bunx create-borgo`
// meets on a machine where those were never installed, and Bun.spawnSync THROWS
// on a missing binary rather than returning a non-zero code, so an unguarded
// probe reaches the user as a stack trace.
//
// It deliberately does not pass --no-git, and no caller may add it back: every
// call used to, which is exactly what kept the unguarded `git init` - the
// default path on such a machine - out of reach of the whole suite.
// bun itself has to be launchable to run the cli at all, so it is invoked by
// absolute path while the PATH the child searches is emptied.
const withoutToolchain = (args: string[], extraEnv: Record<string, string> = {}) => {
  const empty = join(cwd, ".no-tools");
  mkdirSync(empty, { recursive: true });
  const proc = Bun.spawnSync([process.execPath, cli, ...args], {
    cwd,
    env: {
      ...IDENTITY,
      PATH: empty,
      Path: empty,
      SystemRoot: process.env.SystemRoot,
      TEMP: process.env.TEMP,
      TMP: process.env.TMP,
      ...extraEnv,
    } as Record<string, string>,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  return { code: proc.exitCode, out: proc.stdout.toString() + proc.stderr.toString() };
};

// a global gitconfig this test owns. The interesting git failures are all
// ordinary configuration - safecrlf, a signing key, a hooksPath, a ref backend
// - so they have to be arranged rather than mocked, without depending on or
// disturbing whatever the machine running the suite has configured.
const gitConfig = (label: string, body: string) => {
  const path = join(cwd, `gitconfig-${label}`);
  writeFileSync(path, body);
  return { GIT_CONFIG_GLOBAL: path, GIT_CONFIG_SYSTEM: join(cwd, "no-system-gitconfig") };
};

// git's own answer, so a test that claims "the identity is set" has proof of
// it rather than an assumption about the environment
const gitConfigValue = (env: Record<string, string | undefined>, key: string) => {
  const proc = Bun.spawnSync(["git", "config", "--global", key], {
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, ...env } as Record<string, string>,
  });
  return proc.stdout.toString().trim();
};

const IDENTITY_CONFIG = "[user]\n\tname = A Real Person\n\temail = real@example.com\n";

// a hook that blocks forever, installed globally the way a commit policy or a
// notifier would be
const blockingHook = (label: string, which: string, body = "sleep 15\n") => {
  const hooks = join(cwd, `hooks-${label}`);
  mkdirSync(hooks, { recursive: true });
  writeFileSync(join(hooks, which), `#!/bin/sh\n${body}`);
  return `[core]\n\thooksPath = ${hooks.replaceAll("\\", "/")}\n`;
};

describe("template selection", () => {
  test("defaults to base when nothing is passed and stdin is not a tty", () => {
    expect(run(["app", NG]).code).toBe(0);
    // base is the only template with islands/
    expect(existsSync(join(cwd, "app", "islands"))).toBe(true);
    expect(existsSync(join(cwd, "app", "pages", "live.tsx"))).toBe(true);
  });

  for (const [template, marker] of [
    ["minimal", "pages/index.tsx"],
    ["base", "islands/Counter.tsx"],
    ["full", "pages/login.tsx"],
  ] as const) {
    test(`--template ${template} scaffolds its own shape`, () => {
      expect(run(["app", "--template", template, NG]).code).toBe(0);
      expect(existsSync(join(cwd, "app", marker))).toBe(true);
    });
  }

  test("minimal really is minimal", () => {
    run(["app", "--template", "minimal", NG]);
    expect(existsSync(join(cwd, "app", "islands"))).toBe(false);
    expect(existsSync(join(cwd, "app", "pages", "about.tsx"))).toBe(false);
  });

  test("full carries the auth and realtime surface", () => {
    run(["app", "--template", "full", NG]);
    for (const f of [
      "pages/register.tsx",
      "pages/account.tsx",
      "pages/live.tsx",
      "api/users.go",
      "ws-events.d.ts",
    ]) {
      expect(existsSync(join(cwd, "app", f))).toBe(true);
    }
  });

  test("-t and --template=x are the same flag", () => {
    expect(run(["a", "-t", "full", NG]).code).toBe(0);
    expect(run(["b", "--template=full", NG]).code).toBe(0);
    expect(existsSync(join(cwd, "a", "pages", "login.tsx"))).toBe(true);
    expect(existsSync(join(cwd, "b", "pages", "login.tsx"))).toBe(true);
  });

  test("an unknown template is refused by name", () => {
    const { code, out } = run(["app", "--template", "kitchen-sink", NG]);
    expect(code).toBe(1);
    expect(out).toContain("kitchen-sink");
    expect(out).toContain("minimal");
    expect(existsSync(join(cwd, "app"))).toBe(false);
  });
});

describe("tailwind", () => {
  test("off by default: scss stays, the tailwind stylesheet is removed", () => {
    run(["app", NG]);
    expect(existsSync(join(cwd, "app", "style.scss"))).toBe(true);
    expect(existsSync(join(cwd, "app", "style.css"))).toBe(false);
    expect(existsSync(join(cwd, "app", "tailwind.css"))).toBe(false);
    expect(pkg("app").scripts.dev).toBe("borgo dev");
    expect(pkg("app").devDependencies.tailwindcss).toBeUndefined();
  });

  for (const template of ["minimal", "base", "full"] as const) {
    test(`--tailwind wires ${template} end to end`, () => {
      expect(run(["app", "--template", template, "--tailwind", NG]).code).toBe(0);
      const app = join(cwd, "app");
      // the scss is replaced, not left beside a second stylesheet
      expect(existsSync(join(app, "style.scss"))).toBe(false);
      expect(existsSync(join(app, "tailwind.css"))).toBe(false);
      const css = readFileSync(join(app, "style.css"), "utf8");
      expect(css).toContain('@import "tailwindcss"');
      // the template's own look survives the switch
      expect(css.length).toBeGreaterThan(200);

      const p = pkg("app");
      // export compiles css too: without the flag it deletes the app's only
      // stylesheet out of a gitignored directory
      for (const script of ["dev", "build", "start", "export"] as const) {
        expect(`${script}: ${p.scripts[script]}`).toContain("--tailwind");
      }
      expect(p.devDependencies.tailwindcss).toBeTruthy();
      expect(p.devDependencies["@tailwindcss/postcss"]).toBeTruthy();
      expect(p.devDependencies.postcss).toBeTruthy();
    });
  }

  // @tailwindcss/cli depends on @parcel/watcher, whose postinstall compiles a
  // native watcher from source: bun blocks it and the very first thing a new
  // user sees is `Blocked 1 postinstall`. borgo drives the postcss plugin
  // instead and never uses that watcher.
  test("the tailwind deps do not drag in the cli that blocks a postinstall", () => {
    run(["app", "--tailwind", NG]);
    const p = pkg("app");
    expect(p.devDependencies["@tailwindcss/cli"]).toBeUndefined();
    expect(Object.keys(p.devDependencies)).toContain("@tailwindcss/postcss");
  });

  test("the readme names the stylesheet that actually exists", () => {
    run(["a", "--tailwind", NG]);
    const tw = readFileSync(join(cwd, "a", "README.md"), "utf8");
    expect(tw).toContain("style.css");
    expect(tw).not.toContain("style.scss");

    run(["b", "--no-tailwind", NG]);
    expect(readFileSync(join(cwd, "b", "README.md"), "utf8")).toContain("style.scss");
  });

  test("--no-tailwind is explicit and does not ask", () => {
    expect(run(["app", "--no-tailwind", NG]).code).toBe(0);
    expect(existsSync(join(cwd, "app", "style.scss"))).toBe(true);
  });

  test("the flags compose in either order", () => {
    expect(run(["a", "--tailwind", "--template", "full", NG]).code).toBe(0);
    expect(run(["b", "--template", "full", "--tailwind", NG]).code).toBe(0);
    for (const app of ["a", "b"]) {
      expect(existsSync(join(cwd, app, "pages", "login.tsx"))).toBe(true);
      expect(existsSync(join(cwd, app, "style.css"))).toBe(true);
    }
  });
});

describe("git", () => {
  // THE PROPERTY: the summary tells the truth about what happened to git.
  //
  // Every outcome is a different sentence, and the whole test is whether the
  // sentence printed matches the filesystem. It can be wrong in two directions
  // and both are equally wrong:
  //
  //   - claiming no repository, or no commit, when one is on disk. "git is not
  //     available here" tells a user version control is impossible, so they
  //     never run `git init`; "no commit was made" tells them their work is
  //     gone. Both are read and believed.
  //   - claiming a repository, or a reason for one, that is not there. "set
  //     user.name/user.email" when the identity is set and gpg or a hook
  //     refused is worse than silence: following it changes nothing.
  //
  // So no test here asserts on output alone. Each arranges a real git failure
  // with real git and default flags, then checks the disk - repository usable
  // or not, tree staged or not, commit there or not - against the sentence.
  const GIT_LINES = {
    created: "repository initialised",
    nested: "already inside a repository",
    "git-env": "unset it for a repository in the scaffold itself",
    "no-identity": "set user.name/user.email",
    unavailable: "git is not available here",
    unrunnable: "git could not be run",
    unresponsive: "git did not finish in",
    "init-failed": "not initialised",
    "stage-failed": "initialised, nothing staged",
    "commit-failed": "not committed",
  };

  // this program's own sentence. Everything git said lives on its own line,
  // labelled, because a hook picks that text and can pick words that read
  // exactly like one of these lines - so matching the whole output would let a
  // hook decide which outcome the test believes.
  const ourSentence = (out: string) => {
    const line = out.match(/^\s+\S+ git {2,}(.*)$/m)?.[1] ?? "";
    return line;
  };
  const onlyGitLine = (out: string, expected: keyof typeof GIT_LINES) => {
    const sentence = ourSentence(out);
    expect(sentence.length).toBeGreaterThan(0);
    for (const [key, line] of Object.entries(GIT_LINES)) {
      expect(`${key}: ${sentence.includes(line)}`).toBe(`${key}: ${key === expected}`);
    }
  };

  // the disk, asked in a clean environment - never the summary being tested,
  // and never by reading git's files, which is the mistake this suite exists
  // to catch. The test process has none of the redirecting variables set.
  const onDisk = (app: string) => ({
    repo: existsSync(join(cwd, app, ".git")),
    usable: git(app, "rev-parse", "--is-inside-work-tree").out === "true",
    staged: git(app, "diff", "--cached", "--name-only").out.split("\n").filter(Boolean).length,
    commits: git(app, "log", "--oneline").out.split("\n").filter(Boolean).length,
  });

  test("a scaffold is a repository with an initial commit by default", () => {
    const { code, out } = run(["app"]);
    expect(code).toBe(0);
    expect(existsSync(join(cwd, "app", ".git"))).toBe(true);
    expect(git("app", "rev-list", "--count", "HEAD").out).toBe("1");
    expect(git("app", "log", "-1", "--pretty=%s").out).toBe("initial commit");
    onlyGitLine(out, "created");
  });

  test("the initial commit contains the scaffold, working tree clean", () => {
    run(["app", "--template", "full"]);
    // nothing left unstaged or untracked: the commit really is the whole tree
    expect(git("app", "status", "--porcelain").out).toBe("");
    const tracked = git("app", "ls-files").out.split("\n");
    for (const f of ["package.json", "main.go", ".gitignore", "pages/login.tsx"]) {
      expect(tracked).toContain(f);
    }
  });

  test("--no-git leaves no repository", () => {
    expect(run(["app", "--no-git"]).code).toBe(0);
    expect(existsSync(join(cwd, "app", ".git"))).toBe(false);
    expect(existsSync(join(cwd, "app", "package.json"))).toBe(true);
  });

  // git defaults ON, so on a machine without it this is the default path: the
  // scaffold is complete on disk before git is ever reached, and the run has to
  // finish reporting it rather than dying at its last step
  test("no git on PATH is reported, not thrown, and the scaffold still lands", () => {
    const { code, out } = withoutToolchain(["app", "--no-install"]);
    // the exit code answers "did the scaffold succeed", not "is git installed"
    expect(code).toBe(0);
    onlyGitLine(out, "unavailable");
    expect(out).not.toContain("Executable not found");
    expect(out).not.toContain("error:");
    expect(out).not.toMatch(/\bat <anonymous>/);
    // the run finishes: summary, next steps and signature all present
    expect(out).toContain("created app/");
    expect(out).toContain("next steps");
    expect(out).toContain("luigimicca.com");
    // and the tree really is there, without a half-made repository beside it
    expect(existsSync(join(cwd, "app", "package.json"))).toBe(true);
    expect(existsSync(join(cwd, "app", "main.go"))).toBe(true);
    expect(existsSync(join(cwd, "app", ".git"))).toBe(false);
  });

  // a git that is present and cannot be launched is not a git that is absent,
  // and "install git" is the wrong instruction for it. libuv reports EUNKNOWN
  // for a file it cannot start and EFTYPE for one that is empty or is a
  // library - never ENOENT, which an earlier comment in the cli claimed.
  test.if(process.platform === "win32")(
    "a git that exists but cannot be launched is not reported as a missing git",
    () => {
      const dir = join(cwd, ".broken-git");
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "git.exe"), "MZ this is not a real executable\n");
      const { code, out } = withoutToolchain(["app", "--no-install"], { PATH: dir, Path: dir });
      expect(code).toBe(0);
      onlyGitLine(out, "unrunnable");
      expect(out).not.toMatch(/\bat <anonymous>/);
      expect(existsSync(join(cwd, "app", "package.json"))).toBe(true);
      expect(existsSync(join(cwd, "app", ".git"))).toBe(false);
    },
  );

  test("a scaffold inside an existing repository is not nested in a second one", () => {
    Bun.spawnSync(["git", "-C", cwd, "init", "-q"], { stdout: "pipe", stderr: "pipe" });
    const { code, out } = run(["app"]);
    expect(code).toBe(0);
    expect(existsSync(join(cwd, "app", ".git"))).toBe(false);
    onlyGitLine(out, "nested");
  });

  // git is there and answers; it is the commit that refuses
  test("a missing git identity does not fail the scaffold", () => {
    const { code, out } = run(["app"], {
      // no global/system config and no identity in the environment
      GIT_CONFIG_GLOBAL: join(cwd, "nonexistent-gitconfig"),
      GIT_CONFIG_SYSTEM: join(cwd, "nonexistent-gitconfig"),
      GIT_AUTHOR_NAME: undefined,
      GIT_AUTHOR_EMAIL: undefined,
      GIT_COMMITTER_NAME: undefined,
      GIT_COMMITTER_EMAIL: undefined,
      EMAIL: undefined,
    });
    expect(code).toBe(0);
    // the repository and the staged tree survive; only the commit is missing
    expect(existsSync(join(cwd, "app", ".git"))).toBe(true);
    expect(git("app", "diff", "--cached", "--name-only").out).toContain("package.json");
    onlyGitLine(out, "no-identity");
  });

  // DIRECTION ONE: no repository claimed, a repository on disk.

  // core.autocrlf + core.safecrlf is a very ordinary windows ~/.gitconfig, and
  // it makes `add -A` refuse the template's LF files outright. The repository
  // is real and empty, and a user told git is unavailable will never find it.
  test("a stage git refuses is a repository with nothing staged, not a missing git", () => {
    const env = gitConfig(
      "safecrlf",
      `[core]\n\tautocrlf = true\n\tsafecrlf = true\n${IDENTITY_CONFIG}`,
    );
    const { code, out } = run(["app"], env);
    expect(code).toBe(0);
    const disk = onDisk("app");
    expect(disk.repo).toBe(true);
    expect(disk.staged).toBe(0);
    onlyGitLine(out, "stage-failed");
    // git's own words, on their own line, not a guess at them
    expect(out).toContain("git said:");
    expect(out).toContain("LF would be replaced by CRLF");
  });

  // an invalid init.defaultBranch makes `git init` fail 128 *after* creating a
  // half-written .git, which then breaks the user's next `git init` and
  // `git status`.
  test("an init git refuses names the partial .git it left behind", () => {
    const env = gitConfig("badbranch", `[init]\n\tdefaultBranch = "bad name"\n${IDENTITY_CONFIG}`);
    const { code, out } = run(["app"], env);
    expect(code).toBe(0);
    expect(existsSync(join(cwd, "app", ".git"))).toBe(true);
    onlyGitLine(out, "init-failed");
    expect(out).toContain("invalid branch name");
    expect(out).toContain("remove the partial .git");
    expect(existsSync(join(cwd, "app", "package.json"))).toBe(true);
  });

  // `subst` is ordinary practice for shortening source paths and needs no
  // unusual configuration at all. rev-parse --show-toplevel answers with the
  // physical path while the target keeps the virtual drive letter, so a string
  // comparison of the two never matched and a repository with a real initial
  // commit was reported as no git at all.
  test.if(process.platform === "win32")(
    "a subst drive still reports the repository it actually created",
    () => {
      const free = ["Y", "X", "W", "V", "U"].find((l) => !existsSync(`${l}:\\`));
      if (!free) return;
      const drive = `${free}:`;
      const substituted = Bun.spawnSync(["subst", drive, cwd], { stdout: "pipe", stderr: "pipe" });
      if (substituted.exitCode !== 0) return;
      try {
        const proc = Bun.spawnSync(["bun", cli, "app"], {
          // the virtual drive is the cwd, exactly as a user working on one has
          cwd: `${drive}\\`,
          stdin: "pipe",
          stdout: "pipe",
          stderr: "pipe",
          env: { ...process.env, ...IDENTITY } as Record<string, string>,
        });
        const out = proc.stdout.toString() + proc.stderr.toString();
        expect(proc.exitCode).toBe(0);
        // the disk, reached through the real path rather than the virtual one
        expect(existsSync(join(cwd, "app", ".git"))).toBe(true);
        expect(git("app", "rev-list", "--count", "HEAD").out).toBe("1");
        onlyGitLine(out, "created");
      } finally {
        Bun.spawnSync(["subst", drive, "/d"], { stdout: "pipe", stderr: "pipe" });
      }
    },
  );

  // DIRECTION TWO: a repository claimed, or a reason for one, that is not there.

  // the identity is set and git can read it back. The commit fails because it
  // cannot run the signing program, and "set user.name/user.email" is not
  // merely imprecise here, it is an instruction that changes nothing.
  test("a commit refused by a missing signing program is not blamed on the identity", () => {
    const env = gitConfig(
      "gpg",
      `[commit]\n\tgpgsign = true\n[gpg]\n\tprogram = ${join(cwd, "no-such-gpg.exe").replaceAll("\\", "/")}\n${IDENTITY_CONFIG}`,
    );
    // proof, not assumption: this is what git itself reports as the identity
    expect(gitConfigValue(env, "user.email")).toBe("real@example.com");
    const { code, out } = run(["app"], env);
    expect(code).toBe(0);
    const disk = onDisk("app");
    expect(disk.repo).toBe(true);
    expect(disk.staged).toBeGreaterThan(0);
    expect(disk.commits).toBe(0);
    onlyGitLine(out, "commit-failed");
    expect(out).toContain("gpg");
  });

  // a global core.hooksPath is how a company ships a commit policy to every
  // repository on the machine.
  test("a commit refused by a hook quotes the hook instead of guessing", () => {
    const env = gitConfig(
      "hooks",
      blockingHook("policy", "pre-commit", 'echo "policy: sign your commits" >&2\nexit 1\n') +
        IDENTITY_CONFIG,
    );
    expect(gitConfigValue(env, "user.name")).toBe("A Real Person");
    const { code, out } = run(["app"], env);
    expect(code).toBe(0);
    const disk = onDisk("app");
    expect(disk.repo).toBe(true);
    expect(disk.staged).toBeGreaterThan(0);
    onlyGitLine(out, "commit-failed");
    expect(out).toContain("policy: sign your commits");
  });

  // a regex over stderr cannot tell git's words from a hook's: hooks write to
  // the same stream. A pre-commit printing "please tell me who you are" made
  // the summary print the fixed identity sentence - advice that does not apply,
  // with git's real message discarded.
  test("a hook that impersonates the identity error does not steal the classification", () => {
    const env = gitConfig(
      "impersonate",
      blockingHook(
        "impersonate",
        "pre-commit",
        'echo "policy: please tell me who you are - commits need your @corp.com address" >&2\nexit 1\n',
      ) + IDENTITY_CONFIG,
    );
    expect(gitConfigValue(env, "user.email")).toBe("real@example.com");
    const { code, out } = run(["app"], env);
    expect(code).toBe(0);
    onlyGitLine(out, "commit-failed");
    expect(out).toContain("@corp.com");
    const disk = onDisk("app");
    expect(disk.staged).toBeGreaterThan(0);
    expect(disk.commits).toBe(0);
  });

  // A .git IS NOT THE SAME CLAIM AS A REPOSITORY.
  //
  // These decide where git keeps its state, or what goes into a new
  // repository, so a `git init` here does not produce a repository *here*.
  // GIT_OBJECT_DIRECTORY used to report "repository initialised - initial
  // commit" while every object landed elsewhere and the new project answered
  // `fatal: not a git repository`.
  for (const key of [
    "GIT_OBJECT_DIRECTORY",
    "GIT_COMMON_DIR",
    "GIT_WORK_TREE",
    "GIT_INDEX_FILE",
    "GIT_NAMESPACE",
    "GIT_TEMPLATE_DIR",
  ]) {
    test(`${key} in the environment is skipped, never reported as a repository`, () => {
      const elsewhere = join(cwd, "elsewhere");
      mkdirSync(elsewhere, { recursive: true });
      const { code, out } = run(["app"], { [key]: elsewhere });
      expect(code).toBe(0);
      onlyGitLine(out, "git-env");
      // the variable is named, because that is the thing the user has to undo
      expect(out).toContain(key);
      // and nothing anywhere claims a repository that a user cannot use
      const disk = onDisk("app");
      expect(disk.usable).toBe(false);
      expect(disk.commits).toBe(0);
      // the scaffold itself still landed in full
      expect(existsSync(join(cwd, "app", "package.json"))).toBe(true);
    });
  }

  // THE CONFIG TWIN OF A GUARDED VARIABLE.
  //
  // GIT_TEMPLATE_DIR was guarded, with the reason that a template decides what
  // `git init` puts into the new .git, refs included. init.templateDir is that
  // same power spelled as a config key, and it was open - so a template
  // pointing at a repository that already holds a commit produced a scaffold
  // whose HEAD named a commit this run never made, and the summary reported
  // "the commit was made" over someone else's history. Guarding one of a pair
  // is guarding neither.
  const donorRepo = () => {
    const donor = join(cwd, "donor");
    mkdirSync(donor, { recursive: true });
    const run1 = (...argv: string[]) =>
      Bun.spawnSync(["git", "-C", donor, ...argv], {
        stdout: "pipe",
        stderr: "pipe",
        env: { ...process.env, ...IDENTITY } as Record<string, string>,
      });
    run1("init", "-q");
    writeFileSync(join(donor, "donor-only.txt"), "not this scaffold\n");
    run1("add", "-A");
    run1("commit", "-q", "-m", "DONOR COMMIT");
    // the donor really does hold a commit, or the test proves nothing
    expect(
      Bun.spawnSync(["git", "-C", donor, "log", "--oneline"], { stdout: "pipe", stderr: "pipe" })
        .stdout.toString()
        .trim(),
    ).toContain("DONOR COMMIT");
    return join(donor, ".git").replaceAll("\\", "/");
  };

  test("init.templateDir carrying someone else's commit is never reported as ours", () => {
    const template = donorRepo();
    // plus a hook that blocks, which is what turned this into a confident
    // "the commit was made" rather than a merely wrong repository
    const env = gitConfig(
      "templatedir",
      `[init]\n\ttemplateDir = ${template}\n` +
        blockingHook("templatedir", "pre-commit") +
        IDENTITY_CONFIG,
    );
    const { code, out } = run(["app"], { ...env, BORGO_SPAWN_TIMEOUT_MS: "4000" });
    expect(code).toBe(0);
    onlyGitLine(out, "git-env");
    expect(out).toContain("init.templateDir");
    // the sentence that was the lie, and the disk that contradicted it
    expect(out).not.toContain("the commit was made");
    const disk = onDisk("app");
    expect(disk.usable).toBe(false);
    expect(disk.commits).toBe(0);
    // no trace of the donor anywhere in the scaffold
    expect(existsSync(join(cwd, "app", "donor-only.txt"))).toBe(false);
    expect(existsSync(join(cwd, "app", "package.json"))).toBe(true);
  }, 60_000);

  // asked of git rather than parsed out of config files, so every route to the
  // same key is covered by one check: scopes, include.path, includeIf, and the
  // environment's own config injection
  test("init.templateDir is caught however it was set", () => {
    const template = donorRepo();
    const viaInclude = join(cwd, "gitconfig-included");
    writeFileSync(viaInclude, `[init]\n\ttemplateDir = ${template}\n`);
    const env = gitConfig(
      "include",
      `[include]\n\tpath = ${viaInclude.replaceAll("\\", "/")}\n${IDENTITY_CONFIG}`,
    );
    const included = run(["app"], env);
    expect(included.code).toBe(0);
    onlyGitLine(included.out, "git-env");

    const injected = run(["other"], {
      GIT_CONFIG_GLOBAL: join(cwd, "no-such-gitconfig"),
      GIT_CONFIG_SYSTEM: join(cwd, "no-such-gitconfig"),
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "init.templateDir",
      GIT_CONFIG_VALUE_0: template,
    });
    expect(injected.code).toBe(0);
    onlyGitLine(injected.out, "git-env");
    expect(onDisk("other").commits).toBe(0);
  }, 60_000);

  // the guard sits after the reachability checks, and the ordering is not
  // cosmetic: inside an enclosing repository `git init` never runs, so
  // init.templateDir cannot affect anything and telling the user to unset it
  // would be advice about the wrong thing. The true reason is the enclosing
  // repository, and that is what has to be printed.
  test("inside an enclosing repository, the reason is the repository, not the template", () => {
    Bun.spawnSync(["git", "-C", cwd, "init", "-q"], { stdout: "pipe", stderr: "pipe" });
    const env = gitConfig(
      "nested-template",
      `[init]\n\ttemplateDir = ${donorRepo()}\n${IDENTITY_CONFIG}`,
    );
    const { code, out } = run(["app"], env);
    expect(code).toBe(0);
    onlyGitLine(out, "nested");
    expect(out).not.toContain("init.templateDir");
    expect(existsSync(join(cwd, "app", ".git"))).toBe(false);
  });

  // the other half of the sweep, and the direction that costs a user a
  // perfectly good repository: core.worktree is GIT_WORK_TREE's config twin and
  // is deliberately NOT guarded, because from global config it does not
  // relocate a fresh init at all. Guarding by name rather than by demonstrated
  // effect would refuse this scaffold its repository for nothing.
  test("core.worktree is not over-guarded: the scaffold still gets its repository", () => {
    const elsewhere = join(cwd, "elsewhere");
    mkdirSync(elsewhere, { recursive: true });
    const env = gitConfig(
      "worktree",
      `[core]\n\tworktree = ${elsewhere.replaceAll("\\", "/")}\n${IDENTITY_CONFIG}`,
    );
    const { code, out } = run(["app"], env);
    expect(code).toBe(0);
    onlyGitLine(out, "created");
    const disk = onDisk("app");
    expect(disk.commits).toBe(1);
    expect(disk.usable).toBe(true);
    // and it staged the scaffold's own files, not something in `elsewhere`
    expect(git("app", "ls-files").out.split("\n")).toContain("package.json");
  });

  // the skip is right; the old sentence was not. There is no repository at the
  // end of this path, so "points this run at another repository" described one
  // that does not exist.
  test("GIT_DIR pointing nowhere is skipped without inventing a repository", () => {
    const { code, out } = run(["app"], { GIT_DIR: join(cwd, "nope", "no", "repo", "here", ".git") });
    expect(code).toBe(0);
    onlyGitLine(out, "git-env");
    expect(out).toContain("GIT_DIR");
    expect(out).not.toContain("another repository");
    expect(onDisk("app").usable).toBe(false);
  });

  // WHAT AN INTERRUPTED GIT LEFT, ASKED OF GIT.
  //
  // A kill at the bound says nothing about how far git got, and the detail
  // used to be hard-coded. Reading .git by hand replaced one wrong answer with
  // another three times over - packed-refs, then reftable, then a zero-byte
  // ref - so the detail now comes from git under a much shorter bound, and
  // from "we do not know" when git will not answer either.
  test("a git that never answers is bounded, and reported as a timeout not as absence", () => {
    const env = gitConfig("slow", blockingHook("slow", "pre-commit") + IDENTITY_CONFIG);
    const started = Date.now();
    const { code, out } = run(["app"], { ...env, BORGO_SPAWN_TIMEOUT_MS: "2000" });
    expect(Date.now() - started).toBeLessThan(30_000);
    expect(code).toBe(0);
    onlyGitLine(out, "unresponsive");
    // the run still finishes: summary, next steps, signature
    expect(out).toContain("created app/");
    expect(out).toContain("next steps");
    expect(out).toContain("luigimicca.com");
    // and the detail matches the disk
    const disk = onDisk("app");
    expect(disk.repo).toBe(true);
    expect(disk.staged).toBeGreaterThan(0);
    expect(disk.commits).toBe(0);
    expect(out).toContain("no commit yet");
    expect(out).toContain(`${disk.staged} files staged`);
  }, 60_000);

  // THE ONE THAT KEPT COMING BACK.
  //
  // A blocking post-commit hook - an indexer, a notifier, both ordinary - is
  // killed with the commit already written and the index already clean, so
  // "the tree is staged" was wrong in both halves at once. A user who reads it
  // runs `git commit`, is told "nothing to commit", and concludes the scaffold
  // is unversioned. Run here under BOTH ref backends, because the files
  // backend and reftable disagree about everything a hand-reader would look
  // at: under reftable HEAD is the stub `ref: refs/heads/.invalid` and the
  // refs live in .git/reftable/, so nothing under .git/refs ever appears.
  for (const [label, config] of [
    ["the default ref backend", ""],
    ["reftable", "[init]\n\tdefaultRefFormat = reftable\n"],
  ] as const) {
    test(`a timeout after the commit says the commit was made, under ${label}`, () => {
      const env = gitConfig(
        `post-${label.replaceAll(" ", "-")}`,
        config + blockingHook(`post-${label.replaceAll(" ", "-")}`, "post-commit") + IDENTITY_CONFIG,
      );
      const { code, out } = run(["app"], { ...env, BORGO_SPAWN_TIMEOUT_MS: "2000" });
      expect(code).toBe(0);
      onlyGitLine(out, "unresponsive");
      // the disk is the only thing that decides which detail is true
      const disk = onDisk("app");
      expect(disk.commits).toBe(1);
      expect(disk.staged).toBe(0);
      expect(out).toContain("the commit was made");
      // the two sentences that would have been lies here
      expect(out).not.toContain("no commit yet");
      expect(out).not.toContain("files staged");
    }, 60_000);
  }

  // and the same backend on the ordinary path, so the whole run is exercised
  // under it rather than only its timeout branch
  test("reftable is an ordinary successful scaffold", () => {
    const env = gitConfig("reftable-ok", `[init]\n\tdefaultRefFormat = reftable\n${IDENTITY_CONFIG}`);
    const { code, out } = run(["app"], env);
    expect(code).toBe(0);
    onlyGitLine(out, "created");
    const disk = onDisk("app");
    expect(disk.commits).toBe(1);
    expect(disk.usable).toBe(true);
  });

  // when git will not answer the follow-up either, the honest sentence is that
  // we do not know - not a guess in the direction that costs the user work.
  // The hook breaks HEAD and then blocks, so the commit times out and every
  // probe afterwards fails too.
  test("a repository git will not describe is reported as unknown, not as empty", () => {
    const env = gitConfig(
      "broken",
      blockingHook(
        "broken",
        "post-commit",
        'printf "garbage\\n" > "$(git rev-parse --git-dir)/HEAD"\nsleep 15\n',
      ) + IDENTITY_CONFIG,
    );
    const { code, out } = run(["app"], { ...env, BORGO_SPAWN_TIMEOUT_MS: "2000" });
    expect(code).toBe(0);
    onlyGitLine(out, "unresponsive");
    // it says where to look and what to run, and claims nothing else
    expect(out).toContain("the repository is at app/");
    expect(out).toContain("git log");
    expect(out).toContain("git status");
    expect(out).not.toContain("no commit yet");
    expect(out).not.toContain("the commit was made");
    // the scaffold survives regardless
    expect(existsSync(join(cwd, "app", "package.json"))).toBe(true);
  }, 60_000);

  // AND WHEN THE FOLLOW-UP HANGS TOO.
  //
  // The first bound already established that this repository is slow, which is
  // exactly why the follow-up may not answer either - so it gets a tenth of the
  // bound, not another full one. A blocking core.fsmonitor is the shape that
  // proves it: git consults it on every index refresh, so `diff --cached` hangs
  // while `rev-parse HEAD` does not, and the run has to give up on the second
  // probe quickly and say plainly that it does not know.
  //
  // The assertion is the clock, because that is the only place the difference
  // shows: with the probe inheriting the full bound this run takes twice as
  // long and still prints the same words.
  test("a follow-up probe that hangs is bounded far shorter than the first", () => {
    const fsmonitor = join(cwd, "slow-fsmonitor.sh");
    writeFileSync(fsmonitor, "#!/bin/sh\nsleep 15\n");
    const env = gitConfig(
      "fsmonitor",
      `[core]\n\tfsmonitor = ${fsmonitor.replaceAll("\\", "/")}\n${IDENTITY_CONFIG}`,
    );
    const started = Date.now();
    const { code, out } = run(["app"], { ...env, BORGO_SPAWN_TIMEOUT_MS: "5000" });
    const elapsed = Date.now() - started;
    expect(code).toBe(0);
    onlyGitLine(out, "unresponsive");
    // one full bound for the command, a tenth of it for the probe - not two
    expect(elapsed).toBeLessThan(8_500);
    // and with nothing confirmed, nothing is claimed
    expect(out).toContain("the repository is at app/");
    expect(out).toContain("git log");
    expect(out).not.toContain("no commit yet");
    expect(out).not.toContain("the commit was made");
    expect(out).toContain("created app/");
    expect(out).toContain("luigimicca.com");
  }, 60_000);

  // the other half of the same fault: a stall during `add` leaves no index and
  // a lock that will block the user's own next `git add` until it is removed.
  test("a timeout during the staging names the lock it left", () => {
    const attrs = join(cwd, "attributes");
    writeFileSync(attrs, "* filter=slow\n");
    const filter = join(cwd, "slow-filter.sh");
    writeFileSync(filter, "#!/bin/sh\nsleep 15\n");
    const env = gitConfig(
      "slowfilter",
      `[core]\n\tattributesFile = ${attrs.replaceAll("\\", "/")}\n` +
        `[filter "slow"]\n\tclean = ${filter.replaceAll("\\", "/")}\n${IDENTITY_CONFIG}`,
    );
    const { code, out } = run(["app"], { ...env, BORGO_SPAWN_TIMEOUT_MS: "2500" });
    expect(code).toBe(0);
    onlyGitLine(out, "unresponsive");
    expect(existsSync(join(cwd, "app", ".git"))).toBe(true);
    expect(existsSync(join(cwd, "app", ".git", "index"))).toBe(false);
    expect(existsSync(join(cwd, "app", ".git", "index.lock"))).toBe(true);
    expect(onDisk("app").commits).toBe(0);
    expect(out).toContain("nothing staged");
    expect(out).toContain("remove .git/index.lock");
    expect(out).not.toContain("the commit was made");
  }, 60_000);

  // THE TEST SEAM IS AN INPUT LIKE ANY OTHER.
  //
  // Number("Infinity") is a number and spawnSync reads it as "no timeout", so
  // the one variable that exists to make the bound testable could remove it -
  // and with a git that never answers the run printed nothing at all.
  test("BORGO_SPAWN_TIMEOUT_MS=Infinity does not disable the bound", () => {
    // this one must outlast the SHIPPED 20s bound, not a test override
    const env = gitConfig(
      "forever",
      blockingHook("forever", "pre-commit", "sleep 30\n") + IDENTITY_CONFIG,
    );
    const started = Date.now();
    const { code, out } = run(["app"], { ...env, BORGO_SPAWN_TIMEOUT_MS: "Infinity" });
    const elapsed = Date.now() - started;
    // the shipped 20s bound, not the hook's 90s and not forever
    expect(elapsed).toBeLessThan(50_000);
    expect(code).toBe(0);
    onlyGitLine(out, "unresponsive");
    expect(out).toContain("created app/");
    expect(out).toContain("luigimicca.com");
  }, 120_000);

  // a value spawnSync refuses outright throws, and a catch that read every
  // throw as ENOENT turned one bad variable into "git is not available here"
  // on a machine where git works.
  for (const value of ["-1", "1e21", "0", "abc", "12.5"]) {
    test(`BORGO_SPAWN_TIMEOUT_MS=${value} falls back instead of declaring git missing`, () => {
      const { code, out } = run(["app"], { BORGO_SPAWN_TIMEOUT_MS: value });
      expect(code).toBe(0);
      onlyGitLine(out, "created");
      const disk = onDisk("app");
      expect(disk.commits).toBe(1);
      expect(disk.usable).toBe(true);
    });
  }

  // QUOTED TEXT IS UNTRUSTED INPUT, AND A DELIMITER IS NOT A BOUNDARY.
  //
  // A hook chooses these bytes. Wrapping them in quotes was not a boundary,
  // because a quote is a character the hook can type: it could close ours and
  // carry on in this program's voice. The boundary is structural instead - git's
  // words go on their own labelled line, and printable() removes every
  // character any consumer treats as a line break, so the hook cannot start a
  // line at all. What it cannot start, it cannot forge.
  //
  // The filter is defined by what a consumer acts on, not by a byte range:
  // U+202E reverses the rendered remainder of a line where no one can see it
  // happen, U+2028 is a line break to everything following the Unicode rules,
  // and zero-width characters are text that cannot be read back to anyone.
  test("a hook cannot forge a summary line, with quotes, escapes or separators", () => {
    const hooks = join(cwd, "forging-hooks");
    mkdirSync(hooks, { recursive: true });
    // octal escapes, so this test file contains no forgeable byte of its own:
    // \342\200\250 is U+2028, \342\200\256 is U+202E, \342\200\213 is U+200B
    writeFileSync(
      join(hooks, "pre-commit"),
      [
        "#!/bin/sh",
        String.raw`printf "closing\" quote: + git         repository initialised - initial commit\342\200\250    + git         repository initialised - initial commit\342\200\256reversed\342\200\213zero\033[2J\rforged\n" >&2`,
        "exit 1",
        "",
      ].join("\n"),
    );
    const env = gitConfig(
      "forging",
      `[core]\n\thooksPath = ${hooks.replaceAll("\\", "/")}\n${IDENTITY_CONFIG}`,
    );
    const { code, out } = run(["app"], env);
    expect(code).toBe(0);

    // nothing a terminal acts on
    expect(out).not.toMatch(/[\u0000-\u0008\u000b-\u001f\u007f]/);
    // nothing a Unicode-aware reader acts on
    for (const forgeable of ["\u2028", "\u2029", "\u202e", "\u200b", "\ufeff"]) {
      expect(out.includes(forgeable)).toBe(false);
    }

    // THE STRUCTURAL CLAIM: however hard the hook tries, exactly one line in
    // the whole output has the shape of a git summary line, and it is ours.
    const summaryLines = out.split("\n").filter((l) => /^\s+\S+ git {2,}/.test(l));
    expect(summaryLines.length).toBe(1);
    onlyGitLine(out, "commit-failed");
    expect(out).toContain("git said:");

    // and the disk agrees with the outcome the hook failed to change
    const disk = onDisk("app");
    expect(disk.commits).toBe(0);
    expect(disk.staged).toBeGreaterThan(0);
  });
});

describe("docker", () => {
  test("the docker files ship by default", () => {
    run(["app", NG]);
    for (const f of ["Dockerfile", "docker-compose.yml", ".dockerignore"]) {
      expect(existsSync(join(cwd, "app", f))).toBe(true);
    }
  });

  test("--no-docker leaves no Dockerfile", () => {
    expect(run(["app", "--no-docker", NG]).code).toBe(0);
    expect(existsSync(join(cwd, "app", "Dockerfile"))).toBe(false);
    expect(existsSync(join(cwd, "app", "docker-compose.yml"))).toBe(false);
    expect(existsSync(join(cwd, "app", ".dockerignore"))).toBe(false);
  });

  test("--no-docker takes nothing else with it", () => {
    run(["app", "--template", "full", "--no-docker", NG]);
    for (const f of ["package.json", "main.go", "pages/login.tsx", ".gitignore"]) {
      expect(existsSync(join(cwd, "app", f))).toBe(true);
    }
  });

  test("the readme stops advertising docker once it is gone", () => {
    run(["with", NG]);
    expect(readFileSync(join(cwd, "with", "README.md"), "utf8")).toContain("## Deploy");

    run(["without", "--no-docker", NG]);
    const readme = readFileSync(join(cwd, "without", "README.md"), "utf8");
    expect(readme).not.toContain("## Deploy");
    expect(readme).not.toContain("docker compose up");
    // the sections around it survive
    expect(readme).toContain("## Layout");
    expect(readme).toContain("bun run dev");
  });

  test("--no-docker holds for every template", () => {
    for (const t of ["minimal", "base", "full"] as const) {
      run([t, "--template", t, "--no-docker", NG]);
      expect(existsSync(join(cwd, t, "Dockerfile"))).toBe(false);
    }
  });
});

describe("vscode", () => {
  test("the editor config is written by default", () => {
    run(["app", NG]);
    expect(existsSync(join(cwd, "app", ".vscode", "extensions.json"))).toBe(true);
    expect(existsSync(join(cwd, "app", ".vscode", "settings.json"))).toBe(true);
  });

  test("--no-vscode leaves no .vscode", () => {
    expect(run(["app", "--no-vscode", NG]).code).toBe(0);
    expect(existsSync(join(cwd, "app", ".vscode"))).toBe(false);
  });

  test("go is always recommended", () => {
    run(["app", NG]);
    expect(readJson("app", ".vscode/extensions.json").recommendations).toContain("golang.go");
  });

  test("the recommended extensions follow the linter choice", () => {
    run(["b", "--linter", "biome", NG]);
    expect(readJson("b", ".vscode/extensions.json").recommendations).toContain("biomejs.biome");

    run(["e", "--linter", "eslint", NG]);
    const eslintRecs = readJson("e", ".vscode/extensions.json").recommendations;
    expect(eslintRecs).toContain("dbaeumer.vscode-eslint");
    expect(eslintRecs).toContain("esbenp.prettier-vscode");
    expect(eslintRecs).not.toContain("biomejs.biome");

    run(["n", "--linter", "none", NG]);
    const noneRecs = readJson("n", ".vscode/extensions.json").recommendations;
    expect(noneRecs).not.toContain("biomejs.biome");
    expect(noneRecs).not.toContain("dbaeumer.vscode-eslint");
  });

  test("tailwind adds its own extension", () => {
    run(["a", "--tailwind", NG]);
    expect(readJson("a", ".vscode/extensions.json").recommendations).toContain(
      "bradlc.vscode-tailwindcss",
    );
    run(["b", "--no-tailwind", NG]);
    expect(readJson("b", ".vscode/extensions.json").recommendations).not.toContain(
      "bradlc.vscode-tailwindcss",
    );
  });

  test("the formatter set is the one the recommended extensions provide", () => {
    run(["b", "--linter", "biome", NG]);
    const biome = readJson("b", ".vscode/settings.json");
    expect(biome["editor.defaultFormatter"]).toBe("biomejs.biome");
    expect(biome["editor.formatOnSave"]).toBe(true);

    run(["e", "--linter", "eslint", NG]);
    const eslint = readJson("e", ".vscode/settings.json");
    expect(eslint["editor.defaultFormatter"]).toBe("esbenp.prettier-vscode");
    expect(eslint["editor.formatOnSave"]).toBe(true);

    // with no formatter installed, format-on-save for ts would be a no-op
    run(["n", "--linter", "none", NG]);
    const none = readJson("n", ".vscode/settings.json");
    expect(none["editor.defaultFormatter"]).toBeUndefined();
    expect(none["editor.formatOnSave"]).toBe(false);
    expect(none["[go]"]).toBeTruthy();
  });
});

describe("linter", () => {
  test("no linter outside a tty: nothing is written, no scripts are added", () => {
    run(["app", NG]);
    expect(existsSync(join(cwd, "app", "biome.json"))).toBe(false);
    expect(existsSync(join(cwd, "app", "eslint.config.js"))).toBe(false);
    expect(existsSync(join(cwd, "app", ".prettierrc"))).toBe(false);
    const p = pkg("app");
    expect(p.scripts.lint).toBeUndefined();
    expect(p.scripts.format).toBeUndefined();
  });

  test("--linter biome writes one config and both scripts", () => {
    expect(run(["app", "--linter", "biome", NG]).code).toBe(0);
    expect(existsSync(join(cwd, "app", "eslint.config.js"))).toBe(false);
    const config = readJson("app", "biome.json");
    expect(config.formatter.enabled).toBe(true);
    expect(config.linter.enabled).toBe(true);
    const p = pkg("app");
    expect(p.scripts.lint).toContain("biome");
    expect(p.scripts.format).toContain("biome");
    expect(p.devDependencies["@biomejs/biome"]).toBeTruthy();
  });

  test("--linter eslint writes the flat config, prettier and both scripts", () => {
    expect(run(["app", "--linter", "eslint", NG]).code).toBe(0);
    expect(existsSync(join(cwd, "app", "biome.json"))).toBe(false);
    const config = readFileSync(join(cwd, "app", "eslint.config.js"), "utf8");
    expect(config).toContain("typescript-eslint");
    expect(config).toContain("eslint-config-prettier");
    expect(readJson("app", ".prettierrc").printWidth).toBe(100);
    const p = pkg("app");
    expect(p.scripts.lint).toContain("eslint");
    expect(p.scripts.format).toContain("prettier");
    for (const d of ["eslint", "@eslint/js", "typescript-eslint", "prettier", "eslint-config-prettier"]) {
      expect(p.devDependencies[d]).toBeTruthy();
    }
  });

  test("--no-linter and --linter none agree", () => {
    run(["a", "--no-linter", NG]);
    run(["b", "--linter", "none", NG]);
    for (const app of ["a", "b"]) {
      expect(existsSync(join(cwd, app, "biome.json"))).toBe(false);
      expect(pkg(app).scripts.lint).toBeUndefined();
    }
  });

  test("eslint+prettier is accepted as a flag value", () => {
    expect(run(["app", "--linter", "eslint+prettier", NG]).code).toBe(0);
    expect(existsSync(join(cwd, "app", "eslint.config.js"))).toBe(true);
  });

  test("--linter=x is the same flag", () => {
    expect(run(["app", "--linter=biome", NG]).code).toBe(0);
    expect(existsSync(join(cwd, "app", "biome.json"))).toBe(true);
  });

  test("an unknown linter is refused by name before anything is written", () => {
    const { code, out } = run(["app", "--linter", "standard", NG]);
    expect(code).toBe(1);
    expect(out).toContain("standard");
    expect(out).toContain("biome");
    expect(existsSync(join(cwd, "app"))).toBe(false);
  });

  test("the linter choice does not disturb the borgo scripts", () => {
    run(["app", "--linter", "biome", "--tailwind", NG]);
    const p = pkg("app");
    expect(p.scripts.dev).toContain("borgo dev");
    expect(p.scripts.dev).toContain("--tailwind");
    expect(p.scripts.build).toContain("borgo build");
  });
});

describe("--yes", () => {
  test("takes every default without asking, even on a prompt-capable stdin", () => {
    // BORGO_FORCE_PROMPT makes the cli believe it can ask; --yes must mean it
    // never opens stdin, or a run with nothing to read would hang forever
    const { code, out } = run(["app", "--yes"], { BORGO_FORCE_PROMPT: "1" });
    expect(code).toBe(0);
    expect(out).toContain("created app/");
    // the documented defaults
    expect(existsSync(join(cwd, "app", "islands"))).toBe(true); // base
    expect(existsSync(join(cwd, "app", "style.scss"))).toBe(true); // no tailwind
    expect(existsSync(join(cwd, "app", "Dockerfile"))).toBe(true); // docker
    expect(existsSync(join(cwd, "app", ".vscode"))).toBe(true); // vscode
    expect(existsSync(join(cwd, "app", ".git"))).toBe(true); // git
    expect(existsSync(join(cwd, "app", "biome.json"))).toBe(false); // no linter
  });

  test("-y is the same flag", () => {
    expect(run(["app", "-y", NG], { BORGO_FORCE_PROMPT: "1" }).code).toBe(0);
    expect(existsSync(join(cwd, "app", "package.json"))).toBe(true);
  });

  test("explicit flags still win over the defaults --yes would take", () => {
    const { code } = run(["app", "--yes", "--no-docker", "--linter", "biome", NG], {
      BORGO_FORCE_PROMPT: "1",
    });
    expect(code).toBe(0);
    expect(existsSync(join(cwd, "app", "Dockerfile"))).toBe(false);
    expect(existsSync(join(cwd, "app", "biome.json"))).toBe(true);
  });
});

describe("the scaffolded tree", () => {
  test("dotfiles npm would have stripped are restored", () => {
    run(["app", NG]);
    expect(existsSync(join(cwd, "app", ".gitignore"))).toBe(true);
    expect(existsSync(join(cwd, "app", ".dockerignore"))).toBe(true);
    expect(existsSync(join(cwd, "app", ".borgo", "api-types.d.ts"))).toBe(true);
    // and their shipped names are gone
    expect(existsSync(join(cwd, "app", "gitignore"))).toBe(false);
    expect(existsSync(join(cwd, "app", "_borgo"))).toBe(false);
  });

  // "everywhere" is the scan below; this one names the files worth reading in a
  // failure
  test("the app name reaches package.json, go.mod, main.go and a nested layout", () => {
    run(["my-notes", "--template", "full", NG]);
    expect(pkg("my-notes").name).toBe("my-notes");
    expect(readFileSync(join(cwd, "my-notes", "go.mod"), "utf8")).toContain("module my-notes");
    expect(readFileSync(join(cwd, "my-notes", "main.go"), "utf8")).toContain('"my-notes/api"');
    // deeper than the root: the full template names itself in its layout
    const layout = readFileSync(join(cwd, "my-notes", "pages", "_layout.tsx"), "utf8");
    expect(layout).toContain("my-notes");
    expect(layout).not.toContain("{{name}}");
  });

  // dot: true, or the scan skips .gitignore, .dockerignore, .env, .vscode/
  // and all of .borgo/
  test("no placeholder survives anywhere in the tree", async () => {
    let deepest = 0;
    for (const template of ["minimal", "base", "full"] as const) {
      const app = `ph-${template}`;
      run([app, "--template", template, "--tailwind", "--linter", "biome", NG]);
      const seen: string[] = [];
      const glob = new Bun.Glob("**/*");
      for await (const entry of glob.scan({ cwd: join(cwd, app), dot: true, onlyFiles: true })) {
        if (entry.endsWith(".svg")) continue;
        // scan yields backslashes on windows: unnormalized, the depth count
        // reads 1 everywhere, and a dot entry nested under a plain directory is
        // caught on linux and missed here
        const rel = entry.replaceAll("\\", "/");
        seen.push(rel);
        deepest = Math.max(deepest, rel.split("/").length);
        const text = readFileSync(join(cwd, app, entry), "utf8");
        expect(`${rel}: ${text.includes("{{name}}") || text.includes("{{version}}")}`).toBe(
          `${rel}: false`,
        );
      }
      // a scan that stopped seeing dot paths would go green over them in silence
      expect(seen.filter((rel) => rel.split("/").some((part) => part.startsWith(".")))).not.toEqual(
        [],
      );
    }
    // base, the default, is the only template with a depth-3 file: stamping
    // that stops short of it passes on the other two
    expect(deepest).toBeGreaterThanOrEqual(3);
  }, 60_000);

  test("the framework dependency is pinned to this scaffolder's version", () => {
    run(["app", NG]);
    const version = JSON.parse(
      readFileSync(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8"),
    ).version as string;
    expect(pkg("app").dependencies["borgo-framework"]).toBe(`^${version}`);
  });

  test("tsconfig includes the generated types explicitly", () => {
    run(["app", NG]);
    const tsconfig = readFileSync(join(cwd, "app", "tsconfig.json"), "utf8");
    expect(tsconfig).toContain(".borgo/api-types.d.ts");
  });

  test("package.json stays valid json through every rewrite", () => {
    run(["app", "--template", "full", "--tailwind", "--linter", "eslint", NG]);
    const p = pkg("app");
    expect(p.name).toBe("app");
    expect(p.scripts.dev).toContain("--tailwind");
    expect(p.scripts.lint).toBe("eslint .");
    expect(p.dependencies["borgo-framework"]).toBeTruthy();
  });
});

// A COMMAND THE README ADVERTISES HAS TO BE ABLE TO RUN.
//
// Every template lists `bun run export` in its Commands section and ships the
// script. `borgo export` exits 1 with "nothing is exportable" unless at least
// one routed page is exportable, and the minimal template - one page, with a
// loader and no `prerender` - had none: a quarter of all scaffolds shipped a
// documented command whose only possible outcome was a non-zero exit.
//
// The pages are IMPORTED here, never read as text. A regex over the source
// cannot tell `export const prerender = true` from the same characters inside a
// comment or a string, and a test in this repository once asserted a string
// that matched only a commented-out line.
describe("the export script every template advertises", () => {
  const framework = fileURLToPath(new URL("../../borgo", import.meta.url));
  // wherever the install layout put them, rather than a guessed node_modules path
  const packageDir = (name: string) => dirname(Bun.resolveSync(name, framework));

  // a scaffolded app resolves these only after `bun install`, and the pages
  // cannot be imported without them. Linked rather than installed: rmSync
  // unlinks a junction instead of following it, so the afterEach cleanup can
  // never reach into the repository these point at.
  const linkDeps = (app: string) => {
    const nm = join(cwd, app, "node_modules");
    mkdirSync(nm, { recursive: true });
    const type = process.platform === "win32" ? "junction" : "dir";
    symlinkSync(framework, join(nm, "borgo-framework"), type);
    symlinkSync(packageDir("react"), join(nm, "react"), type);
    symlinkSync(packageDir("react-dom"), join(nm, "react-dom"), type);
  };

  type PageModule = { loader?: unknown; prerender?: unknown; prerenderPaths?: unknown };

  // exactly the partition planExport() makes in packages/borgo/src/export.ts:
  // exportable is "no loader, or prerender === true", and a dynamic route also
  // has to list its param sets
  const exportablePages = async (app: string) => {
    const dir = join(cwd, app, "pages");
    const exportable: string[] = [];
    for (const entry of new Bun.Glob("**/*.tsx").scanSync({ cwd: dir })) {
      const rel = entry.replaceAll("\\", "/");
      // a "_" prefix is never routed, so it is never exported either
      if (rel.split("/").some((part) => part.startsWith("_"))) continue;
      const page = (await import(pathToFileURL(join(dir, entry)).href)) as PageModule;
      const dynamic = rel.includes("[");
      if (page.loader && page.prerender !== true) continue;
      if (dynamic && typeof page.prerenderPaths !== "function") continue;
      exportable.push(rel);
    }
    return exportable;
  };

  for (const template of ["minimal", "base", "full"] as const) {
    test(`${template} advertises export and ships a page export can prerender`, async () => {
      expect(run([template, "--template", template, NG]).code).toBe(0);
      linkDeps(template);
      // the promise, in both places it is made
      expect(pkg(template).scripts.export).toContain("borgo export");
      expect(readFileSync(join(cwd, template, "README.md"), "utf8")).toContain("bun run export");
      // and the pages that make it good. an empty list here is the exact
      // condition behind "nothing is exportable", exit 1
      expect(`${template}: ${(await exportablePages(template)).length > 0}`).toBe(`${template}: true`);
    }, 60_000);
  }

  // minimal has one page and that page has a loader, so it can only be
  // exportable by opting in - there is no second page to carry the export
  test("minimal's only page opts in, because its loader would otherwise skip it", async () => {
    run(["app", "--template", "minimal", NG]);
    linkDeps("app");
    const page = (await import(
      pathToFileURL(join(cwd, "app", "pages", "index.tsx")).href
    )) as PageModule;
    expect(typeof page.loader).toBe("function");
    expect(page.prerender).toBe(true);
    expect(await exportablePages("app")).toEqual(["index.tsx"]);
  }, 60_000);
});

// WHAT IS ALWAYS TRUE MUST NOT LIVE IN A SECTION A FLAG DELETES.
//
// --no-docker removes the whole `## Deploy` section, and the paragraph naming
// the generated SESSION_SECRET lived inside it - so `-t full --no-docker`
// documented the key in no file at all, while the key is what the app needs to
// serve a single request, in dev as much as on a server. It now lives under
// Setup, which no flag touches; only the compose-specific half stayed behind.
describe("the readme keeps what no flag can make untrue", () => {
  const readme = (app: string) => readFileSync(join(cwd, app, "README.md"), "utf8");

  const combos = [
    [],
    ["--no-docker"],
    ["--no-docker", "--tailwind"],
    ["--no-docker", "--no-vscode", "--linter", "biome"],
    ["--tailwind"],
    ["--no-docker", "--no-tailwind", "--no-vscode", "--no-linter"],
  ];
  for (const [i, flags] of combos.entries()) {
    test(`full documents its signing key with [${flags.join(" ")}]`, () => {
      const app = `full-${i}`;
      expect(run([app, "--template", "full", ...flags, NG]).code).toBe(0);
      const text = readme(app);
      expect(`${app}: ${text.includes("SESSION_SECRET")}`).toBe(`${app}: true`);
      expect(text).toContain(".env");
      // the consequence, not only the name: a key that exists in one gitignored
      // file is a key the operator loses on the first deploy unless told
      expect(text).toContain("copying to the server");
      // and the file really does hold the key the readme is describing
      expect(readFileSync(join(cwd, app, ".env"), "utf8")).toContain("SESSION_SECRET=");
    });
  }

  test("the key survives the very cut that hid it: no Deploy section, still documented", () => {
    run(["app", "--template", "full", "--no-docker", NG]);
    const text = readme("app");
    expect(text).not.toContain("## Deploy");
    expect(text).not.toContain("docker compose up");
    expect(text).toContain("SESSION_SECRET");
    // it is above Commands, in the section every flag combination keeps
    expect(text.indexOf("SESSION_SECRET")).toBeLessThan(text.indexOf("## Commands"));
  });

  // the other thing the same cut used to take with it: how to deploy without
  // docker at all, which is precisely what a --no-docker scaffold needs
  test("every template keeps its deploy guide when docker goes", () => {
    for (const template of ["minimal", "base", "full"] as const) {
      const app = `dep-${template}`;
      run([app, "--template", template, "--no-docker", NG]);
      const text = readme(app);
      expect(`${app}: ${text.includes("docs/deploy.md")}`).toBe(`${app}: true`);
      expect(text).not.toContain("## Deploy");
    }
  }, 30_000);
});

// TWO SPELLINGS OF ONE FLAG, ONE BEHAVIOUR.
//
// `--template=` protested about an empty value and `--template` did not:
// args[++i] past the end of the arguments is undefined, which read as "the flag
// was never passed" and fell through to the default. So the user typed a flag,
// got a template they did not ask for, and was told nothing. A flag the user
// wrote is never ignored - and the flag AFTER a valueless one is still a flag,
// not the value that was missing.
describe("a flag written without a value", () => {
  for (const [flag, twin, noun] of [
    ["--template", "--template=", "template"],
    ["-t", "--template=", "template"],
    ["--linter", "--linter=", "linter"],
  ] as const) {
    test(`${flag} with nothing after it is refused exactly as ${twin} is`, () => {
      const spaced = run(["app", flag]);
      const equals = run(["app", twin]);
      expect(spaced.code).toBe(1);
      expect(equals.code).toBe(1);
      // the same words, not merely the same exit code
      expect(spaced.out).toBe(equals.out);
      expect(spaced.out).toContain(`unknown ${noun} ""`);
      // and the default it used to take silently is never reached
      expect(existsSync(join(cwd, "app"))).toBe(false);
    });
  }

  test("an explicitly empty value is refused too", () => {
    expect(run(["app", "--template", ""]).code).toBe(1);
    expect(existsSync(join(cwd, "app"))).toBe(false);
    expect(run(["b", "--linter", ""]).code).toBe(1);
    expect(existsSync(join(cwd, "b"))).toBe(false);
  });

  // the flag that follows must survive as a flag: swallowed as a value it is a
  // flag the user typed and the run discarded
  test("the next flag is not eaten as the value that was missing", () => {
    const { code, out } = run(["app", "--template", "--turbo"]);
    expect(code).toBe(1);
    expect(out).toContain(`unknown argument "--turbo"`);
    expect(out).not.toContain("unknown template");
  });

  test("`--` is not a value either", () => {
    const { code, out } = run(["app", "--template", "--"]);
    expect(code).toBe(1);
    expect(out).toContain(`unknown argument "--"`);
  });

  test("a known flag after a valueless one is read as itself", () => {
    const { code, out } = run(["app", "--template", "--no-git"]);
    expect(code).toBe(1);
    // the message is about the missing value, and names no flag: --no-git was
    // parsed as the flag it is rather than becoming a template name
    expect(out).toContain(`unknown template ""`);
    expect(out).not.toContain("--no-git");
  });

  test("a repeated flag takes the last value written", () => {
    expect(run(["app", "--template", "minimal", "--template", "full", NG]).code).toBe(0);
    expect(existsSync(join(cwd, "app", "pages", "login.tsx"))).toBe(true);
    expect(existsSync(join(cwd, "app", "islands"))).toBe(false);
  });

  test("a second, valueless spelling does not inherit the first value", () => {
    const { code, out } = run(["app", "--template", "full", "--template"]);
    expect(code).toBe(1);
    expect(out).toContain(`unknown template ""`);
    expect(existsSync(join(cwd, "app"))).toBe(false);
  });

  test("a value that does not exist is still refused by name", () => {
    const { code, out } = run(["app", "--linter", "standard"]);
    expect(code).toBe(1);
    expect(out).toContain("standard");
  });

  // the whole property in one line: no flag written without a value ever
  // produces a scaffold
  test("nothing is scaffolded on a default the user never asked for", () => {
    for (const [i, flag] of ["--template", "-t", "--linter"].entries()) {
      const app = `app-${i}`;
      expect(run([app, flag]).code).toBe(1);
      expect(`${flag}: ${existsSync(join(cwd, app))}`).toBe(`${flag}: false`);
    }
  });
});

describe("refusals", () => {
  test("an invalid project name is rejected before anything is written", () => {
    const { code, out } = run(["Not Valid"]);
    expect(code).toBe(1);
    expect(out).toContain("invalid project name");
  });

  test("a non-empty directory is never overwritten", () => {
    mkdirSync(join(cwd, "app"));
    writeFileSync(join(cwd, "app", "keep.txt"), "mine");
    const { code, out } = run(["app", NG]);
    expect(code).toBe(1);
    expect(out).toContain("already exists");
    expect(readFileSync(join(cwd, "app", "keep.txt"), "utf8")).toBe("mine");
  });

  test("an unknown flag stops the run", () => {
    const { code, out } = run(["app", "--turbo"]);
    expect(code).toBe(1);
    expect(out).toContain("--turbo");
    expect(existsSync(join(cwd, "app"))).toBe(false);
  });

  test("--help describes every question and exits 0", () => {
    const { code, out } = run(["--help"]);
    expect(code).toBe(0);
    for (const flag of [
      "--template",
      "--tailwind",
      "--git",
      "--docker",
      "--vscode",
      "--linter",
      "--yes",
    ]) {
      expect(out).toContain(flag);
    }
    // the negative twins are documented too
    for (const flag of ["--no-tailwind", "--no-git", "--no-docker", "--no-vscode", "--no-linter"]) {
      expect(out).toContain(flag);
    }
    for (const t of ["minimal", "base", "full"]) expect(out).toContain(t);
    for (const l of ["biome", "eslint", "none"]) expect(out).toContain(l);
  });
});

describe("what the user is told", () => {
  test("the summary names the stack it built", () => {
    const plain = run(["a", "--template", "full", NG]).out;
    expect(plain).toContain("created a/");
    expect(plain).toContain("full");
    expect(plain).not.toContain("tailwind");

    const tw = run(["b", "--template", "base", "--tailwind", NG]).out;
    expect(tw).toContain("tailwind");
    expect(tw).toContain("style.css");
  });

  test("the summary reports what was actually created, not what was asked", () => {
    const on = run(["a", "--linter", "biome"]).out;
    expect(on).toContain("initial commit");
    expect(on).toContain("Dockerfile");
    expect(on).toContain("extensions.json");
    expect(on).toContain("biome");

    const off = run(["b", "--no-git", "--no-docker", "--no-vscode", "--no-linter"]).out;
    expect(off).toContain("no docker files");
    expect(off).toContain("no editor config");
    expect(off).not.toContain("Dockerfile");
    expect(off).not.toContain("initial commit");
  });

  test("the next steps are the commands that actually work", () => {
    const { out } = run(["app", NG]);
    expect(out).toContain("cd app");
    expect(out).toContain("bun install");
    expect(out).toContain("go mod tidy");
    expect(out).toContain("bun run dev");
    expect(out).toContain("http://localhost:3000");
  });

  test("the banner appears once", () => {
    const { out } = run(["app", NG]);
    expect(out.split("create-borgo").length - 1).toBe(1);
  });
});

describe("the process ends", () => {
  // a tty never sends EOF: if the prompt iterator is left open the summary
  // prints and the process just sits there until the user interrupts it.
  // stdin here is a pipe that stays open, which is the same trap.
  const interactive = async (answers: string) => {
    const proc = Bun.spawn(["bun", cli, "app"], {
      cwd,
      env: { ...process.env, ...IDENTITY, BORGO_FORCE_PROMPT: "1" } as Record<string, string>,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    proc.stdin.write(answers);
    proc.stdin.flush();
    const exited = await Promise.race([
      proc.exited,
      new Promise<"timeout">((r) => setTimeout(() => r("timeout"), 20_000)),
    ]);
    if (exited === "timeout") {
      proc.kill();
      throw new Error("the cli did not exit while stdin was still open");
    }
    return exited;
  };

  test("an interactive run exits on its own once every question is answered", async () => {
    // template, tailwind, linter, git, docker, vscode, install+start
    expect(await interactive("2\ny\n1\ny\ny\ny\nn\n")).toBe(0);
    expect(existsSync(join(cwd, "app"))).toBe(true);
  }, 30_000);

  test("the interactive answers are the tree that gets built", async () => {
    // minimal, tailwind, biome, no git, no docker, no vscode, no install
    expect(await interactive("2\ny\n1\nn\nn\nn\nn\n")).toBe(0);
    const app = join(cwd, "app");
    expect(existsSync(join(app, "islands"))).toBe(false); // minimal
    expect(existsSync(join(app, "style.css"))).toBe(true); // tailwind
    expect(existsSync(join(app, "biome.json"))).toBe(true); // biome
    expect(existsSync(join(app, ".git"))).toBe(false);
    expect(existsSync(join(app, "Dockerfile"))).toBe(false);
    expect(existsSync(join(app, ".vscode"))).toBe(false);
  }, 30_000);

  test("a bare enter at every question takes the documented defaults", async () => {
    expect(await interactive("\n\n\n\n\n\n\n")).toBe(0);
    const app = join(cwd, "app");
    expect(existsSync(join(app, "islands"))).toBe(true); // base
    expect(existsSync(join(app, "style.scss"))).toBe(true); // no tailwind
    expect(existsSync(join(app, "biome.json"))).toBe(false); // no linter
    expect(existsSync(join(app, ".git"))).toBe(true); // git
    expect(existsSync(join(app, "Dockerfile"))).toBe(true); // docker
    expect(existsSync(join(app, ".vscode"))).toBe(true); // vscode
    // enter is the terminal's default, and this is a pipe: nothing was
    // fetched and nothing was started, which is why the process could exit
    expect(existsSync(join(app, "node_modules"))).toBe(false);
  }, 30_000);
});

// INSTALLING AND STARTING.
//
// The scaffolder can carry a user all the way to a running dev server, which is
// the whole point of an entry point - but only when a human is there. A scaffold
// step in CI that ends with a server that never exits is a hung pipeline, so the
// default is on in a terminal and off everywhere else, and every test here runs
// without one.
//
// The toolchain cases use withoutToolchain: a PATH holding neither git, go nor
// bun. It is what `bunx create-borgo` meets on a machine where those were never
// installed, and Bun.spawnSync THROWS on a missing binary rather than returning
// a non-zero code, so an unguarded probe reaches the user as a stack trace.
describe("installing and starting", () => {
  test("the help documents both flags and which way they default", () => {
    const { out } = run(["--help"]);
    expect(out).toContain("--install");
    expect(out).toContain("--start");
    expect(out).toContain("--no-install");
    expect(out).toContain("--no-start");
    // the asymmetry is the part a reader has to be told, not guess
    expect(out).toMatch(/default[^\n]*ON in a terminal and OFF everywhere else/i);
  });

  test("without a terminal nothing is fetched and nothing is started", () => {
    const { code, out } = run(["app", NG]);
    expect(code).toBe(0);
    expect(existsSync(join(cwd, "app", "node_modules"))).toBe(false);
    // it has to say what it did not do, or the user waits for a server
    expect(out).toContain("bun install");
    expect(out).toContain("go mod tidy");
    expect(out).toContain("bun run dev");
  });


  // "go is not on PATH" is a fix a user can act on: install go. It is the wrong
  // fix for a go that is installed and exits non-zero - a broken toolchain, a
  // wrapper that refuses, a GOROOT that moved - and sends them to a download
  // page that will not help. The probe here is a real executable that really
  // runs and really fails, not a missing one.
  test.if(process.platform === "win32")(
    "a go that runs and fails is not reported as a go that is missing",
    () => {
      const dir = join(cwd, ".broken-go");
      mkdirSync(dir, { recursive: true });
      // where.exe exits 1 when it finds nothing, so `go version` here is an
      // installed binary that answers with a failure
      cpSync(
        join(process.env.SystemRoot ?? "C:\\Windows", "System32", "where.exe"),
        join(dir, "go.exe"),
      );
      const { code, out } = withoutToolchain(["app", "--install", "--no-start"], {
        PATH: dir,
        Path: dir,
      });
      expect(out).toContain("go version exited 1");
      expect(out).not.toContain("go is not on PATH");
      // the scaffold is still on disk and the run still ended
      expect(existsSync(join(cwd, "app", "package.json"))).toBe(true);
      expect(code).toBe(1);
    },
  );

  test("--install reports a missing go toolchain instead of throwing", () => {
    const { code, out } = withoutToolchain(["app", "--install", "--no-start"]);
    expect(out).toContain("go is not on PATH");
    expect(out).toContain("go.dev/dl");
    // the failure is reported as a step, not as an unhandled exception
    expect(out).not.toContain("error:");
    expect(out).not.toMatch(/\bat <anonymous>/);
    // and the scaffold survives: the tree is on disk, only the setup failed
    expect(existsSync(join(cwd, "app", "package.json"))).toBe(true);
    expect(code).toBe(1);
  });

  test("a failed setup leaves the exact commands still to run", () => {
    const { out } = withoutToolchain(["app", "--install", "--no-start"]);
    const steps = out.slice(out.indexOf("next steps"));
    expect(steps).toContain("cd app");
    expect(steps).toContain("bun install");
    expect(steps).toMatch(/install go 1\.25\+/);
  });

  test("--start carries its own install rather than starting on an empty tree", () => {
    // proof it tried: with no toolchain the install step is reached and fails.
    // a plain run in the same environment exits 0 without touching either.
    expect(withoutToolchain(["app", "--start"]).code).toBe(1);
    rmSync(join(cwd, "app"), { recursive: true, force: true });
    expect(withoutToolchain(["app"]).code).toBe(0);
  });

  // AN EXPLICIT FLAG NEVER PRODUCES A QUESTION.
  //
  // The install/start question was asked before --no-install was consulted, and
  // the answer was then discarded: `install ??= answer` kept the false the flag
  // had already set, and without an install the run prints the manual steps and
  // exits before `start` is ever looked at. So a user who had already typed the
  // flag was asked anyway, and whatever they answered changed nothing.
  //
  // stdin stays open here on purpose. A question nobody answers blocks on a
  // pipe with nothing left in it, so an extra question is a hang and not a
  // wrong assertion - which is the only way to prove a question was NOT asked.
  const prompted = async (args: string[], answers: string, env: Record<string, string> = {}) => {
    const proc = Bun.spawn([process.execPath, cli, ...args], {
      cwd,
      env: { ...process.env, ...IDENTITY, BORGO_FORCE_PROMPT: "1", ...env } as Record<string, string>,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    proc.stdin.write(answers);
    proc.stdin.flush();
    const finished = await Promise.race([
      (async () => {
        const [out, err] = await Promise.all([
          new Response(proc.stdout).text(),
          new Response(proc.stderr).text(),
        ]);
        return { code: await proc.exited, out: out + err };
      })(),
      new Promise<"timeout">((r) => setTimeout(() => r("timeout"), 20_000)),
    ]);
    if (finished === "timeout") {
      proc.kill();
      throw new Error("the cli asked a question the flags had already answered");
    }
    return finished;
  };

  // template, tailwind, linter, git, docker, vscode - and nothing after them
  const SIX_ANSWERS = "2\nn\n3\nn\nn\nn\n";

  test("--no-install asks nothing about installing, and reads no answer for it", async () => {
    const { code, out } = await prompted(["app", "--no-install"], SIX_ANSWERS);
    expect(code).toBe(0);
    // the question that used to be asked and thrown away
    expect(out).not.toContain("install dependencies and start");
    expect(out).not.toContain("install dependencies (");
    // and the flag still means what it says
    expect(existsSync(join(cwd, "app", "node_modules"))).toBe(false);
    expect(existsSync(join(cwd, "app", "package.json"))).toBe(true);
    expect(out).toContain("next steps");
  }, 40_000);

  test("--no-install with --start still asks nothing: both halves are written", async () => {
    const { code, out } = await prompted(["app", "--no-install", "--start"], SIX_ANSWERS);
    expect(code).toBe(0);
    expect(out).not.toContain("install dependencies");
    expect(existsSync(join(cwd, "app", "node_modules"))).toBe(false);
  }, 40_000);

  // the half that is still open is a fair question, and it names only itself
  test("--install asks about the dev server alone, not about installing again", async () => {
    const empty = join(cwd, ".no-tools");
    mkdirSync(empty, { recursive: true });
    // seven answers: the six above plus the start question this run may ask
    const { out } = await prompted(["app", "--install"], `${SIX_ANSWERS}n\n`, {
      PATH: empty,
      Path: empty,
    });
    expect(out).toContain("start the dev server");
    expect(out).not.toContain("install dependencies and start");
    expect(out).not.toContain("install dependencies (");
  }, 40_000);

  test("the last of --install and --no-install wins, and only it decides", async () => {
    // --install last: installing is settled, starting is still open
    const on = await prompted(["a", "--no-install", "--install"], `${SIX_ANSWERS}n\n`, {
      PATH: join(cwd, ".no-tools"),
      Path: join(cwd, ".no-tools"),
    });
    expect(on.out).toContain("start the dev server");
    expect(on.out).not.toContain("install dependencies and start");

    // --no-install last: nothing is open, so nothing is asked
    const off = await prompted(["b", "--install", "--no-install"], SIX_ANSWERS);
    expect(off.code).toBe(0);
    expect(off.out).not.toContain("install dependencies");
    expect(existsSync(join(cwd, "b", "node_modules"))).toBe(false);
  }, 60_000);

  test("outside a terminal --no-install is silent about it and still exits 0", () => {
    const { code, out } = run(["app", "--no-install", NG]);
    expect(code).toBe(0);
    expect(out).not.toContain("install dependencies");
    expect(existsSync(join(cwd, "app", "node_modules"))).toBe(false);
  });

  test("--no-install cancels a --start in either order", () => {
    for (const args of [
      ["--no-install", "--start"],
      ["--start", "--no-install"],
    ]) {
      const { code, out } = withoutToolchain(["app", ...args]);
      expect(code).toBe(0);
      expect(out).toContain("bun install");
      expect(existsSync(join(cwd, "app", "node_modules"))).toBe(false);
      rmSync(join(cwd, "app"), { recursive: true, force: true });
    }
  });
});

// THE SIGNING KEY, AND THE FILE IT LIVES IN.
//
// session.go refuses a SESSION_SECRET shorter than 32 bytes outright - it will
// not boot, because a key that short is not a weaker secret but a searchable
// one, exhaustible offline from a single captured cookie. So the nine bytes of
// `SESSION_SECRET=change-me` were never a placeholder to fill in later: they
// were a generated app that could not start, and a generated deploy config that
// could not start the app it was written for.
//
// The two shortcuts that look easier are both worse: a literal in main.go is the
// same key in every app anyone scaffolds, and one derived from the project name
// is public - the title, the repo and the hostname all carry it - so anyone can
// compute the HMAC and mint a session as anybody.
const SESSION_SECRET_MIN = 32;
const SECRET_ASSIGNMENT = /SESSION_SECRET[=:]\s*["']?([^"'\s,}]*)/g;

describe("the generated signing key", () => {
  test("the full template writes a real one into .env", () => {
    run(["app", "--template", "full", NG]);
    const env = readFileSync(join(cwd, "app", ".env"), "utf8");
    const value = env.match(/^SESSION_SECRET=(.*)$/m)?.[1];
    expect(value).toBeDefined();
    expect(value!.length).toBeGreaterThanOrEqual(SESSION_SECRET_MIN);
    // base64url out of the CSPRNG: safe unquoted on a systemd Environment= line
    expect(value!).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  test("it is unique per app, not a constant and not derived from the name", () => {
    run(["one", "--template", "full", NG]);
    run(["two", "--template", "full", NG]);
    const read = (app: string) =>
      readFileSync(join(cwd, app, ".env"), "utf8").match(/^SESSION_SECRET=(.*)$/m)![1];
    const a = read("one");
    const b = read("two");
    expect(a).not.toBe(b);
    // nothing public may appear in it
    for (const value of [a, b]) {
      expect(value.toLowerCase()).not.toContain("one");
      expect(value.toLowerCase()).not.toContain("two");
      expect(value.toLowerCase()).not.toContain("borgo");
    }
  });

  // the scan, not a spot check: every generated file of every template, so a
  // placeholder reintroduced anywhere fails here rather than at someone's boot
  test("no generated file anywhere assigns a secret too short to boot with", () => {
    for (const template of ["minimal", "base", "full"] as const) {
      const app = `app-${template}`;
      run([app, "--template", template, NG]);
      const root = join(cwd, app);
      const files = [...new Bun.Glob("**/*").scanSync({ cwd: root, dot: true, onlyFiles: true })];
      expect(files.length).toBeGreaterThan(0);
      for (const rel of files) {
        let text: string;
        try {
          text = readFileSync(join(root, rel), "utf8");
        } catch {
          continue;
        }
        for (const [, value] of text.matchAll(SECRET_ASSIGNMENT)) {
          // `${SESSION_SECRET}`-style references and :?error forms name the
          // variable rather than assigning a value to it
          if (value.startsWith("$") || value === "") continue;
          // the file and the value ride in the message: a failure here has to
          // name what to go and look at
          expect(`${rel}: ${value}`.length).toBeGreaterThanOrEqual(
            rel.length + 2 + SESSION_SECRET_MIN,
          );
        }
      }
    }
  }, 60_000);

  // a key in a file git will commit is a key in the repository history, and the
  // .env is the only place it exists
  test(".env is gitignored by every template, and never committed", () => {
    for (const template of ["minimal", "base", "full"] as const) {
      const app = `ig-${template}`;
      run([app, "--template", template, NG]);
      expect(readFileSync(join(cwd, app, ".gitignore"), "utf8").split("\n")).toContain(".env");
    }
    // and with git on, the initial commit really does leave it out
    run(["committed", "--template", "full"]);
    expect(existsSync(join(cwd, "committed", ".env"))).toBe(true);
    const tracked = git("committed", "ls-files").out.split("\n");
    expect(tracked).not.toContain(".env");
    expect(tracked).toContain(".gitignore");
  }, 60_000);

  // a key that exists in exactly one gitignored file is a key the operator will
  // lose on the first deploy unless something says so, and losing it logs every
  // user out
  test("the summary tells the user the file exists and must travel", () => {
    const { out } = run(["app", "--template", "full", NG]);
    expect(out).toContain(".env");
    expect(out).toContain("SESSION_SECRET");
    // the consequence, not just the filename
    expect(out.toLowerCase()).toContain("copy it to the server");
  });

  // only the template that actually has sessions
  test("a template without auth is not given a key it does not use", () => {
    run(["minimal-app", "--template", "minimal", NG]);
    expect(existsSync(join(cwd, "minimal-app", ".env"))).toBe(false);
  });
});
