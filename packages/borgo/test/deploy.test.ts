import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BODY_LIMIT,
  caddyfile,
  composeYml,
  COMMAND_FLAGS,
  deployInit,
  ensureIgnored,
  envFile,
  nginxConf,
  parseInitArgv,
  projectContext,
  SESSION_SECRET_MIN,
  systemdUnit,
  targets,
  unknownArg,
} from "../src/deploy";

const ctx = { name: "my-app", port: "3000", apiPort: "3501" };

const balanced = (s: string) => s.split("{").length === s.split("}").length;

const repoRoot = join(import.meta.dir, "../../..");

// deployInit prints; the matrix below runs it a hundred times
function quietly<T>(fn: () => T): { value: T; out: string } {
  const real = console.log;
  const lines: string[] = [];
  console.log = (...args: unknown[]) => void lines.push(args.join(" "));
  try {
    return { value: fn(), out: lines.join("\n") };
  } finally {
    console.log = real;
  }
}

// a project directory as `create-borgo` would leave one, on every axis that
// changes what `deploy init` writes (`--no-docker` writes neither docker artefact)
type Scaffold = {
  template: "base" | "full" | "minimal";
  port?: string;
  secret?: string;
  docker: boolean;
};

function scaffold({ template, port, secret, docker }: Scaffold): string {
  const dir = mkdtempSync(join(tmpdir(), "borgo-deploy-"));
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: `my-${template}` }));
  const env: string[] = [];
  if (port) env.push(`PORT=${port}`, `API_PORT=${Number(port) + 501}`);
  if (secret) env.push(`SESSION_SECRET=${secret}`);
  if (env.length) writeFileSync(join(dir, ".env"), `${env.join("\n")}\n`);
  if (docker) {
    writeFileSync(join(dir, "Dockerfile"), "FROM oven/bun:1.3-slim\n");
    writeFileSync(join(dir, ".dockerignore"), "node_modules\n.env\n");
  }
  writeFileSync(join(dir, ".gitignore"), "node_modules\n.env\n");
  return dir;
}

const MATRIX: Scaffold[] = (["base", "full", "minimal"] as const).flatMap((template) =>
  [undefined, "8080"].flatMap((port) =>
    [undefined, "S".repeat(48)].flatMap((secret) =>
      [true, false].map((docker) => ({ template, port, secret, docker })),
    ),
  ),
);

// every artefact of one scaffold, written by the command itself
function generated(spec: Scaffold): { dir: string; files: Record<string, string>; out: string } {
  const dir = scaffold(spec);
  const files: Record<string, string> = {};
  const { out } = quietly(() => {
    for (const [target, { file }] of Object.entries(targets)) {
      expect(deployInit(target, true, dir)).toBe(0);
      files[file] = readFileSync(join(dir, file), "utf8");
    }
  });
  return { dir, files, out };
}

// the binaries are never in the repo: point the variables at them. a test that
// cannot reach its tool says so and stops, it does not assert a weaker thing
function validator(envVar: string, exe: string): { path: string } | { skip: string } {
  const path = process.env[envVar] || Bun.which(exe);
  return path ? { path } : { skip: `${exe} not found - set ${envVar} to run this` };
}

// spawning somebody else's binary is not our 5s budget: `caddy adapt` ~10s cold
// behind antivirus, `docker compose config` 24-74s under 16 burners on 8 cores
// and past 120s twice in five runs, systemd-analyze through wsl 18-27s. a
// timeout here is the tool missing or wedged, never the config being wrong
const EXTERNAL_TOOL_TIMEOUT = 300_000;

// stdout kept apart from stderr: caddy logs to stderr even when it succeeds,
// and `caddy adapt`'s stdout is json that must parse on its own
async function run(cmd: string[], cwd?: string): Promise<{ code: number; out: string; text: string }> {
  const proc = Bun.spawn(cmd, { cwd, stdout: "pipe", stderr: "pipe" });
  const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  return { code: await proc.exited, out, text: `${out}${err}` };
}

type Analyzer = { run: (args: string[], unitPath: string) => Promise<{ text: string }> };

// systemd-analyze itself, or - on a machine that has no systemd but does have
// a distro that does - the same binary reached through wsl, with the unit
// copied across. Anything else is a skip with the reason.
function systemdAnalyze(): Analyzer | { skip: string } {
  const native = process.env.BORGO_TEST_SYSTEMD_ANALYZE || Bun.which("systemd-analyze");
  if (native) {
    return { run: async (args, unitPath) => ({ text: (await run([native, ...args, unitPath])).text }) };
  }
  const wsl = Bun.which("wsl");
  if (wsl && Bun.spawnSync([wsl, "-e", "sh", "-c", "command -v systemd-analyze"]).exitCode === 0) {
    return {
      run: async (args, unitPath) => {
        const script = `p=$(wslpath -a '${unitPath}') && cp "$p" /tmp/borgo-unit.service && chmod 644 /tmp/borgo-unit.service && systemd-analyze ${args.join(" ")} /tmp/borgo-unit.service 2>&1`;
        return { text: (await run([wsl, "-e", "sh", "-c", script])).text };
      },
    };
  }
  return { skip: "systemd-analyze not found (nor a wsl distro with it) - set BORGO_TEST_SYSTEMD_ANALYZE" };
}

