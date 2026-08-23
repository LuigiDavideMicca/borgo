#!/usr/bin/env bun
import { existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  buildAssets,
  debugEnabled,
  rebuildBeforeServing,
  reportBuildFailure,
  warnDeadRoutes,
  type BuildResult,
} from "./build";
import { banner, c, fmtMs, g } from "./colors";
import { parseInitArgv, unknownArg } from "./deploy";
import { goBinName, runBorgogen } from "./util";

const command = process.argv[2];

// tailwind is opt-in by flag, never by detection; the env carries it to children
if (process.argv.includes("--tailwind")) process.env.BORGO_TAILWIND = "1";

const debug = debugEnabled(process.argv);

// an unknown flag is refused, not ignored: a build that ignores it exits 0
// having done something other than what was asked
const badArg = unknownArg(command, process.argv.slice(3));
if (badArg) {
  console.log(`\n  ${banner(command)}\n`);
  console.log(`  ${c.red(g.err)} ${badArg}`);
  console.log(`  usage: borgo ${command}${command === "start" ? " [--front-only]" : ""} [--tailwind]\n`);
  process.exit(1);
}

const kb = (bytes: number) => `${(bytes / 1024).toFixed(1)} kB`;

async function build(dev = false): Promise<BuildResult> {
  try {
    return await buildAssets(dev);
  } catch (error) {
    reportBuildFailure(error, debug);
    process.exit(1);
  }
}

// serve() builds on its own when it finds a tree it cannot serve
async function framed<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    reportBuildFailure(error, debug);
    process.exit(1);
  }
}

async function assetLine(path: string, note = "") {
  const file = Bun.file(path);
  if (!(await file.exists())) return;
  const bytes = new Uint8Array(await file.arrayBuffer());
  const gzip = Bun.gzipSync(bytes).length;
  const label = note ? c.dim(note) : c.dim(`gzip: ${kb(gzip)}`);
  console.log(`  ${c.sage(g.ok)} ${path.padEnd(40)} ${kb(bytes.length).padStart(9)} ${label}`);
}

