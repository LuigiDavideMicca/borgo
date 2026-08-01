import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

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
      expect(p.scripts.dev).toContain("--tailwind");
      expect(p.scripts.build).toContain("--tailwind");
      expect(p.scripts.start).toContain("--tailwind");
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
  test("a scaffold is a repository with an initial commit by default", () => {
    expect(run(["app"]).code).toBe(0);
    expect(existsSync(join(cwd, "app", ".git"))).toBe(true);
    expect(git("app", "rev-list", "--count", "HEAD").out).toBe("1");
    expect(git("app", "log", "-1", "--pretty=%s").out).toBe("initial commit");
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

  test("a scaffold inside an existing repository is not nested in a second one", () => {
    Bun.spawnSync(["git", "-C", cwd, "init", "-q"], { stdout: "pipe", stderr: "pipe" });
    const { code, out } = run(["app"]);
    expect(code).toBe(0);
    expect(existsSync(join(cwd, "app", ".git"))).toBe(false);
    expect(out).toContain("already inside a repository");
  });

  test("a missing git identity does not fail the scaffold", () => {
    const { code, out } = run(["app"], {
      // no global/system config and no identity in the environment
      GIT_CONFIG_GLOBAL: join(cwd, "nonexistent-gitconfig"),
      GIT_CONFIG_SYSTEM: join(cwd, "nonexistent-gitconfig"),
      GIT_AUTHOR_NAME: undefined,
      GIT_AUTHOR_EMAIL: undefined,
      GIT_COMMITTER_NAME: undefined,
      GIT_COMMITTER_EMAIL: undefined,
    });
    expect(code).toBe(0);
    // the repository and the staged tree survive; only the commit is missing
    expect(existsSync(join(cwd, "app", ".git"))).toBe(true);
    expect(out).toContain("user.name");
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

  test("the app name is stamped everywhere it appears", () => {
    run(["my-notes", "--template", "full", NG]);
    expect(pkg("my-notes").name).toBe("my-notes");
    expect(readFileSync(join(cwd, "my-notes", "go.mod"), "utf8")).toContain("module my-notes");
    expect(readFileSync(join(cwd, "my-notes", "main.go"), "utf8")).toContain('"my-notes/api"');
    // deeper than the root: the full template names itself in its layout
    const layout = readFileSync(join(cwd, "my-notes", "pages", "_layout.tsx"), "utf8");
    expect(layout).toContain("my-notes");
    expect(layout).not.toContain("{{name}}");
  });

  test("no placeholder survives anywhere in the tree", async () => {
    run(["app", "--template", "full", "--tailwind", "--linter", "biome", NG]);
    const glob = new Bun.Glob("**/*");
    for await (const rel of glob.scan({ cwd: join(cwd, "app"), onlyFiles: true })) {
      if (rel.endsWith(".svg")) continue;
      const text = readFileSync(join(cwd, "app", rel), "utf8");
      expect(`${rel}: ${text.includes("{{name}}") || text.includes("{{version}}")}`).toBe(
        `${rel}: false`,
      );
    }
  });

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
    // template, tailwind, linter, git, docker, vscode
    expect(await interactive("2\ny\n1\ny\ny\ny\n")).toBe(0);
    expect(existsSync(join(cwd, "app"))).toBe(true);
  }, 30_000);

  test("the interactive answers are the tree that gets built", async () => {
    // minimal, tailwind, biome, no git, no docker, no vscode
    expect(await interactive("2\ny\n1\nn\nn\nn\n")).toBe(0);
    const app = join(cwd, "app");
    expect(existsSync(join(app, "islands"))).toBe(false); // minimal
    expect(existsSync(join(app, "style.css"))).toBe(true); // tailwind
    expect(existsSync(join(app, "biome.json"))).toBe(true); // biome
    expect(existsSync(join(app, ".git"))).toBe(false);
    expect(existsSync(join(app, "Dockerfile"))).toBe(false);
    expect(existsSync(join(app, ".vscode"))).toBe(false);
  }, 30_000);

  test("a bare enter at every question takes the documented defaults", async () => {
    expect(await interactive("\n\n\n\n\n\n")).toBe(0);
    const app = join(cwd, "app");
    expect(existsSync(join(app, "islands"))).toBe(true); // base
    expect(existsSync(join(app, "style.scss"))).toBe(true); // no tailwind
    expect(existsSync(join(app, "biome.json"))).toBe(false); // no linter
    expect(existsSync(join(app, ".git"))).toBe(true); // git
    expect(existsSync(join(app, "Dockerfile"))).toBe(true); // docker
    expect(existsSync(join(app, ".vscode"))).toBe(true); // vscode
  }, 30_000);
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