describe("templates", () => {
  test("caddyfile proxies the front port with balanced braces", () => {
    const out = caddyfile(ctx);
    expect(out).toContain("reverse_proxy localhost:3000");
    expect(out).toContain("my-app");
    expect(balanced(out)).toBe(true);
  });

  test("nginx conf keeps websockets and sse working", () => {
    const out = nginxConf(ctx);
    expect(out).toContain("proxy_pass http://localhost:3000;");
    expect(out).toContain("proxy_set_header Upgrade $http_upgrade;");
    // Connection is set from the map above, so a plain request keeps the
    // upstream connection alive instead of being told to upgrade
    expect(out).toContain("proxy_set_header Connection $connection_upgrade;");
    expect(out).toContain("map $http_upgrade $connection_upgrade {");
    expect(out).toContain("proxy_buffering off;");
    expect(balanced(out)).toBe(true);
    // every directive inside a block ends with a semicolon
    for (const line of out.split("\n")) {
      const t = line.trim();
      if (!t || t.startsWith("#") || t.endsWith("{") || t === "}") continue;
      expect(t.endsWith(";")).toBe(true);
    }
  });

  // `nginx -t` hard-fails on `listen 443 ssl;` with no certificate directive
  test("nginx ships the certificate lines it tells you to set", () => {
    const out = nginxConf(ctx);
    expect(out).toContain("listen 443 ssl;");
    expect(out).toContain("ssl_certificate");
    expect(out).toContain("ssl_certificate_key");
    // commented, because a path that does not exist fails nginx -t just as
    // hard: uncommenting them is the one documented edit
    for (const directive of ["ssl_certificate ", "ssl_certificate_key"]) {
      const line = out.split("\n").find((l) => l.trim().replace(/^#\s*/, "").startsWith(directive))!;
      expect(line.trim().startsWith("#")).toBe(true);
      expect(line.trim()).toEndWith(";");
    }
    // and the file still says what to do with them
    expect(out).toContain("uncomment");
  });

  // the cap is a fact about borgo.Bind, so it is read from the Go source, not retyped
  test("both proxies cap the body where borgo.Bind does", () => {
    const go = readFileSync(join(repoRoot, "borgo.go"), "utf8");
    const shift = go.match(/^const bindLimit = 1 << (\d+)$/m)?.[1];
    expect(shift).toBeDefined();
    expect(2 ** Number(shift)).toBe(BODY_LIMIT);
    expect(BODY_LIMIT).toBe(1048576);

    // nginx: `m` is MiB, so 1m is exactly the Go limit
    const nginxCap = nginxConf(ctx).match(/^\s*client_max_body_size (\S+);$/m)?.[1];
    expect(nginxCap).toBe("1m");
    // caddy: `MB` would be 10^6 - `MiB` is the one that matches
    const caddyCap = caddyfile(ctx).match(/^\s*max_size (\S+)$/m)?.[1];
    expect(caddyCap).toBe("1MiB");
  });

  test("systemd unit carries the paths and env", () => {
    const out = systemdUnit(ctx);
    expect(out).toContain("[Unit]");
    expect(out).toContain("[Service]");
    expect(out).toContain("[Install]");
    expect(out).toContain("WorkingDirectory=/srv/my-app");
    expect(out).toContain("Environment=PORT=3000");
    expect(out).toContain("Environment=API_PORT=3501");
    expect(out).toContain("ExecStart=/usr/local/bin/bun run start");
  });

  // through the parser, not toContain: the file's commented half mentions
  // ports and volumes too
  test("compose maps the templated port, on both sides and in the environment", () => {
    const parsed = Bun.YAML.parse(composeYml({ ...ctx, port: "8080" })) as {
      services: { app: { ports: string[]; environment: Record<string, string>; restart: string } };
    };
    expect(parsed.services.app.ports).toEqual(["8080:8080"]);
    expect(parsed.services.app.environment.PORT).toBe("8080");
    expect(parsed.services.app.restart).toBe("unless-stopped");
  });

  // a YAML 1.1 resolver reads 22:22 as base-60; Bun's parser is 1.2 and returns
  // the same string quoted or not, so the quotes have to be asserted as text
  test("the port mapping is quoted, whatever the port", () => {
    for (const port of ["22", "8080"]) {
      expect(composeYml({ ...ctx, port })).toContain(`      - "${port}:${port}"`);
    }
  });

  // a volume the generator always writes is one whose permissions bite the
  // first app that uses it: the recipe is carried commented instead
  test("compose mounts no volume, and says exactly what adding one takes", () => {
    const out = composeYml(ctx);
    expect(out).toContain("DB_PATH: /data/app.db");
    expect(out).toContain("- data:/data");
    // every one of those lines is commented: the file as written must not
    // hand an app a database path, or a volume, it never asked for
    const persistence = /DB_PATH|data:\/data|^volumes:|^ {2}data:/;
    for (const line of out.split(String.fromCharCode(10))) {
      if (persistence.test(line)) expect(line.trimStart().startsWith("#")).toBe(true);
    }
  });

  test("compose is still valid yaml with the advice in it", () => {
    const parsed = Bun.YAML.parse(composeYml(ctx)) as {
      services: { app: { environment: Record<string, string>; volumes?: string[] } };
      volumes?: Record<string, unknown>;
    };
    expect(parsed.services.app.environment.BUN_CONFIG_MAX_HTTP_REQUESTS).toBe("16384");
    // commented out means absent to a parser, which is the point
    expect(parsed.services.app.volumes).toBeUndefined();
    expect(parsed.services.app.environment.DB_PATH).toBeUndefined();
    expect(parsed.volumes).toBeUndefined();
  });
});

describe("projectContext", () => {
  test("reads and sanitizes the package name", () => {
    const dir = mkdtempSync(join(tmpdir(), "borgo-deploy-"));
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "@scope/My App!" }));
    expect(projectContext(dir).name).toBe("scope-My-App");
  });

  test("falls back without a package.json", () => {
    const dir = mkdtempSync(join(tmpdir(), "borgo-deploy-"));
    expect(projectContext(dir).name).toBe("borgo-app");
  });
});