switch (command) {
  case "dev": {
    // ./server (in `start`) must stay lazy: it resolves the app's react at
    // module scope, and a bare `borgo` outside a project must keep working
    const { dev } = await import("./dev");
    await framed(dev);
    break;
  }

  case "build": {
    const t0 = performance.now();
    console.log(`\n  ${banner("build")}\n`);

    if (!(await runBorgogen())) process.exit(1);
    const { assets, names } = await build();
    const rel = (p: string) => p.replaceAll("\\", "/").replace(/^.*?(public\/assets\/)/, "$1");
    for (const asset of assets.sort((a, b) => (a.kind === b.kind ? b.size - a.size : a.kind === "entry-point" ? -1 : 1))) {
      await assetLine(rel(asset.path), asset.kind === "entry-point" ? "entry (runtime + react)" : "");
    }
    if (names["style.css"]) await assetLine(`public/assets/${names["style.css"]}`);

    const bin = `dist/${goBinName()}`;
    const goBuild = Bun.spawn(["go", "build", "-o", bin, "."], {
      stdout: "inherit",
      stderr: "inherit",
    });
    if ((await goBuild.exited) !== 0) {
      console.error(`  ${c.red(g.err)} go build failed`);
      process.exit(1);
    }
    const binSize = Bun.file(bin).size;
    console.log(`  ${c.sage(g.ok)} ${bin.padEnd(28)} ${kb(binSize).padStart(9)} ${c.dim("go api binary")}`);
    console.log(`\n  done in ${c.bold(fmtMs(performance.now() - t0))}`);
    console.log(
      `  ${c.dim(`${g.dot} restart borgo start to serve this build ${g.dot} a server left running holds the previous document, whose assets are gone`)}\n`,
    );
    break;
  }

  case "start": {
    // bun sizes its fetch pool at boot (default 256) and a proxied event stream
    // holds a slot for hours: assigning process.env after boot changes nothing,
    // so re-exec with it set. The deployments borgo writes already set it.
    if (!process.env.BUN_CONFIG_MAX_HTTP_REQUESTS) {
      // not the bin shim: killing a shim leaves the real server on the port
      const child = Bun.spawn([process.execPath, import.meta.path, ...process.argv.slice(2)], {
        stdout: "inherit",
        stderr: "inherit",
        stdin: "inherit",
        env: {
          ...process.env,
          BUN_CONFIG_MAX_HTTP_REQUESTS: "16384",
          // a hard kill delivers no signal on windows, and the api's own
          // watchdog only watches the child
          BORGO_SUPERVISOR_PID: String(process.pid),
        },
      });
      // exit with the child's own code so a restart policy sees the truth
      for (const signal of ["SIGINT", "SIGTERM"] as const) {
        process.on(signal, () => child.kill(signal));
      }
      process.exit(await child.exited);
    }
    // the env's pid, never process.ppid: a server started with nohup from a
    // shell that then exits must keep serving. A false death here exits 0 and
    // `Restart=on-failure` does not restart a clean exit - the site is down.
    const supervisor = Number(process.env.BORGO_SUPERVISOR_PID);
    const { watchParent } = await import("./parent-watch");
    watchParent(supervisor, () => process.exit(0), 2_000, "BORGO_SUPERVISOR_PID")?.unref();

    // --front-only: the api runs elsewhere (API_URL)
    if (!process.argv.includes("--front-only")) {
      const bin = `dist/${goBinName()}`;
      if (!existsSync(bin)) {
        console.error(`  ${c.red(g.err)} ${bin} not found - run \`borgo build\` first`);
        process.exit(1);
      }

      // the api watches this pid: a force-killed start leaves no orphan
      const apiProc = Bun.spawn([bin], {
        stdout: "inherit",
        stderr: "inherit",
        env: { ...process.env, BORGO_PARENT_PID: String(process.pid) },
      });
      // an intentional stop must exit 0, or a supervisor restart-loops; the
      // flag wins the race when the signal reaches the child first
      let stopping = false;
      const stop = () => {
        stopping = true;
        apiProc.kill();
        process.exit(0);
      };
      process.on("SIGINT", stop);
      process.on("SIGTERM", stop);
      apiProc.exited.then((code) => {
        if (stopping) return;
        console.error(`  ${c.red(g.err)} api process exited (${code})`);
        process.exit(code);
      });
    }

    // BORGO_STATIC belongs to `borgo export`: inherited, every rebuild here
    // would be an export build and the next boot would rebuild again, forever
    delete process.env.BORGO_STATIC;

    // a stamp that cannot be read is not a licence to serve
    const rebuildWhy = rebuildBeforeServing();
    if (rebuildWhy) {
      console.log(`  ${c.terracotta(g.change)} ${rebuildWhy} ${c.dim("- rebuilding for production")}`);
      const rebuildStarted = performance.now();
      await build();
      console.log(`  ${c.sage(g.ok)} built in ${c.bold(fmtMs(performance.now() - rebuildStarted))}`);
    }

    // `borgo build` printed these on a machine this operator may never have seen
    try {
      const manifest = pathToFileURL(join(process.cwd(), ".borgo/routes.gen.tsx")).href;
      const { routes } = (await import(manifest)) as { routes: Array<{ pattern: string; file: string }> };
      warnDeadRoutes(routes.map(({ pattern, file }) => ({ pattern, file })));
    } catch {
      // serve() reports a missing or broken manifest
    }

    const { serve } = await import("./server");
    await framed(() => serve({ dev: false }));
    break;
  }

  case "export": {
    const { exportSite } = await import("./export");
    process.exit(await exportSite());
  }

  case "doctor": {
    const { doctor } = await import("./doctor");
    process.exit(await doctor());
  }

  case "pwa": {
    const { pwaInit } = await import("./pwa");
    const parsed = parseInitArgv(process.argv.slice(3), 0);
    if (!parsed.ok) {
      console.log(`\n  ${banner("pwa")}\n`);
      console.log(`  ${c.red(g.err)} ${parsed.reason}`);
      console.log(`  usage: borgo pwa init [--force]\n`);
      process.exit(1);
    }
    process.exit(pwaInit(parsed.force));
  }

  case "deploy": {
    const { deployInit } = await import("./deploy");
    const parsed = parseInitArgv(process.argv.slice(3), 1);
    if (!parsed.ok) {
      console.log(`\n  ${banner("deploy")}\n`);
      console.log(`  ${c.red(g.err)} ${parsed.reason}`);
      console.log(`  usage: borgo deploy init <caddy|nginx|systemd|compose> [--force]\n`);
      process.exit(1);
    }
    process.exit(deployInit(parsed.target, parsed.force));
  }

  default: {
    console.log(`\n  ${banner()}\n\n  usage: borgo <dev|build|start|export|deploy|pwa|doctor>\n`);
    // the banner answers --help and --version, which must not exit 1
    process.exit(!command || /^(-h|--help|-v|--version)$/.test(command) ? 0 : 1);
  }
}
