// borgo deploy init <target>: writes the deploy guide's blessed config for
// caddy, nginx, systemd or compose into the project, templated with the
// app's name and ports. never overwrites without --force.
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { banner, c, g } from "./colors";

export type DeployContext = {
  name: string;
  port: string;
  apiPort: string;
  /**
   * The signing key the app already has, read from its `.env` - `null` when it
   * has none. Not a value to copy around: what the generated configs need to
   * know is whether the app signs sessions at all, and whether a key is
   * already being supplied from somewhere they must not override.
   */
  secret?: string | null;
};

// session.go refuses a SESSION_SECRET shorter than this at startup, so anything
// under it is not a placeholder to fill in later - it is an api that does not
// boot. (An UNSET secret is the softer case: that one only warns, and the auth
// routes answer 500 until it is set. Too short is the hard refusal.)
export const SESSION_SECRET_MIN = 32;

// 48 base64url characters out of the CSPRNG: over the floor, and safe to put
// on a systemd `Environment=` line unquoted (no spaces, no `%`, no newline)
export function randomSecret(): string {
  return randomBytes(36).toString("base64url");
}

// the app's own `.env`, read the way borgo writes it: KEY=value, an optional
// `export`, optional quotes. Not a dotenv implementation - it exists so the
// generated configs describe the app, and not the shell that generated them.
export function envFile(dir = "."): Record<string, string> {
  let raw: string;
  try {
    raw = readFileSync(join(dir, ".env"), "utf8");
  } catch {
    return {};
  }
  const out: Record<string, string> = {};
  for (const line of raw.split("\n")) {
    const found = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (found) out[found[1]] = found[2].trim().replace(/^(["'])(.*)\1$/, "$2");
  }
  return out;
}

// what the app is already signing with. a real environment variable beats
// `.env` in bun, so a config that sets SESSION_SECRET to anything else - a
// placeholder, or a fresh random key - silently overrides the one
// `create-borgo` generated and invalidates every session the app ever issued.
export function envSecret(dir = "."): string | null {
  const value = envFile(dir).SESSION_SECRET;
  return value && value.length >= SESSION_SECRET_MIN ? value : null;
}

/**
 * `borgo <deploy|pwa> init [target] [--force]`, and nothing else.
 *
 * The old parser was `argv.filter(a => !a.startsWith("--"))`, which drops a
 * flag and keeps its value: `deploy init nginx --port 8080` read `8080` as a
 * second positional and silently wrote the default-port config, and
 * `deploy init --port 8080 nginx` took `8080` as the target. Unknown options
 * and surplus arguments are refused by name instead.
 */
export type InitArgv = { ok: true; target?: string; force: boolean } | { ok: false; reason: string };

/**
 * The flags each top-level command takes, and nothing else.
 *
 * `borgo <deploy|pwa> init` refused unknown arguments through parseInitArgv;
 * every other command took whatever it was handed and dropped it on the floor.
 * So `borgo start --port 4000` served port 3000, `borgo build --minify` built
 * exactly as it always had, `borgo dev --tailwnid` compiled no tailwind, and
 * each of them exited 0 having done something other than what was asked - the
 * one failure mode a cli must not have, because the operator has no way to tell
 * it apart from success. A flag borgo does not know is a flag its user believes
 * is doing something.
 *
 * `--tailwind` is legal everywhere: cli.ts reads it off the whole argv before
 * dispatching, so it is a global, not a per-command flag.
 */
// --debug is legal after any command, deploy init and pwa init included: they
// go through parseInitArgv rather than the check below, so leaving it out here
// refused it on exactly the commands whose failures are hardest to read
export const GLOBAL_FLAGS = ["--tailwind", "--debug"] as const;
export const COMMAND_FLAGS: Record<string, readonly string[]> = {
  dev: [],
  build: [],
  // the split deployment: run the front server, point API_URL at an api elsewhere
  start: ["--front-only"],
  export: [],
  doctor: [],
};

// null when the arguments are all ones this command knows, otherwise why not.
// An unrecognised command is not this function's to judge - the cli's default
// branch prints usage for those.
export function unknownArg(command: string, argv: readonly string[]): string | null {
  const known = COMMAND_FLAGS[command];
  if (!known) return null;
  for (const arg of argv) {
    if (!arg.startsWith("-")) return `unexpected argument "${arg}"`;
    if (!known.includes(arg) && !GLOBAL_FLAGS.includes(arg as (typeof GLOBAL_FLAGS)[number])) {
      return `unknown option "${arg}"`;
    }
  }
  return null;
}

export function parseInitArgv(argv: string[], maxPositionals: number): InitArgv {
  const positionals: string[] = [];
  let force = false;
  for (const arg of argv) {
    if (arg === "--force") {
      force = true;
      continue;
    }
    // parsed globally by the cli itself, and legal after any command
    if (arg === "--tailwind") continue;
    if (arg.startsWith("-")) return { ok: false, reason: `unknown option "${arg}"` };
    positionals.push(arg);
  }
  const [sub, ...rest] = positionals;
  if (sub !== "init") {
    return { ok: false, reason: sub ? `unknown subcommand "${sub}"` : "missing subcommand" };
  }
  if (rest.length > maxPositionals) {
    return { ok: false, reason: `unexpected argument "${rest[maxPositionals]}"` };
  }
  return { ok: true, target: rest[0], force };
}

// what a scaffolded app actually accepts: borgo.Bind caps a JSON body at
// 1 MiB (bindLimit in borgo.go) and answers 413 above it. A proxy that lets
// more through only moves the refusal one hop later, and the two generated
// proxies must not disagree about where it is - a route that takes more says
// so with borgo.BindMax, and then this line moves with it.
export const BODY_LIMIT = 1024 * 1024;

// `example.com { ... }` with no tls directive is not a placeholder: caddy's
// automatic https has no local mode to fall back to, so `caddy run` on this
// file opens a real ACME order against Let's Encrypt for a domain the operator
// does not own, in the operator's name, and retries the failure for 30 days.
// Rate limits are per requesting account, so the cost lands on whoever tried
// our example. `tls internal` is therefore the default and not a suggestion:
// the file as generated issues from caddy's local CA and reaches no network,
// and going live is the one line below that says to delete it. The reverse
// arrangement - the safe line commented out - is the same defect with a note
// attached, because it is the file nobody reads that has to be the safe one.
export function caddyfile({ name, port }: DeployContext): string {
  return [
    `# ${name}: generated by borgo deploy init.`,
    "# as written this runs offline: a certificate from caddy's own local CA.",
    "# going live is two edits - your domain instead of example.com, and delete",
    "# the tls line, after which caddy gets a public certificate on its own.",
    "# borgo compresses responses itself, so no encode directive here.",
    "example.com {",
    "    # local CA, no ACME, no network. delete when the domain above is real.",
    "    tls internal",
    "    # borgo.Bind reads at most 1 MiB; a route that takes more uses",
    "    # borgo.BindMax, and this line has to be raised with it.",
    "    request_body {",
    "        max_size 1MiB",
    "    }",
    `    reverse_proxy localhost:${port} {`,
    // X-Real-IP arrives from the internet as often as from a proxy, and
    // nothing downstream can tell the two apart. Both generated proxies
    // therefore write it from the peer they read the request from and drop
    // whatever came in. X-Forwarded-For is set, not appended, for the same
    // reason: at the edge, an inbound chain is the client's invention.
    "        # written from the peer, never from what the client sent",
    "        header_up X-Real-IP {remote_host}",
    "        header_up X-Forwarded-For {remote_host}",
    "    }",
    "}",
    "",
  ].join("\n");
}

export function nginxConf({ name, port }: DeployContext): string {
  return [
    `# ${name}: generated by borgo deploy init - replace example.com with your domain`,
    "# and uncomment the two certificate lines (or drop to `listen 80;` behind",
    "# another terminator). nginx -t fails on `listen 443 ssl` with no certificate,",
    "# so those two lines are the one edit between this file and a running nginx.",
    "# upgrade headers keep websockets alive, proxy_buffering off keeps sse streaming,",
    "# and borgo compresses responses itself (gzip off is nginx's default).",
    "",
    "# `Connection: upgrade` belongs on a request that asked to upgrade, and on",
    "# no other: a fixed value sends it on every proxied request, which stops",
    "# nginx from keeping the upstream connection alive and hands borgo a",
    "# hop-by-hop header it has to strip. this map answers `upgrade` only when",
    "# the client sent an Upgrade header, and `close` otherwise. it sits at http",
    "# level, which is where sites-enabled is included from.",
    "map $http_upgrade $connection_upgrade {",
    "    default upgrade;",
    "    ''      close;",
    "}",
    "",
    "server {",
    "    listen 443 ssl;",
    "    server_name example.com;",
    "    server_tokens off;",
    "",
    "    # certbot writes these two; without them nginx refuses to start",
    "    # ssl_certificate     /etc/letsencrypt/live/example.com/fullchain.pem;",
    "    # ssl_certificate_key /etc/letsencrypt/live/example.com/privkey.pem;",
    "",
    // the same 1 MiB the Caddyfile caps at, and the same borgo.Bind refuses
    // above: two proxies generated by one command with two body policies is
    // one of them lying about the app behind it
    "    # borgo.Bind reads at most 1 MiB; a route that takes more uses",
    "    # borgo.BindMax, and this line has to be raised with it.",
    "    client_max_body_size 1m;",
    "",
    "    location / {",
    `        proxy_pass http://localhost:${port};`,
    "        proxy_http_version 1.1;",
    "        proxy_set_header Upgrade $http_upgrade;",
    "        proxy_set_header Connection $connection_upgrade;",
    "        proxy_set_header Host $host;",
    // nginx adds no forwarding header on its own, and borgo authorizes
    // /__borgo/publish as "from loopback and not forwarded". Behind a proxy on
    // the same box every request arrives from loopback, so without these lines
    // the second half of that test never fires and anyone on the internet can
    // broadcast into every subscribed browser.
    //
    // Both are written from $remote_addr and neither is appended to: this is
    // the edge, so an inbound X-Forwarded-For is a chain the client invented,
    // and an inbound X-Real-IP is a client claiming to be someone else. The
    // Caddyfile writes the same two from {remote_host}. Behind a proxy that is
    // not ours, add that proxy to set_real_ip_from (nginx) or trusted_proxies
    // (caddy) - until then $remote_addr is that proxy, not the client.
    "        # written from the peer, never from what the client sent",
    "        proxy_set_header X-Real-IP $remote_addr;",
    "        proxy_set_header X-Forwarded-For $remote_addr;",
    "        proxy_set_header X-Forwarded-Proto $scheme;",
    "        proxy_buffering off;",
    "        proxy_read_timeout 1h;",
    "    }",
    "}",
    "",
  ].join("\n");
}

export function systemdUnit({ name, port, apiPort }: DeployContext): string {
  // The unit used to carry `Environment=SESSION_SECRET=<48 real characters>`
  // whenever the app had no key of its own, and a unit file is not a secret
  // store: it lands in the project directory, where the next `git add .`
  // commits it and the next `docker build` bakes it into a layer. It is also
  // world-readable at /etc/systemd/system and shows up in `systemctl show`.
  // So the key is never written here at all: the app's `.env` - the file
  // create-borgo already gitignores, and the only one both halves read -
  // stays its single home, and the unit is told to load it. Nothing in this
  // file varies with the environment it was generated in.
  const session = [
    "# secrets stay in the app's gitignored .env and never in this file. the",
    "# leading dash tolerates its absence; what the file sets wins over the",
    "# Environment= lines above, which is why the ports come from it too.",
    `EnvironmentFile=-/srv/${name}/.env`,
  ];
  // 9.0 UNSAFE from `systemd-analyze security` for a public service running as
  // www-data, and nothing here is an event that may or may not happen: it is
  // what every operator who ran this command already has. Nothing in the set
  // costs the app anything it does - it renders pages, proxies to a local api,
  // and writes only inside its own directory. (MemoryDenyWriteExecute is
  // deliberately absent: bun jits, and it would refuse to start.)
  const hardening = [
    "NoNewPrivileges=yes",
    "ProtectSystem=strict",
    "ProtectHome=yes",
    "PrivateTmp=yes",
    "PrivateDevices=yes",
    "ProtectKernelTunables=yes",
    "ProtectControlGroups=yes",
    "ProtectKernelModules=yes",
    "ProtectClock=yes",
    "ProtectHostname=yes",
    "RestrictSUIDSGID=yes",
    "RestrictNamespaces=yes",
    "RestrictRealtime=yes",
    "LockPersonality=yes",
    "SystemCallArchitectures=native",
    "RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX",
    "# nothing here needs a capability: not root, and the port is above 1024.",
    "CapabilityBoundingSet=",
    "UMask=0077",
    "# the app writes only under its own directory; anywhere else it writes",
    "# (a database, a cache) has to be listed here too, or the write fails.",
    `ReadWritePaths=/srv/${name}`,
  ];
  return [
    "[Unit]",
    `Description=${name} (borgo app)`,
    "After=network.target",
    "",
    "[Service]",
    `WorkingDirectory=/srv/${name}`,
    // systemd requires an absolute path, so this cannot be a bare `bun`. it is
    // where a system-wide install puts it; the official installer script puts
    // it in the installing user's ~/.bun/bin instead
    "# absolute path is systemd's rule, not borgo's: check yours with `command -v bun`.",
    "# the official installer writes ~/.bun/bin/bun, which is not readable by User=",
    "# below - copy or symlink it somewhere system-wide, or point this line at it.",
    "ExecStart=/usr/local/bin/bun run start",
    "Environment=NODE_ENV=production",
    `Environment=PORT=${port}`,
    `Environment=API_PORT=${apiPort}`,
    ...session,
    "# bun's outbound fetch pool defaults to 256, which ceilings concurrent",
    "# proxied requests - event streams above all - see docs/realtime.md",
    "Environment=BUN_CONFIG_MAX_HTTP_REQUESTS=16384",
    "Restart=on-failure",
    "User=www-data",
    "",
    ...hardening,
    "",
    "[Install]",
    "WantedBy=multi-user.target",
    "",
  ].join("\n");
}

export function composeYml({ port, secret }: DeployContext): string {
  // an app that signs sessions gets the same required declaration the `full`
  // template ships: docker compose interpolates it from the .env beside this
  // file (which the image never sees - .dockerignore excludes it), and `:?`
  // stops the deploy with a message rather than producing an app whose every
  // login answers 500. an app with no key gets no line to override: this file
  // used to replace a correct one with a comment.
  const session = secret
    ? [
        "      # read from the .env beside this file, which docker compose",
        "      # interpolates and the image never receives (.dockerignore",
        "      # excludes it). required on purpose: a missing key must stop the",
        "      # deploy, not turn up later as a 500 on every login.",
        '      SESSION_SECRET: "${SESSION_SECRET:?missing - create-borgo writes one into .env, or generate one with openssl rand -base64 48}"',
      ]
    : [
        "      # this app signs no sessions yet. adding borgo.SetSession later?",
        "      # it needs SESSION_SECRET (32+ random characters) or every session",
        "      # route answers 500 - put it in the .env beside this file and",
        '      # declare it here as: SESSION_SECRET: "${SESSION_SECRET:?missing}"',
      ];
  return [
    "services:",
    "  app:",
    "    build: .",
    "    ports:",
    `      - "${port}:${port}"`,
    "    environment:",
    "      NODE_ENV: production",
    `      PORT: "${port}"`,
    ...session,
    "      # bun's outbound fetch pool defaults to 256, which ceilings",
    "      # concurrent event streams - see docs/realtime.md",
    '      BUN_CONFIG_MAX_HTTP_REQUESTS: "16384"',
    "    restart: unless-stopped",
    // `restart: unless-stopped` only ever sees the process exit, so an app
    // that is up and answering "degraded" - the api down behind a front server
    // that is perfectly alive - is a state nothing in this file could notice
    // before. /healthz answers 200 either way, deliberately, so the probe has
    // to read the body: a status-code check is the check that never fires.
    // Docker marks the container unhealthy; it does not restart it on its own.
    "    healthcheck:",
    "      # /healthz answers 200 even when the api is down - the state is in",
    "      # the body. bun is the runtime image's own binary, so no curl needed.",
    `      test: ["CMD", "bun", "-e", "fetch('http://127.0.0.1:${port}/healthz').then(r=>r.text()).then(t=>process.exit(t.includes('\\"status\\":\\"ok\\"')?0:1)).catch(()=>process.exit(1))"]`,
    "      interval: 30s",
    "      timeout: 5s",
    "      start_period: 20s",
    "      retries: 3",
    // no volume: the templates deliberately ship none, because nothing in them
    // persists anything yet, and a mount docker creates root-owned is a
    // permission error waiting for the first app that uses it. the scaffolded
    // Dockerfiles already prepare /data, so adding one is two blocks here.
    "# nothing here persists yet, so there is no volume. swapping the in-memory",
    "# stores for a real database? the scaffolded Dockerfile already creates",
    "# /data owned by the image's user, so this is the whole change:",
    "#   environment:",
    "#     DB_PATH: /data/app.db",
    "#   volumes:",
    "#     - data:/data",
    "# volumes:",
    "#   data:",
    "",
  ].join("\n");
}

export const targets: Record<string, { file: string; render: (ctx: DeployContext) => string; next: (ctx: DeployContext) => string }> = {
  caddy: {
    file: "Caddyfile",
    render: caddyfile,
    next: () => "caddy run --config Caddyfile - local cert as written; for a real domain, set it and delete `tls internal`",
  },
  nginx: {
    file: "site.conf",
    render: nginxConf,
    next: ({ name }) => `set your domain and certs, then link it: /etc/nginx/sites-enabled/${name}.conf`,
  },
  systemd: {
    file: "borgo.service",
    render: systemdUnit,
    next: ({ name }) =>
      `copy to /etc/systemd/system/${name}.service, then: systemctl enable --now ${name}`,
  },
  compose: {
    file: "docker-compose.yml",
    render: composeYml,
    next: () => "docker compose up -d",
  },
};

// a port from the app's `.env`, or the default. The shell that ran `deploy
// init` is not a source: an operator with PORT=5173 exported from an
// afternoon of something else got that number baked into a systemd unit, a
// compose file and the proxy config in front of them - a deployment that
// works only from that one terminal, and nothing in the file says why.
function portOf(value: string | undefined, fallback: string): string {
  const n = Number(value);
  return value && /^\d+$/.test(value) && n >= 1 && n <= 65535 ? value : fallback;
}

export function projectContext(dir = "."): DeployContext {
  let name = "borgo-app";
  try {
    const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as { name?: string };
    if (pkg.name) name = pkg.name.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || name;
  } catch {}
  const env = envFile(dir);
  const secret = env.SESSION_SECRET;
  return {
    name,
    port: portOf(env.PORT, "3000"),
    apiPort: portOf(env.API_PORT, "3501"),
    secret: secret && secret.length >= SESSION_SECRET_MIN ? secret : null,
  };
}

/**
 * Adds one entry to one ignore file, once, creating it if it is not there.
 *
 * `create-borgo` goes out of its way to gitignore and dockerignore `.env`,
 * and then `deploy init systemd` wrote a file next to it that a `git add .`
 * commits and a `docker build` copies into a layer. The unit no longer holds
 * a key, but it is still deployment-local - the host's paths, the host's
 * user - and it is still the file an operator edits by hand when they want an
 * `Environment=` line of their own. Both ignore files, both reasons.
 */
export function ensureIgnored(dir: string, ignoreFile: string, entry: string): "added" | "present" | "failed" {
  const path = join(dir, ignoreFile);
  let text = "";
  try {
    text = readFileSync(path, "utf8");
  } catch {}
  if (text.split("\n").some((line) => line.trim() === entry)) return "present";
  const gap = text && !text.endsWith("\n") ? "\n" : "";
  try {
    writeFileSync(path, `${text}${gap}# deployment-local, and never a place for a key\n${entry}\n`);
  } catch {
    return "failed";
  }
  return "added";
}

export function deployInit(target: string | undefined, force = false, dir = "."): number {
  console.log(`\n  ${banner("deploy")}\n`);
  const known = Object.keys(targets).join("|");
  if (!target || !targets[target]) {
    if (target) console.log(`  ${c.red(g.err)} unknown target "${target}"`);
    console.log(`  usage: borgo deploy init <${known}> [--force]\n`);
    return 1;
  }

  const { file, render, next } = targets[target];
  const path = join(dir, file);
  if (existsSync(path) && !force) {
    console.log(`  ${c.red(g.err)} ${file} already exists ${c.dim(`${g.dot} rerun with --force to overwrite`)}\n`);
    return 1;
  }

  const ctx = projectContext(dir);
  try {
    writeFileSync(path, render(ctx));
  } catch (error) {
    console.log(`  ${c.red(g.err)} cannot write ${file}: ${error instanceof Error ? error.message : error}\n`);
    return 1;
  }
  console.log(`  ${c.sage(g.ok)} ${file} ${c.dim(`${g.dot} ${target} config for ${ctx.name} on port ${ctx.port}`)}`);

  if (target === "systemd") {
    for (const ignoreFile of [".gitignore", ".dockerignore"]) {
      if (ensureIgnored(dir, ignoreFile, file) === "added") {
        console.log(`  ${c.sage(g.ok)} ${ignoreFile} ${c.dim(`${g.dot} ${file} added`)}`);
      }
    }
    // the unit deliberately carries no key, so an app without one needs
    // somewhere to put it - and that somewhere is the .env the unit loads.
    // Printed, not written: a terminal is not a file anything commits.
    if (!ctx.secret) {
      console.log(`  ${c.terracotta(g.arrow)} no SESSION_SECRET in .env ${c.dim(`${g.dot} echo 'SESSION_SECRET=${randomSecret()}' >> .env`)}`);
    }
  }

  console.log(`  ${c.terracotta(g.arrow)} ${next(ctx)}\n`);
  return 0;
}