describe("deployInit", () => {
  test("writes the target file and reports it", () => {
    const dir = mkdtempSync(join(tmpdir(), "borgo-deploy-"));
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "demo" }));
    expect(deployInit("caddy", false, dir)).toBe(0);
    const written = readFileSync(join(dir, "Caddyfile"), "utf8");
    expect(written).toContain("reverse_proxy localhost:3000");
  });

  test("refuses to overwrite without --force", () => {
    const dir = mkdtempSync(join(tmpdir(), "borgo-deploy-"));
    writeFileSync(join(dir, "Caddyfile"), "mine");
    expect(deployInit("caddy", false, dir)).toBe(1);
    expect(readFileSync(join(dir, "Caddyfile"), "utf8")).toBe("mine");
    expect(deployInit("caddy", true, dir)).toBe(0);
    expect(readFileSync(join(dir, "Caddyfile"), "utf8")).toContain("reverse_proxy");
  });

  test("unknown or missing targets fail with usage", () => {
    const dir = mkdtempSync(join(tmpdir(), "borgo-deploy-"));
    expect(deployInit("k8s", false, dir)).toBe(1);
    expect(deployInit(undefined, false, dir)).toBe(1);
    expect(existsSync(join(dir, "Caddyfile"))).toBe(false);
  });

  test("every target writes its file", () => {
    const dir = mkdtempSync(join(tmpdir(), "borgo-deploy-"));
    for (const [target, file] of [
      ["caddy", "Caddyfile"],
      ["nginx", "site.conf"],
      ["systemd", "borgo.service"],
      ["compose", "docker-compose.yml"],
    ] as const) {
      expect(deployInit(target, false, dir)).toBe(0);
      expect(existsSync(join(dir, file))).toBe(true);
    }
  });
});

describe("the outbound request cap", () => {
  // bun reads BUN_CONFIG_MAX_HTTP_REQUESTS once, at process start, so only the
  // launcher can set it: every launch surface borgo writes has to carry it
  const carriesCap = (s: string) => /BUN_CONFIG_MAX_HTTP_REQUESTS[=:]\s*"?\d+/.test(s);

  test("the configs deploy init writes set it", () => {
    expect(carriesCap(systemdUnit(ctx))).toBe(true);
    expect(carriesCap(composeYml(ctx))).toBe(true);
    // caddy and nginx are reverse proxies in front of borgo, not launchers:
    // they have no process environment to set, and adding one would be noise
    expect(carriesCap(caddyfile(ctx))).toBe(false);
    expect(carriesCap(nginxConf(ctx))).toBe(false);
  });

  test("compose still parses, with the cap among the app's environment", () => {
    const parsed = Bun.YAML.parse(composeYml(ctx)) as {
      services: { app: { environment: Record<string, string> } };
    };
    expect(parsed.services.app.environment.BUN_CONFIG_MAX_HTTP_REQUESTS).toBe("16384");
  });

  test("every shipped Dockerfile sets it before the start command", () => {
    const dockerfiles = [
      "examples/tasks/Dockerfile",
      "packages/create-borgo/templates/base/Dockerfile",
      "packages/create-borgo/templates/full/Dockerfile",
      "packages/create-borgo/templates/minimal/Dockerfile",
    ];
    for (const path of dockerfiles) {
      const text = readFileSync(join(import.meta.dir, "../../..", path), "utf8");
      expect(carriesCap(text)).toBe(true);
      // an ENV after CMD would be dead weight: docker runs CMD with the
      // environment as it stood, so placement is part of the assertion
      expect(text.indexOf("BUN_CONFIG_MAX_HTTP_REQUESTS")).toBeLessThan(text.indexOf("CMD"));
    }
  });
});

