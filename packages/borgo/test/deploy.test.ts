import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { caddyfile, composeYml, deployInit, nginxConf, projectContext, systemdUnit } from "../src/deploy";

const ctx = { name: "my-app", port: "3000", apiPort: "3501" };

const balanced = (s: string) => s.split("{").length === s.split("}").length;

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
    expect(out).toContain('proxy_set_header Connection "upgrade";');
    expect(out).toContain("proxy_buffering off;");
    expect(balanced(out)).toBe(true);
    // every directive inside a block ends with a semicolon
    for (const line of out.split("\n")) {
      const t = line.trim();
      if (!t || t.startsWith("#") || t.endsWith("{") || t === "}") continue;
      expect(t.endsWith(";")).toBe(true);
    }
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

  test("compose maps the templated port and the data volume", () => {
    const out = composeYml({ ...ctx, port: "8080" });
    expect(out).toContain('- "8080:8080"');
    expect(out).toContain('PORT: "8080"');
    expect(out).toContain("- data:/data");
    expect(out).toContain("restart: unless-stopped");
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
  // bun reads BUN_CONFIG_MAX_HTTP_REQUESTS once, at process start, so it can
  // only be set by whatever launches the server. Every launch surface borgo
  // writes therefore has to carry it, and dropping it from one of them is a
  // silent ceiling on concurrent event streams - the kind of regression that
  // shows up as "sse stops working past a few hundred users", months later.
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
