#!/usr/bin/env bun
import { existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { assetsBuildMode, buildAssets, BundleFailed, warnDeadRoutes, type BuildResult } from "./build";
import { banner, c, fmtMs, g } from "./colors";
import { parseInitArgv, unknownArg } from "./deploy";
import { goBinName, runBorgogen } from "./util";

const command = process.argv[2];

// tailwind is strictly opt-in: the flag (never detection) hands the css
// pipeline to @tailwindcss/cli; the env carries it into child processes
if (process.argv.includes("--tailwind")) process.env.BORGO_TAILWIND = "1";

// refused here, before any command runs: a flag borgo does not know is a flag
// the operator believes is doing something, and a build that ignores it exits 0
// having done something other than what was asked
const badArg = unknownArg(command, process.argv.slice(3));
if (badArg) {
  console.log(`\n  ${banner(command)}\n`);
  console.log(`  ${c.red(g.err)} ${badArg}`);
  console.log(`  usage: borgo ${command}${command === "start" ? " [--front-only]" : ""} [--tailwind]\n`);
  process.exit(1);
}

const kb = (bytes: number) => `${(bytes / 1024).toFixed(1)} kB`;

// a failed bundle is a first-class cli failure, not an escaped stack trace:
// one red line per bundler message, with the file and position bun reported
async function build(dev = false): Promise<BuildResult> {
  try {
    return await buildAssets(dev);
  } catch (error) {
    if (!(error instanceof BundleFailed)) throw error;
    console.error(`\n  ${c.red(g.err)} the client bundle failed to build`);
    for (const detail of error.details) console.error(`    ${detail}`);
    console.error(`  ${c.dim(`${g.dot} public/assets still holds the last build that worked`)}\n`);
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
    // lazy: the server module resolves react from the app, which does not
    // exist when the cli runs outside a project (e.g. bare `borgo`)
    const { dev } = await import("./dev");
    await dev();
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
    // this build swept the names the previous one emitted, so a server still
    // running from before it serves a document whose every asset url now 404s
    console.log(
      `  ${c.dim(`${g.dot} restart borgo start to serve this build ${g.dot} a server left running holds the previous document, whose assets are gone`)}\n`,
    );
    break;
  }

  case "start": {
    // bun sizes its outbound fetch pool when the process starts, and the front
    // server holds one slot for the whole life of every proxied request - for
    // an event stream, hours. At the default of 256 that ceilings concurrent
    // subscribers at ~255, silently. This process cannot raise it for itself:
    // assigning process.env after boot changes nothing, it has to be in the
    // environment bun booted with. So when nobody set it, run ourselves once
    // more with it set. Every deployment borgo writes - the Dockerfiles, the
    // systemd unit, the compose file - sets it, and pays nothing here; the
    // hand-launched server is the one that was quietly capped.
    if (!process.env.BUN_CONFIG_MAX_HTTP_REQUESTS) {
      // process.execPath and the module path, not the bin shim: a PATH lookup
      // can resolve to a shim whose kill leaves the real server on the port
      const child = Bun.spawn([process.execPath, import.meta.path, ...process.argv.slice(2)], {
        stdout: "inherit",
        stderr: "inherit",
        stdin: "inherit",
        env: {
          ...process.env,
          BUN_CONFIG_MAX_HTTP_REQUESTS: "16384",
          // the child is the one holding the api, so it has to die with us -
          // a hard kill of this process delivers no signal on windows, and
          // the api's own watchdog only watches the child
          BORGO_SUPERVISOR_PID: String(process.pid),
        },
      });
      // the supervisor is the pid a service manager signals; pass it on and
      // exit with the child's own code so a restart policy sees the truth
      for (const signal of ["SIGINT", "SIGTERM"] as const) {
        process.on(signal, () => child.kill(signal));
      }
      process.exit(await child.exited);
    }
    // the re-exec'd half: exit when the supervisor does, whatever killed it.
    // Deliberately not process.ppid - a server started with nohup from a shell
    // that then exits must keep serving, so only a borgo parent counts.
    const supervisor = Number(process.env.BORGO_SUPERVISOR_PID);
    if (supervisor > 0) {
      setInterval(() => {
        try {
          process.kill(supervisor, 0);
        } catch {
          process.exit(0);
        }
      }, 2_000).unref();
    }

    // --front-only skips the go binary, for a split deployment where the
    // api runs elsewhere (point API_URL at it)
    if (!process.argv.includes("--front-only")) {
      const bin = `dist/${goBinName()}`;
      if (!existsSync(bin)) {
        console.error(`  ${c.red(g.err)} ${bin} not found - run \`borgo build\` first`);
        process.exit(1);
      }

      // the api watches this pid and exits with it, so a force-killed start
      // (no signal on windows) cannot leave an orphan on the port
      const apiProc = Bun.spawn([bin], {
        stdout: "inherit",
        stderr: "inherit",
        env: { ...process.env, BORGO_PARENT_PID: String(process.pid) },
      });
      // an intentional stop must exit 0, or a supervisor restart-loops; the
      // flag also wins the race when the signal reaches the child first
      let stopping = false;
      const stop = () => {
        stopping = true;
        apiProc.kill();
        process.exit(0);
      };
      process.on("SIGINT", stop);
      process.on("SIGTERM", stop);
      // if the api dies on its own, exit with its real code so a supervisor
      // restarts the pair (or accepts a clean 0)
      apiProc.exited.then((code) => {
        if (stopping) return;
        console.error(`  ${c.red(g.err)} api process exited (${code})`);
        process.exit(code);
      });
    }

    // a tree last built by `borgo dev` holds dev assets (dev react, no
    // precompression), and one last built by `borgo export` holds a bundle
    // with the props endpoint compiled out - every client navigation would
    // degrade to a full document reload. Either way: rebuild for production
    // instead of serving them silently.
    // BORGO_STATIC belongs to `borgo export` and is documented as nobody's to
    // set by hand; inherited here it made every rebuild this command drives an
    // export build - the props endpoint compiled out, the mode never reaching
    // production, so the next boot rebuilt too, forever, announcing production
    // each time. Clear it before anything builds, `serve()` included
    delete process.env.BORGO_STATIC;

    const mode = assetsBuildMode();
    if (mode === "dev" || mode === "export") {
      const held = mode === "dev" ? "a dev build" : "a static export build";
      console.log(`  ${c.terracotta(g.change)} public/assets holds ${held} ${c.dim("- rebuilding for production")}`);
      const rebuildStarted = performance.now();
      await build();
      console.log(`  ${c.sage(g.ok)} built in ${c.bold(fmtMs(performance.now() - rebuildStarted))}`);
    }

    // the manifest's own warnings were printed by whoever ran `borgo build`,
    // on a machine this operator may never have seen. Without this, the route
    // table below lists a route the server answers itself as though it worked.
    try {
      const manifest = pathToFileURL(join(process.cwd(), ".borgo/routes.gen.tsx")).href;
      const { routes } = (await import(manifest)) as { routes: Array<{ pattern: string; file: string }> };
      warnDeadRoutes(routes.map(({ pattern, file }) => ({ pattern, file })));
    } catch {
      // no manifest yet, or one that will not import: serve() reports that
    }

    const { serve } = await import("./server");
    await serve({ dev: false });
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