// a cli that ignores an argument does the wrong thing and exits 0, which the
// operator cannot tell from the right thing
describe("argument refusals", () => {
  describe("parseInitArgv", () => {
    test("init alone, and init with a target, are accepted", () => {
      expect(parseInitArgv(["init"], 0)).toEqual({ ok: true, target: undefined, force: false });
      expect(parseInitArgv(["init", "nginx"], 1)).toEqual({ ok: true, target: "nginx", force: false });
      expect(parseInitArgv(["init", "--force"], 0)).toEqual({ ok: true, target: undefined, force: true });
    });

    test("--tailwind is global and legal after any command", () => {
      expect(parseInitArgv(["init", "--tailwind"], 0).ok).toBe(true);
    });

    // `argv.filter(a => !a.startsWith("--"))` would drop the flag and keep its value
    test("a flag's value is never mistaken for a positional", () => {
      expect(parseInitArgv(["init", "nginx", "--port", "8080"], 1)).toEqual({
        ok: false,
        reason: 'unknown option "--port"',
      });
      expect(parseInitArgv(["init", "--port", "8080", "nginx"], 1)).toEqual({
        ok: false,
        reason: 'unknown option "--port"',
      });
    });

    test("a missing or wrong subcommand is named, not guessed at", () => {
      expect(parseInitArgv([], 0)).toEqual({ ok: false, reason: "missing subcommand" });
      expect(parseInitArgv(["setup"], 0)).toEqual({ ok: false, reason: 'unknown subcommand "setup"' });
    });

    test("a surplus positional is refused by name", () => {
      expect(parseInitArgv(["init", "nginx", "caddy"], 1)).toEqual({
        ok: false,
        reason: 'unexpected argument "caddy"',
      });
      expect(parseInitArgv(["init", "nginx"], 0)).toEqual({
        ok: false,
        reason: 'unexpected argument "nginx"',
      });
    });
  });

  describe("unknownArg", () => {
    test("the commands take their own flags and the global one", () => {
      for (const command of Object.keys(COMMAND_FLAGS)) {
        expect(unknownArg(command, [])).toBeNull();
        expect(unknownArg(command, ["--tailwind"])).toBeNull();
      }
      expect(unknownArg("start", ["--front-only"])).toBeNull();
      expect(unknownArg("start", ["--front-only", "--tailwind"])).toBeNull();
    });

    // a flag borgo does not know is a flag its user believes is doing something
    test("a flag borgo does not know is refused, not ignored", () => {
      expect(unknownArg("start", ["--port", "4000"])).toBe('unknown option "--port"');
      expect(unknownArg("build", ["--minify"])).toBe('unknown option "--minify"');
      expect(unknownArg("dev", ["--tailwnid"])).toBe('unknown option "--tailwnid"');
      expect(unknownArg("export", ["--out", "site"])).toBe('unknown option "--out"');
      expect(unknownArg("doctor", ["--json"])).toBe('unknown option "--json"');
    });

    test("a stray positional is refused too", () => {
      expect(unknownArg("build", ["prod"])).toBe('unexpected argument "prod"');
      expect(unknownArg("start", ["8080"])).toBe('unexpected argument "8080"');
    });

    // --front-only is start's alone: on any other command it did nothing
    test("one command's flag is not another's", () => {
      expect(unknownArg("build", ["--front-only"])).toBe('unknown option "--front-only"');
      expect(unknownArg("dev", ["--front-only"])).toBe('unknown option "--front-only"');
    });

    // deploy and pwa have their own parser, and an unrecognised command is the
    // cli's default branch to answer with usage
    test("commands this does not own are left to their own parsers", () => {
      expect(unknownArg("deploy", ["init", "nginx"])).toBeNull();
      expect(unknownArg("pwa", ["init"])).toBeNull();
      expect(unknownArg("--help", [])).toBeNull();
      expect(unknownArg("nonsense", ["--whatever"])).toBeNull();
    });
  });

  // the refusal has to be reached before any command runs. the argv may be
  // filtered first (the globals the cli reads for itself), so what is asserted
  // is the call and its position, not one spelling of its argument
  test("the cli refuses before it dispatches", () => {
    const src = readFileSync(join(import.meta.dir, "../src/cli.ts"), "utf8");
    expect(src).toMatch(/unknownArg\(command, process\.argv\.slice\(3\)/);
    expect(src.indexOf("unknownArg(command")).toBeLessThan(src.indexOf("switch (command)"));
  });
});

// a unit file lands in the project directory, where `git add .` commits it and
// `docker build` bakes it into a layer: the key lives in .env, which the unit loads
describe("no generated file carries a key", () => {
  const key = "K".repeat(48);

  test("the unit sets no SESSION_SECRET, whatever the app has", () => {
    for (const secret of [null, key]) {
      const unit = systemdUnit({ ...ctx, secret });
      expect(unit).not.toContain("SESSION_SECRET=");
      expect(unit).not.toContain(key);
      // it points at the file that does hold it, and tolerates its absence
      expect(unit).toContain("EnvironmentFile=-/srv/my-app/.env");
    }
  });

  // an artefact that varies with the environment it was generated in is one
  // whose review tells you nothing about the next
  test("and the unit is the same file either way", () => {
    expect(systemdUnit({ ...ctx, secret: null })).toBe(systemdUnit({ ...ctx, secret: key }));
  });

  // the whole matrix, through the command, reading the files off the disk
  test("nothing deploy init writes contains the app's key, anywhere", () => {
    for (const spec of MATRIX) {
      const { files } = generated(spec);
      for (const [name, text] of Object.entries(files)) {
        if (spec.secret) expect(`${name}: ${text}`).not.toContain(spec.secret);
        // nor a key of borgo's own invention: nothing assigns SESSION_SECRET
        // a literal value. compose's `${SESSION_SECRET:?...}` is an
        // interpolation of the operator's .env, not a value.
        for (const line of text.split("\n")) {
          if (!/SESSION_SECRET\s*[=:]/.test(line) || line.trimStart().startsWith("#")) continue;
          expect(line).toMatch(/\$\{SESSION_SECRET/);
        }
      }
    }
    // 24 scaffolds through every target is disk work priced by the machine:
    // 0.4s idle, 3-12s under 16 burners on 8 cores, past bun's default 5s
  }, 30_000);

  // the key still has to come from somewhere for an app that has none: it is
  // offered on the terminal, which is not a file anything commits
  test("an app with no key is handed one to put in .env, not in the unit", () => {
    const dir = scaffold({ template: "base", docker: false });
    const { out } = quietly(() => expect(deployInit("systemd", false, dir)).toBe(0));
    const offered = out.match(/SESSION_SECRET=(\S+)'/)?.[1];
    expect(offered).toBeDefined();
    expect(offered!.length).toBeGreaterThanOrEqual(SESSION_SECRET_MIN);
    expect(readFileSync(join(dir, "borgo.service"), "utf8")).not.toContain(offered!);

    // an app that already has one is not offered another
    const withKey = scaffold({ template: "full", secret: "S".repeat(48), docker: false });
    const second = quietly(() => deployInit("systemd", false, withKey));
    expect(second.out).not.toContain("SESSION_SECRET=");
  });

  test("the unit lands in both ignore files, once, whether or not they exist", () => {
    for (const docker of [true, false]) {
      const dir = scaffold({ template: "base", docker });
      quietly(() => deployInit("systemd", false, dir));
      quietly(() => deployInit("systemd", true, dir));
      for (const ignore of [".gitignore", ".dockerignore"]) {
        const lines = readFileSync(join(dir, ignore), "utf8").split("\n");
        expect(lines.filter((l) => l.trim() === "borgo.service")).toHaveLength(1);
        // whatever create-borgo put there is still there
        if (existsSync(join(dir, ".env"))) expect(lines).toContain(".env");
      }
    }
  });

  test("ensureIgnored appends to a file with no trailing newline", () => {
    const dir = mkdtempSync(join(tmpdir(), "borgo-deploy-"));
    writeFileSync(join(dir, ".gitignore"), "dist");
    expect(ensureIgnored(dir, ".gitignore", "borgo.service")).toBe("added");
    expect(ensureIgnored(dir, ".gitignore", "borgo.service")).toBe("present");
    const lines = readFileSync(join(dir, ".gitignore"), "utf8").split("\n");
    expect(lines).toContain("dist");
    expect(lines).toContain("borgo.service");
  });

  // composeYml's comment is about adding sessions later with no secret set at
  // all, which really is a 500 per auth route (ErrNoSessionSecret)
  test("compose still describes its own, different case", () => {
    const yml = composeYml(ctx);
    expect(yml).toContain("500");
    expect(yml).not.toContain("answers 500 at boot");
  });
});

// `systemd-analyze security` scores the unit 9.0 UNSAFE without the set
describe("the systemd unit is hardened", () => {
  // a real ini read, not toContain: a directive in a comment is not a setting,
  // and a directive after [Install] is not in [Service]
  function service(unit: string): Record<string, string> {
    const out: Record<string, string> = {};
    let section = "";
    for (const raw of unit.split("\n")) {
      const line = raw.trim();
      if (!line || line.startsWith("#")) continue;
      if (line.startsWith("[")) {
        section = line;
        continue;
      }
      if (section !== "[Service]") continue;
      const at = line.indexOf("=");
      if (at > 0) out[line.slice(0, at)] = line.slice(at + 1);
    }
    return out;
  }

  test("the standard set is in [Service], with the values that mean it", () => {
    const s = service(systemdUnit(ctx));
    expect(s.NoNewPrivileges).toBe("yes");
    expect(s.ProtectSystem).toBe("strict");
    expect(s.ProtectHome).toBe("yes");
    expect(s.PrivateTmp).toBe("yes");
    expect(s.UMask).toBe("0077");
    // strict makes /srv read-only, so the app's own directory is named back
    expect(s.ReadWritePaths).toBe("/srv/my-app");
    expect(s.WorkingDirectory).toBe("/srv/my-app");
    // bun jits: this one would stop the service from starting at all
    expect(s.MemoryDenyWriteExecute).toBeUndefined();
    // and the ini parse is worth having: EnvironmentFile is a setting here,
    // not a word inside the comment above it
    expect(s.EnvironmentFile).toBe("-/srv/my-app/.env");
  });

  test("systemd-analyze verify accepts it and security scores it OK", async () => {
    const found = systemdAnalyze();
    if ("skip" in found) return void console.log(`skipped: ${found.skip}`);

    const dir = mkdtempSync(join(tmpdir(), "borgo-deploy-"));
    const path = join(dir, "borgo.service");
    writeFileSync(path, systemdUnit(ctx));

    const verify = await found.run(["verify"], path);
    // the only complaint allowed is about this machine, not about the file:
    // /usr/local/bin/bun is not installed here, and a unit copied off a
    // windows filesystem arrives with its executable bit set
    const noise = /is not executable|marked executable|Proceeding anyway/;
    const real = verify.text.split("\n").filter((l) => l.trim() && !noise.test(l));
    expect(real).toEqual([]);

    const security = await found.run(["security", "--offline=true"], path);
    const score = Number(security.text.match(/Overall exposure level for .*?: ([\d.]+)/)?.[1]);
    expect(score).toBeGreaterThan(0);
    // it was 9.0 UNSAFE. anything at or above 6.5 means the set was gutted
    expect(score).toBeLessThan(6.5);
  }, EXTERNAL_TOOL_TIMEOUT);
});

// restart: unless-stopped only sees the process exit, and /healthz answers 200
// with the api down on purpose: the probe has to read the body
describe("the container artefacts have a healthcheck", () => {
  type Compose = {
    services: {
      app: {
        healthcheck?: { test?: string[]; interval?: string; timeout?: string; retries?: number; start_period?: string };
      };
    };
  };
  const health = (yml: string) => (Bun.YAML.parse(yml) as Compose).services.app.healthcheck;

  test("compose declares one, in exec form, with real intervals", () => {
    const hc = health(composeYml(ctx))!;
    expect(hc.test?.[0]).toBe("CMD");
    expect(hc.interval).toBe("30s");
    expect(hc.timeout).toBe("5s");
    expect(hc.retries).toBe(3);
    expect(hc.start_period).toBe("20s");
  });

  // the probe is run, not read. A command that greps the wrong field, or that
  // YAML mangled on the way through, passes every string assertion ever
  // written about it and reports a broken app as healthy forever.
  test("the probe passes on ok, fails on degraded, fails on nothing listening", async () => {
    let state: Record<string, unknown> = { status: "ok", uptime: 3, api: "reachable" };
    const server = Bun.serve({ port: 0, fetch: () => Response.json(state) });
    const argv = health(composeYml({ ...ctx, port: String(server.port) }))!.test!.slice(1);
    // the container talks to itself, on the port the app is told to listen on
    expect(argv.join(" ")).toContain(`127.0.0.1:${server.port}/healthz`);

    const probe = async () => (await run(argv)).code;
    expect(await probe()).toBe(0);

    state = { status: "degraded", uptime: 3, api: "down" };
    expect(await probe()).toBe(1);

    await server.stop(true);
    expect(await probe()).toBe(1);
  }, EXTERNAL_TOOL_TIMEOUT);

  test("docker compose parses the file, healthcheck included", async () => {
    const docker = validator("BORGO_TEST_DOCKER", "docker");
    if ("skip" in docker) return void console.log(`skipped: ${docker.skip}`);

    const dir = mkdtempSync(join(tmpdir(), "borgo-deploy-"));
    writeFileSync(join(dir, "docker-compose.yml"), composeYml(ctx));
    writeFileSync(join(dir, "Dockerfile"), "FROM oven/bun:1.3-slim\n");
    const { code, text } = await run([docker.path, "compose", "config"], dir);
    expect(code).toBe(0);
    // the probe survived compose's own parse, quoting and all
    expect(text).toContain("t.includes('\"status\":\"ok\"')");
  }, EXTERNAL_TOOL_TIMEOUT);
});

// both proxies write both headers from the peer; set, never appended
describe("the forwarding headers are the proxy's, not the client's", () => {
  test("nginx sets both from $remote_addr and appends nothing", () => {
    const out = nginxConf(ctx);
    expect(out).toContain("proxy_set_header X-Real-IP $remote_addr;");
    expect(out).toContain("proxy_set_header X-Forwarded-For $remote_addr;");
    // the appending form is what let a forged chain through
    expect(out).not.toContain("$proxy_add_x_forwarded_for");
    // and nothing anywhere reads the client's own copy of either header
    expect(out).not.toContain("$http_x_real_ip");
    expect(out).not.toContain("$http_x_forwarded_for");
  });

  test("the caddy adapter really compiles both to the peer", async () => {
    const caddy = validator("BORGO_TEST_CADDY", "caddy");
    if ("skip" in caddy) return void console.log(`skipped: ${caddy.skip}`);

    const dir = mkdtempSync(join(tmpdir(), "borgo-deploy-"));
    const path = join(dir, "Caddyfile");
    writeFileSync(path, caddyfile(ctx));
    const { code, out } = await run([caddy.path, "adapt", "--config", path, "--adapter", "caddyfile"]);
    expect(code).toBe(0);

    // through caddy's own adapter, so this is the config that would run
    type Handler = Record<string, any>;
    const json = JSON.parse(out) as {
      apps: { http: { servers: Record<string, { routes: Array<{ handle: Array<{ routes?: Array<{ handle: Handler[] }> }> }> }> } };
    };
    const handlers = Object.values(json.apps.http.servers)
      .flatMap((s) => s.routes)
      .flatMap((r) => r.handle)
      .flatMap((h) => h.routes ?? [])
      .flatMap((r) => r.handle);
    const proxy = handlers.find((h) => h.handler === "reverse_proxy")!;
    const peer = "{http.request.remote.host}";
    // `set`, not `add`: what arrived is replaced, never appended to
    expect(proxy.headers.request.set["X-Real-Ip"]).toEqual([peer]);
    expect(proxy.headers.request.set["X-Forwarded-For"]).toEqual([peer]);
    expect(proxy.headers.request.add).toBeUndefined();

    const body = handlers.find((h) => h.handler === "request_body")!;
    expect(body.max_size).toBe(BODY_LIMIT);
  }, EXTERNAL_TOOL_TIMEOUT);

  test("caddy validate accepts the file as written", async () => {
    const caddy = validator("BORGO_TEST_CADDY", "caddy");
    if ("skip" in caddy) return void console.log(`skipped: ${caddy.skip}`);

    const dir = mkdtempSync(join(tmpdir(), "borgo-deploy-"));
    const path = join(dir, "Caddyfile");
    writeFileSync(path, caddyfile(ctx));
    const { code, text } = await run([caddy.path, "validate", "--config", path, "--adapter", "caddyfile"]);
    expect(text).toContain("Valid configuration");
    expect(code).toBe(0);
  }, EXTERNAL_TOOL_TIMEOUT);

  // a `toContain` on a directive cannot tell a config nginx loads from one it
  // refuses. This one is loaded, from the http block sites-enabled lives in.
  test("nginx -t accepts the file it is told to include", async () => {
    const nginx = validator("BORGO_TEST_NGINX", "nginx");
    if ("skip" in nginx) return void console.log(`skipped: ${nginx.skip}`);

    const dir = mkdtempSync(join(tmpdir(), "borgo-deploy-"));
    // the file's own documented alternative to a certificate: `listen 80`
    // behind another terminator. nginx -t hard-fails on 443 with no cert.
    writeFileSync(join(dir, "site.conf"), nginxConf(ctx).replace("listen 443 ssl;", "listen 80;"));
    // -t is not a dry run: nginx opens its pid file, its logs and its temp
    // directories, and those paths are compiled in as absolute ones the package
    // built for root. Under any account that is not root - every CI runner -
    // the test dies on /run/nginx.pid before it has read a line of site.conf,
    // and reports it as this file failing. Every path it touches is moved
    // inside the prefix, so what is under test is the config and nothing else.
    const prefix = dir.replaceAll("\\", "/");
    writeFileSync(
      join(dir, "nginx.conf"),
      "events {}\nhttp {\n" +
        `    client_body_temp_path ${prefix}/temp/body;\n` +
        `    proxy_temp_path ${prefix}/temp/proxy;\n` +
        `    fastcgi_temp_path ${prefix}/temp/fastcgi;\n` +
        `    uwsgi_temp_path ${prefix}/temp/uwsgi;\n` +
        `    scgi_temp_path ${prefix}/temp/scgi;\n` +
        `    access_log ${prefix}/logs/access.log;\n` +
        "    include site.conf;\n}\n",
    );
    // the prefix nginx wants around any config it is asked to test
    for (const sub of ["logs", "temp"]) mkdirSync(join(dir, sub), { recursive: true });
    const { code, text } = await run([
      nginx.path,
      "-p",
      dir,
      "-c",
      join(dir, "nginx.conf"),
      "-g",
      `pid ${prefix}/nginx.pid; error_log ${prefix}/logs/error.log;`,
      "-t",
    ]);
    expect(text).toContain("syntax is ok");
    expect(text).toContain("test is successful");
    expect(code).toBe(0);
  }, EXTERNAL_TOOL_TIMEOUT);
});

// an exported PORT left over in the shell must not be baked into every
// generated file: nothing in the files would say why they work from one terminal
describe("the ports come from the app, not from the shell", () => {
  const shell = (vars: Record<string, string | undefined>, fn: () => void) => {
    const before = { PORT: process.env.PORT, API_PORT: process.env.API_PORT };
    for (const [k, v] of Object.entries(vars)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    try {
      fn();
    } finally {
      for (const [k, v] of Object.entries(before)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  };

  test("an exported PORT changes nothing", () => {
    shell({ PORT: "5173", API_PORT: "9999" }, () => {
      const dir = scaffold({ template: "base", docker: false });
      expect(projectContext(dir).port).toBe("3000");
      expect(projectContext(dir).apiPort).toBe("3501");
      const { files } = generated({ template: "base", docker: false });
      for (const text of Object.values(files)) {
        expect(text).not.toContain("5173");
        expect(text).not.toContain("9999");
      }
    });
  });

  test("the app's own .env does", () => {
    shell({ PORT: "5173", API_PORT: undefined }, () => {
      const dir = scaffold({ template: "full", port: "8080", docker: true });
      const fromEnv = projectContext(dir);
      expect(fromEnv.port).toBe("8080");
      expect(fromEnv.apiPort).toBe("8581");
      quietly(() => {
        for (const target of Object.keys(targets)) expect(deployInit(target, true, dir)).toBe(0);
      });
      expect(readFileSync(join(dir, "Caddyfile"), "utf8")).toContain("localhost:8080");
      expect(readFileSync(join(dir, "site.conf"), "utf8")).toContain("localhost:8080");
      expect(readFileSync(join(dir, "borgo.service"), "utf8")).toContain("Environment=PORT=8080");
      expect(readFileSync(join(dir, "docker-compose.yml"), "utf8")).toContain('"8080:8080"');
    });
  });

  test("a .env port that is not a port falls back rather than templating rubbish", () => {
    for (const bad of ["", "0", "70000", "3000 # front", "not-a-port"]) {
      const dir = mkdtempSync(join(tmpdir(), "borgo-deploy-"));
      writeFileSync(join(dir, ".env"), `PORT=${bad}\n`);
      expect(projectContext(dir).port).toBe("3000");
    }
  });

  test("envFile reads what borgo writes, and skips what it does not", () => {
    const dir = mkdtempSync(join(tmpdir(), "borgo-deploy-"));
    writeFileSync(join(dir, ".env"), ["# a comment", "PORT=8080", 'export API_PORT="9001"', "SESSION_SECRET='abc'", "nonsense", ""].join("\n"));
    const env = envFile(dir);
    expect(env.PORT).toBe("8080");
    expect(env.API_PORT).toBe("9001");
    expect(env.SESSION_SECRET).toBe("abc");
    expect(Object.keys(env)).toHaveLength(3);
    expect(envFile(join(dir, "nowhere"))).toEqual({});
  });
});

// The whole matrix, once, on the invariants that hold for every combination:
// there is no scaffold for which the generated pair disagrees.
describe("across every scaffold deploy init can meet", () => {
  test("the two proxies always describe the same app", () => {
    for (const spec of MATRIX) {
      const { files } = generated(spec);
      const port = spec.port ?? "3000";
      expect(files.Caddyfile).toContain(`reverse_proxy localhost:${port}`);
      expect(files["site.conf"]).toContain(`proxy_pass http://localhost:${port};`);
      // one body policy
      expect(files["site.conf"]).toContain("client_max_body_size 1m;");
      expect(files.Caddyfile).toContain("max_size 1MiB");
      // one forwarding policy, neither of them trusting the client
      expect(files["site.conf"]).toContain("proxy_set_header X-Real-IP $remote_addr;");
      expect(files.Caddyfile).toContain("header_up X-Real-IP {remote_host}");
      expect(files["site.conf"]).not.toContain("$proxy_add_x_forwarded_for");
      // and nginx gives away no version
      expect(files["site.conf"]).toContain("server_tokens off;");
    }
    // the same 24 scaffolds as above, the same disk price: 6.5-7.6s under 16
    // burners on 8 cores, past bun's default 5s
  }, 30_000);

  test("every unit is hardened and every compose is probed", () => {
    for (const spec of MATRIX) {
      const { files } = generated(spec);
      for (const directive of ["NoNewPrivileges=yes", "ProtectSystem=strict", "ProtectHome=yes", "PrivateTmp=yes", "UMask=0077"]) {
        expect(files["borgo.service"]).toContain(directive);
      }
      const parsed = Bun.YAML.parse(files["docker-compose.yml"]) as { services: { app: { healthcheck?: unknown } } };
      expect(parsed.services.app.healthcheck).toBeDefined();
    }
  }, 30_000);
});

// `example.com { }` without tls is a real ACME order against Let's Encrypt from
// the operator's account, retried for thirty days. the defect is an ABSENT
// issuer in the adapted json, so nothing here may be asserted as an absence:
// `not.toContain("acme")` passes on the broken file
describe("the example Caddyfile issues from a local CA, not from Let's Encrypt", () => {
  test("the file carries tls internal, and says which line goes when the domain is real", () => {
    const out = caddyfile(ctx);
    const tls = out.split("\n").find((l) => l.trim().startsWith("tls "))!;
    // uncommented: a safe line an operator has to uncomment is the unsafe
    // file plus a note, and the file nobody reads is the one that must be safe
    expect(tls.trim()).toBe("tls internal");
    expect(out).toContain("delete");
    expect(out).toContain("example.com {");
    expect(balanced(out)).toBe(true);
  });

  // through caddy's own adapter: the issuer the running server would use
  test("caddy adapt names the internal issuer for every site in the file", async () => {
    const caddy = validator("BORGO_TEST_CADDY", "caddy");
    if ("skip" in caddy) return void console.log(`skipped: ${caddy.skip}`);

    const dir = mkdtempSync(join(tmpdir(), "borgo-deploy-"));
    const path = join(dir, "Caddyfile");
    writeFileSync(path, caddyfile(ctx));
    const { code, out } = await run([caddy.path, "adapt", "--config", path, "--adapter", "caddyfile"]);
    expect(code).toBe(0);

    const json = JSON.parse(out) as {
      apps: { tls?: { automation?: { policies?: Array<{ subjects?: string[]; issuers?: Array<{ module: string }> }> } } };
    };
    const policies = json.apps.tls?.automation?.policies;
    // a config with no tls app is the broken one: caddy's unstated default is
    // the public ACME issuers, so an absent policy is not a passing test
    expect(policies).toBeDefined();
    expect(policies!.length).toBeGreaterThan(0);
    for (const policy of policies!) {
      expect(policy.subjects).toContain("example.com");
      expect(policy.issuers).toBeDefined();
      expect(policy.issuers!.length).toBeGreaterThan(0);
      // `internal` is caddy's local CA and speaks to nothing; `acme` and
      // `zerossl` are the two that would order a certificate for real
      for (const issuer of policy.issuers!) expect(issuer.module).toBe("internal");
    }
  }, EXTERNAL_TOOL_TIMEOUT);

  // the discriminator: without that line the adapted config names no issuer,
  // which is how caddy spells "the public default". if this stops holding,
  // the test above has stopped proving anything
  test("dropping the line is what puts the public issuer back", async () => {
    const caddy = validator("BORGO_TEST_CADDY", "caddy");
    if ("skip" in caddy) return void console.log(`skipped: ${caddy.skip}`);

    const dir = mkdtempSync(join(tmpdir(), "borgo-deploy-"));
    const path = join(dir, "Caddyfile");
    // the documented way live: the real domain, and the tls line gone
    writeFileSync(
      path,
      caddyfile(ctx)
        .split("\n")
        .filter((l) => l.trim() !== "tls internal")
        .join("\n")
        .replace("example.com {", "live.example.org {"),
    );
    const { code, out } = await run([caddy.path, "adapt", "--config", path, "--adapter", "caddyfile"]);
    expect(code).toBe(0);
    expect((JSON.parse(out) as { apps: { tls?: unknown } }).apps.tls).toBeUndefined();
  }, EXTERNAL_TOOL_TIMEOUT);
});

// deploy.md prints every one of these files, and a reader edits the page's
// version into their server: two copies drift the moment one is fixed
describe("deploy.md prints what deploy init writes", () => {
  const page = readFileSync(join(repoRoot, "docs/deploy.md"), "utf8");
  const blocks = [...page.matchAll(/```(\w+)\n([\s\S]*?)```/g)].map(([, lang, body]) => ({ lang, body }));
  const block = (lang: string, needle: string) => {
    const found = blocks.filter((b) => b.lang === lang && b.body.includes(needle));
    expect(found).toHaveLength(1);
    return found[0].body;
  };
  // comments are prose and may differ; directives may not
  const directives = (text: string) =>
    text
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith("#"));

  test("the nginx block is the generated site.conf", () => {
    const generatedConf = nginxConf(ctx);
    for (const line of directives(block("nginx", "client_max_body_size"))) {
      expect(generatedConf).toContain(line);
    }
  });

  test("the caddy block is the generated Caddyfile", () => {
    const generatedFile = caddyfile(ctx);
    for (const line of directives(block("caddy", "reverse_proxy"))) {
      expect(generatedFile).toContain(line);
    }
  });

  test("the ini block is the generated unit, hardening and all", () => {
    const unit = systemdUnit(ctx);
    for (const line of directives(block("ini", "ExecStart="))) {
      expect(unit).toContain(line);
    }
    // and the page cannot go back to printing a key
    expect(page).not.toMatch(/^Environment=SESSION_SECRET=\S+$/m);
  });

  // same values, parsed on both sides: a healthcheck a reader copies out of
  // the page has to be the one the generated file already runs
  test("the healthcheck block is the generated one, field by field", () => {
    const documented = Bun.YAML.parse(block("yaml", "healthcheck:")) as { healthcheck: Record<string, unknown> };
    const written = (Bun.YAML.parse(composeYml(ctx)) as { services: { app: { healthcheck: Record<string, unknown> } } })
      .services.app.healthcheck;
    expect(documented.healthcheck).toEqual(written);
  });
});
