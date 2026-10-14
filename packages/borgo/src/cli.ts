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
import { goBinName, runBorgogen, startEnv, startNeedsReexec } from "./util";

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
  console.log(`  usage: borgo ${command} [--tailwind]\n`);
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
    // two values only the LAUNCH environment can carry, so a missing one
    // re-execs with both set. bun sizes its fetch pool at boot (default 256)
    // and every loader call in flight holds a slot - measured to halve the
    // throughput of pages that wait on a slow route; NODE_ENV picks the
    // react build AND the jsx transform, and assigning it from module code is
    // too late for the transform - the mismatch renders as a crash, not as a
    // warning. The deployments borgo writes already set both.
    if (startNeedsReexec(process.env)) {
      // not the bin shim: killing a shim leaves the real server on the port
      const child = Bun.spawn([process.execPath, import.meta.path, ...process.argv.slice(2)], {
        stdout: "inherit",
        stderr: "inherit",
        stdin: "inherit",
        env: {
          ...process.env,
          ...startEnv(process.env),
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
    // an intentional stop must exit 0, or a supervisor restart-loops; the
    // flag wins the race when the signal reaches the child first. The
    // first signal is passed on and this process stays - it renders the
    // pages the requests in flight are waiting for - until the front has
    // drained them within BORGO_SHUTDOWN_TIMEOUT: exiting at once dropped
    // every request in flight, and in a container, where this is pid 1,
    // took the front's drain with it (found by hunt 3). A second signal
    // is the operator insisting. Installed before anything is awaited: a
    // stop during the rebuild, or during the imports before it, with no
    // front yet, was the default action and exit 143 (found by the
    // verifiers of that fix)
    let apiProc: import("bun").Subprocess | null = null;
    let stopping = false;
    const stop = () => {
      if (stopping || !apiProc) {
        apiProc?.kill("SIGKILL");
        process.exit(0);
      }
      stopping = true;
      apiProc.kill("SIGTERM");
      apiProc.exited.then(() => process.exit(0));
    };
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);

    // the env's pid, never process.ppid: a server started with nohup from a
    // shell that then exits must keep serving. A false death here exits 0 and
    // `Restart=on-failure` does not restart a clean exit - the site is down.
    const supervisor = Number(process.env.BORGO_SUPERVISOR_PID);
    const { watchParent } = await import("./parent-watch");
    watchParent(supervisor, () => process.exit(0), 2_000, "BORGO_SUPERVISOR_PID")?.unref();

    // the go binary answers the public port, this process is its render
    // service, and the boot key travels from here to both halves
    const { frontTopology, goFrontEnv, renderEnv, resolveRenderPort, withoutRenderEnv } = await import("./util");
    // the render port, resolved once here for both halves: a free one, or the
    // one named - refused when something already answers there. A fixed
    // default was where two apps on one machine met, every page a 403
    try {
      process.env.BORGO_RENDER_PORT = String(await resolveRenderPort(process.env));
    } catch (error) {
      console.error(`  ${c.red(g.err)} ${(error as Error).message}`);
      process.exit(1);
    }
    const topology = frontTopology(process.env);
    Object.assign(process.env, renderEnv(topology));

    // --front-only meant "the front server is here, the api is elsewhere".
    // The go binary is the front now, and this process is the render service
    // behind it on loopback - so skipping the child leaves a renderer with no
    // front, listening where nothing outside this machine can reach it. A
    // split deployment needs the go host to name a render service it can
    // reach, which is a deploy shape phase 1 has not wired yet: refused here
    // rather than started as something that cannot serve a request
    if (process.argv.includes("--front-only")) {
      console.error(
        `  ${c.red(g.err)} --front-only is not available in this topology\n` +
          `  the go binary answers the public port and this process renders behind it;\n` +
          `  running only the renderer would bind loopback with no front in front of it.\n` +
          `  a split deployment is not wired yet - run \`borgo start\` on one host for now`,
      );
      process.exit(1);
    }

    // the rebuild comes before the go front starts: the front indexes
    // public/ at boot, and a rebuild after it served every new asset as one
    // it had not vouched for - no-cache, from disk, for the process's whole
    // life (found by hunt 3)
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

    {
      const bin = `dist/${goBinName()}`;
      if (!existsSync(bin)) {
        console.error(`  ${c.red(g.err)} ${bin} not found - run \`borgo build\` first`);
        process.exit(1);
      }

      // the api watches this pid: a force-killed start leaves no orphan
      apiProc = Bun.spawn([bin], {
        stdout: "inherit",
        stderr: "inherit",
        env: {
          ...withoutRenderEnv(process.env),
          ...goFrontEnv(topology),
          BORGO_PARENT_PID: String(process.pid),
        },
      });
      apiProc.exited.then((code) => {
        if (stopping) return;
        console.error(`  ${c.red(g.err)} go front exited (${code})`);
        process.exit(code);
      });
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
    // framed like dev and start: the exporter's own carefully worded
    // refusals (a hostile prerender param, a throwing prerenderPaths) were
    // reaching the terminal as raw stack dumps instead of their message
    process.exit(await framed(exportSite));
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
