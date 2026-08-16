import { describe, expect, test } from "bun:test";
import {
  bunMinimum,
  checkApiBinary,
  checkApiTypes,
  checkBun,
  checkBunShim,
  checkDeps,
  checkEnginesBun,
  declaredFloor,
  checkDisk,
  checkDocker,
  checkGo,
  checkNode,
  checkNodeModules,
  checkPlaywright,
  checkPort,
  checkPortSetting,
  checkWritable,
  isFailure,
  looksLikeOwnImage,
  parseNetstatPid,
  parseVersion,
  portHolder,
  PROBE_MARK,
  probeTarget,
  probeWriteWith,
  realEnv,
  sweepProbes,
  resolvePort,
  runChecks,
  versionAtLeast,
  type DoctorEnv,
} from "../src/doctor";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { networkInterfaces, tmpdir } from "node:os";
import { join } from "node:path";

function fakeEnv(overrides: Partial<DoctorEnv> = {}): DoctorEnv {
  return {
    platform: "linux",
    env: {},
    which: () => "/usr/bin/tool",
    exec: () => ({ code: 0, out: "" }),
    exists: () => false,
    mtime: () => null,
    listDir: () => [],
    listTree: () => [],
    readFile: () => null,
    resolve: () => null,
    openForWrite: () => "ok",
    probeWrite: () => "ok",
    diskFree: () => 40 * 1024 ** 3,
    isPortFree: async () => true,
    ...overrides,
  };
}

describe("versions", () => {
  test("parseVersion", () => {
    expect(parseVersion("1.3.14")).toEqual([1, 3, 14]);
    expect(parseVersion("go1.26")).toEqual([1, 26, 0]);
    expect(parseVersion("nope")).toBeNull();
  });

  test("versionAtLeast", () => {
    expect(versionAtLeast("1.3.14", "1.3.0")).toBe(true);
    expect(versionAtLeast("1.3.0", "1.3.0")).toBe(true);
    expect(versionAtLeast("1.2.9", "1.3.0")).toBe(false);
    expect(versionAtLeast("2.0.0", "1.9.9")).toBe(true);
    expect(versionAtLeast("1.26", "1.25")).toBe(true);
    expect(versionAtLeast("garbage", "1.0.0")).toBe(false);
  });
});

describe("checkBun", () => {
  test("missing from PATH", () => {
    const r = checkBun(fakeEnv({ which: () => null }));
    expect(r.ok).toBe(false);
    expect(r.fix).toContain("bun.sh/install");
  });

  test("npm shim without bun.exe on windows", () => {
    const r = checkBun(
      fakeEnv({
        platform: "win32",
        which: (cmd) => (cmd === "bun" ? "C:\\nodejs\\bun.CMD" : null),
      }),
    );
    expect(r.ok).toBe(false);
    expect(r.detail).toContain("shim");
    expect(r.fix).toContain("official installer");
  });

  test("real bun.exe on windows passes", () => {
    const r = checkBun(
      fakeEnv({
        platform: "win32",
        which: () => "C:\\Users\\x\\.bun\\bin\\bun.exe",
        exec: () => ({ code: 0, out: "1.3.14\n" }),
      }),
    );
    expect(r.ok).toBe(true);
    expect(r.detail).toContain("1.3.14");
  });

  test("too old", () => {
    const r = checkBun(fakeEnv({ exec: () => ({ code: 0, out: "1.2.0\n" }) }));
    expect(r.ok).toBe(false);
    expect(r.fix).toBe("bun upgrade");
  });

  // windows reaches the node_modules branch only past the shim branch above
  // it, so a linux-only fake never exercises that order
  test("an npm-installed shim under node_modules is refused on any platform", () => {
    for (const platform of ["linux", "darwin", "win32"] as const) {
      const found =
        platform === "win32" ? "C:\\app\\node_modules\\.bin\\bun.exe" : "/app/node_modules/.bin/bun";
      const r = checkBun(fakeEnv({ platform, which: () => found }));
      expect(`${platform}: ${isFailure(r)}`).toBe(`${platform}: true`);
      expect(`${platform}: ${r.detail}`).toContain("shadows the real bun");
      expect(r.fix).toContain("bun.sh/install");
    }
  });

  // the shape npm leaves on windows: a .cmd with no bun.exe behind it, caught
  // by the shim branch first - a different message, never a pass
  test("the .cmd an npm install leaves on windows is refused too", () => {
    const r = checkBun(
      fakeEnv({
        platform: "win32",
        which: (cmd) => (cmd === "bun" ? "C:\\app\\node_modules\\.bin\\bun.CMD" : null),
      }),
    );
    expect(isFailure(r)).toBe(true);
    expect(r.detail).toContain("shim");
  });

  describe("minimum version", () => {
    const withEngines = (engines: unknown) =>
      fakeEnv({
        exists: (p) => p === "package.json",
        readFile: (p) => (p === "package.json" ? JSON.stringify({ engines }) : null),
      });

    test("the app's engines.bun raises the floor", () => {
      expect(bunMinimum(withEngines({ bun: ">=1.4.2" }))).toEqual({
        min: "1.4.2",
        source: "package.json engines.bun",
      });
    });

    test("no engines field falls back to borgo's own floor", () => {
      expect(bunMinimum(fakeEnv()).source).toBe("borgo");
      expect(bunMinimum(withEngines({ node: ">=20" })).source).toBe("borgo");
    });

    test("an unparseable engines range is ignored rather than trusted", () => {
      expect(bunMinimum(withEngines({ bun: "latest" })).source).toBe("borgo");
    });

    // the floor used to be "the first version in the string", which reads a
    // ceiling as a floor: `"<1.5.0"` is an app saying it cannot run on 1.5 yet,
    // and doctor turned it into "you need at least 1.5.0" and exited 1 on a
    // machine whose bun was exactly what the app asked for.
    test("a ceiling is not a floor", () => {
      for (const range of ["<1.5.0", "<=1.4.9", "<2"]) {
        const got = bunMinimum(withEngines({ bun: range }));
        expect(`${range}: ${got.min} from ${got.source}`).toBe(`${range}: 1.3.0 from borgo`);
        expect(got.unreadable).toContain(range);
      }
    });

    test("the forms borgo does read, and where each one puts its floor", () => {
      const floors: Array<[string, string | null]> = [
        [">=1.4.2", "1.4.2"],
        [">1.4.2", "1.4.2"],
        ["^1.4.2", "1.4.2"],
        ["~1.4.2", "1.4.2"],
        ["=1.4.2", "1.4.2"],
        ["1.4.2", "1.4.2"],
        ["v1.4.2", "1.4.2"],
        ["1.4", "1.4.0"],
        [">=1.3.2 <2", "1.3.2"],
        ["1.4.2 - 2.0.0", "1.4.2"],
        // and the ones with no floor borgo will guess at
        ["<1.5.0", null],
        ["*", null],
        ["1.x", null],
        ["latest", null],
        ["^1.2 || ^2", null],
        ["", null],
      ];
      for (const [range, want] of floors) {
        expect(`${range || "(empty)"} -> ${declaredFloor(range)}`).toBe(`${range || "(empty)"} -> ${want}`);
      }
    });

    // a range borgo cannot read is the operator's to resolve, not a broken
    // machine: the check is a note, it never touches the exit code, and it says
    // which forms would have been read
    test("an unreadable range is reported as a note naming the forms borgo reads", () => {
      const note = checkEnginesBun(withEngines({ bun: "<1.5.0" }))!;
      expect(note.info).toBe(true);
      expect(isFailure(note)).toBe(false);
      expect(note.detail).toContain('"<1.5.0"');
      expect(note.detail).toContain("1.3.0");
      expect(note.fix).toContain(">=1.3.0");
      // nothing to say about a range it reads, or about an app that declares none
      expect(checkEnginesBun(withEngines({ bun: ">=1.4.2" }))).toBeNull();
      expect(checkEnginesBun(fakeEnv())).toBeNull();
    });

    test("a machine on a bun the app excluded is not failed by the ceiling", () => {
      const d = withEngines({ bun: "<1.5.0" });
      expect(checkBun({ ...d, exec: () => ({ code: 0, out: "1.3.14\n" }) }).ok).toBe(true);
    });

    // an app may ask for a newer bun than borgo does; asking for an older one
    // is not a relaxation it gets to grant itself. `"bun": "^1.2"` used to
    // lower the floor below MIN_BUN outright, so doctor put a green tick next
    // to a bun that `borgo build` then failed on
    test("a floor below borgo's own is raised, not honoured", () => {
      expect(bunMinimum(withEngines({ bun: "^1.2" }))).toEqual({ min: "1.3.0", source: "borgo" });
      expect(bunMinimum(withEngines({ bun: ">=1.0.0" })).min).toBe("1.3.0");
      // borgo's own floor exactly: either source is honest, the number is what matters
      expect(bunMinimum(withEngines({ bun: "1.3.0" })).min).toBe("1.3.0");
    });

    test("a bun below borgo's floor fails even when the app declares less", () => {
      const d = withEngines({ bun: "^1.2" });
      const r = checkBun({ ...d, exec: () => ({ code: 0, out: "1.2.9\n" }) });
      expect(r.ok).toBe(false);
      expect(r.detail).toContain("1.3.0");
    });

    test("a bun that satisfies borgo but not the app is flagged as too old", () => {
      const d = withEngines({ bun: ">=1.4.2" });
      const r = checkBun({ ...d, exec: () => ({ code: 0, out: "1.3.14\n" }) });
      expect(r.ok).toBe(false);
      expect(r.detail).toContain("older than the required 1.4.2");
      expect(r.detail).toContain("package.json engines.bun");
    });

    test("and the same bun passes once the app asks for less", () => {
      const d = withEngines({ bun: ">=1.3.0" });
      expect(checkBun({ ...d, exec: () => ({ code: 0, out: "1.3.14\n" }) }).ok).toBe(true);
    });
  });
});

describe("checkBunShim", () => {
  // the real shape this was written for: nvm-for-windows puts a bun.cmd next
  // to node.exe, and it wins over the official install on PATH
  const shimmed = (over: Partial<DoctorEnv> = {}) =>
    fakeEnv({
      platform: "win32",
      which: (cmd) =>
        cmd === "bun" ? "C:\\nvm4w\\nodejs\\bun.cmd" : "C:\\Users\\x\\.bun\\bin\\bun.exe",
      ...over,
    });

  test("a .cmd shim shadowing a real bun.exe is a note, not a failure", () => {
    const r = checkBunShim(shimmed());
    expect(r!.ok).toBe(false);
    expect(r!.info).toBe(true);
    expect(isFailure(r!)).toBe(false);
    expect(r!.detail).toBe("C:\\nvm4w\\nodejs\\bun.cmd shadows C:\\Users\\x\\.bun\\bin\\bun.exe");
    expect(r!.fix).toContain("ahead of it on PATH");
  });

  test("and the version check still runs through the shim", () => {
    const r = checkBun(shimmed({ exec: () => ({ code: 0, out: "1.3.14\n" }) }));
    expect(r.ok).toBe(true);
    expect(r.detail).toContain("1.3.14");
  });

  test("a real bun.exe on PATH says nothing", () => {
    expect(checkBunShim(fakeEnv({ which: () => "C:\\Users\\x\\.bun\\bin\\bun.exe" }))).toBeNull();
  });

  test("no shim, no bun, nothing to say", () => {
    expect(checkBunShim(fakeEnv({ which: () => null }))).toBeNull();
  });

  test("a shim with no real bun behind it is checkBun's failure, not a note", () => {
    const d = fakeEnv({
      platform: "win32",
      which: (cmd) => (cmd === "bun" ? "C:\\nodejs\\bun.CMD" : null),
    });
    expect(checkBunShim(d)).toBeNull();
    expect(isFailure(checkBun(d))).toBe(true);
  });
});

describe("checkNode", () => {
  test("present: reports the version, informational", () => {
    const r = checkNode(fakeEnv({ exec: () => ({ code: 0, out: "v22.11.0\n" }) }));
    expect(r.ok).toBe(true);
    expect(r.info).toBe(true);
    expect(r.detail).toContain("22.11.0");
  });

  test("absent: a note, never a failure", () => {
    const r = checkNode(fakeEnv({ which: () => null }));
    expect(r.ok).toBe(false);
    expect(r.info).toBe(true);
    expect(isFailure(r)).toBe(false);
    expect(r.fix).toContain("borgo does not");
  });

  test("present but mute about its version still passes", () => {
    const r = checkNode(fakeEnv({ exec: () => ({ code: 1, out: "" }) }));
    expect(r.ok).toBe(true);
  });
});

describe("checkDocker", () => {
  test("not installed is a note with the install link", () => {
    const r = checkDocker(fakeEnv({ which: () => null }));
    expect(r.ok).toBe(false);
    expect(r.info).toBe(true);
    expect(isFailure(r)).toBe(false);
    expect(r.fix).toContain("docs.docker.com");
  });

  test("installed with a reachable daemon reports the server version", () => {
    const r = checkDocker(fakeEnv({ exec: () => ({ code: 0, out: "27.3.1\n" }) }));
    expect(r.ok).toBe(true);
    expect(r.detail).toContain("server 27.3.1");
  });

  test("installed but the daemon is down: a note, and how to start it", () => {
    const r = checkDocker(fakeEnv({ exec: () => ({ code: 1, out: "" }) }));
    expect(r.ok).toBe(false);
    expect(r.info).toBe(true);
    expect(r.detail).toContain("daemon is not reachable");
    expect(r.fix).toBe("sudo systemctl start docker");
  });

  test("a daemon that answers empty counts as unreachable, not as version ''", () => {
    const r = checkDocker(fakeEnv({ exec: () => ({ code: 0, out: "\n" }) }));
    expect(r.ok).toBe(false);
  });

  test("the fix names docker desktop off linux", () => {
    const r = checkDocker(fakeEnv({ platform: "win32", exec: () => ({ code: 1, out: "" }) }));
    expect(r.fix).toBe("start docker desktop");
  });
});

describe("checkWritable", () => {
  const inApp = (over: Partial<DoctorEnv> = {}) =>
    fakeEnv({ exists: (p) => p === "package.json", ...over });

  test("skipped outside an app", () => {
    expect(checkWritable(fakeEnv())).toBeNull();
  });

  test("all writable passes and names what was probed", () => {
    const r = checkWritable(inApp());
    expect(r!.ok).toBe(true);
    expect(r!.detail).toContain(".borgo");
    expect(r!.detail).toContain("public/assets");
    expect(r!.detail).toContain("dist");
  });

  test("a read-only assets dir fails naming it, with a fix for the platform", () => {
    const r = checkWritable(inApp({ probeWrite: (dir) => (dir === "public/assets" ? "denied" : "ok") }));
    expect(r!.ok).toBe(false);
    expect(isFailure(r!)).toBe(true);
    expect(r!.detail).toContain("public/assets");
    expect(r!.detail).not.toContain(".borgo");
    expect(r!.fix).toContain("chmod u+w public/assets");
  });

  test("a read-only checkout names every denied directory", () => {
    const r = checkWritable(inApp({ platform: "win32", probeWrite: () => "denied" }));
    expect(r!.detail).toContain(".borgo, public/assets, dist");
    expect(r!.fix).toContain("icacls");
  });
});

describe("checkDisk", () => {
  test("plenty of room passes with a human size", () => {
    const r = checkDisk(fakeEnv({ diskFree: () => 12 * 1024 ** 3 }));
    expect(r!.ok).toBe(true);
    expect(r!.detail).toBe("12.0 GB free");
  });

  test("below the threshold fails and says what wants the space", () => {
    const r = checkDisk(fakeEnv({ diskFree: () => 100 * 1024 ** 2 }));
    expect(r!.ok).toBe(false);
    expect(r!.detail).toContain("100 MB free");
    expect(r!.detail).toContain("512 MB");
    expect(r!.fix).toContain("free up space");
  });

  test("an fs that cannot answer is not reported at all", () => {
    expect(checkDisk(fakeEnv({ diskFree: () => null }))).toBeNull();
  });

  test("the real statfs answers a number for the cwd", () => {
    const free = realEnv().diskFree(".");
    expect(typeof free).toBe("number");
    expect(free!).toBeGreaterThan(0);
  });
});

describe("checkPlaywright", () => {
  const app = (pkg: unknown, over: Partial<DoctorEnv> = {}) =>
    fakeEnv({
      exists: (p) => p === "package.json",
      readFile: (p) => (p === "package.json" ? JSON.stringify(pkg) : null),
      ...over,
    });

  test("an app without playwright is not nagged", () => {
    expect(checkPlaywright(app({ devDependencies: { typescript: "^5" } }))).toBeNull();
    expect(checkPlaywright(fakeEnv())).toBeNull();
  });

  test("a dependency with no browsers installed fails with the install command", () => {
    const r = checkPlaywright(
      app({ devDependencies: { "@playwright/test": "^1.50.0" } }, { env: { HOME: "/home/x" } }),
    );
    expect(r!.ok).toBe(false);
    expect(r!.detail).toContain("@playwright/test");
    expect(r!.detail).toContain("/home/x/.cache/ms-playwright");
    expect(r!.fix).toBe("bunx playwright install");
  });

  test("installed browsers pass, counted", () => {
    const r = checkPlaywright(
      app(
        { dependencies: { playwright: "^1.50.0" } },
        { env: { HOME: "/home/x" }, listDir: () => ["chromium-1148", "firefox-1471", ".links"] },
      ),
    );
    expect(r!.ok).toBe(true);
    expect(r!.detail).toContain("2 browsers");
  });

  test("PLAYWRIGHT_BROWSERS_PATH is honoured, including the documented 0", () => {
    const seen: string[] = [];
    const spy = (dir: string) => (seen.push(dir), [] as string[]);
    checkPlaywright(app({ devDependencies: { playwright: "1" } }, { env: { PLAYWRIGHT_BROWSERS_PATH: "/opt/pw" }, listDir: spy }));
    checkPlaywright(app({ devDependencies: { playwright: "1" } }, { env: { PLAYWRIGHT_BROWSERS_PATH: "0" }, listDir: spy }));
    expect(seen[0]).toBe("/opt/pw");
    expect(seen[1]).toBe("node_modules/playwright-core/.local-browsers");
  });

  test("windows looks under LOCALAPPDATA", () => {
    const seen: string[] = [];
    checkPlaywright(
      app(
        { devDependencies: { playwright: "1" } },
        { platform: "win32", env: { LOCALAPPDATA: "C:/Users/x/AppData/Local" }, listDir: (d) => (seen.push(d), []) },
      ),
    );
    expect(seen[0]).toBe("C:/Users/x/AppData/Local/ms-playwright");
  });
});

describe("the exit code contract", () => {
  test("notes never turn the exit code red", async () => {
    // an environment with no node, no docker and nothing else wrong
    const results = await runChecks(
      fakeEnv({
        which: (cmd) => (cmd === "node" || cmd === "docker" ? null : "/usr/bin/tool"),
        exec: (cmd) => ({ code: 0, out: cmd[0] === "go" ? "go version go1.26.4 linux/amd64" : "1.3.14" }),
      }),
    );
    const notes = results.filter((r) => !r.ok && r.info);
    expect(notes.map((r) => r.name).sort()).toEqual(["docker", "node"]);
    expect(results.filter(isFailure)).toEqual([]);
  });

  test("a real failure alongside the notes still fails", async () => {
    const results = await runChecks(
      fakeEnv({
        which: (cmd) => (cmd === "docker" ? null : cmd === "bun" ? null : "/usr/bin/tool"),
        exec: () => ({ code: 0, out: "go version go1.26.4 linux/amd64" }),
      }),
    );
    expect(results.filter(isFailure).map((r) => r.name)).toEqual(["bun"]);
  });
});

describe("checkGo", () => {
  test("missing", () => {
    const r = checkGo(fakeEnv({ which: () => null }));
    expect(r.ok).toBe(false);
    expect(r.fix).toContain("go.dev/dl");
  });

  test("older than the app's go.mod requirement", () => {
    const r = checkGo(
      fakeEnv({
        exec: () => ({ code: 0, out: "go version go1.24.1 linux/amd64" }),
        readFile: (p) => (p === "go.mod" ? "module app\n\ngo 1.25.0\n" : null),
      }),
    );
    expect(r.ok).toBe(false);
    expect(r.detail).toContain("go1.24.1");
    expect(r.detail).toContain("1.25.0");
  });

  test("recent enough", () => {
    const r = checkGo(fakeEnv({ exec: () => ({ code: 0, out: "go version go1.26.4 windows/amd64" }) }));
    expect(r.ok).toBe(true);
    expect(r.detail).toContain("go1.26.4");
  });
});

describe("ports", () => {
  const netstat = [
    "Active Connections",
    "  TCP    0.0.0.0:3000           0.0.0.0:0              LISTENING       4321",
    "  TCP    [::]:3501              [::]:0                 LISTENING       8765",
    "  TCP    127.0.0.1:9999         127.0.0.1:50000        ESTABLISHED     1111",
  ].join("\r\n");

  test("parseNetstatPid", () => {
    expect(parseNetstatPid(netstat, 3000)).toBe("4321");
    expect(parseNetstatPid(netstat, 3501)).toBe("8765");
    expect(parseNetstatPid(netstat, 9999)).toBeNull();
  });

  test("parseNetstatPid on a localized windows (italian)", () => {
    const localized = [
      "Connessioni attive",
      "  TCP    0.0.0.0:3000           0.0.0.0:0              IN ASCOLTO      4321",
      "  TCP    127.0.0.1:9999         127.0.0.1:50000        STABILITA       1111",
    ].join("\r\n");
    expect(parseNetstatPid(localized, 3000)).toBe("4321");
    expect(parseNetstatPid(localized, 9999)).toBeNull();
  });

  test("free port passes", async () => {
    const r = await checkPort(fakeEnv(), 3000, "front", "PORT");
    expect(r.ok).toBe(true);
  });

  const heldBy = (image: string) =>
    fakeEnv({
      platform: "win32",
      isPortFree: async () => false,
      exec: (cmd) =>
        cmd[0] === "netstat"
          ? { code: 0, out: netstat }
          : { code: 0, out: `"${image}","4321","Console","1","10,000 K"` },
    });

  test("busy port names the holder on windows", async () => {
    const r = await checkPort(heldBy("api.exe"), 3000, "front", "PORT");
    expect(r.ok).toBe(false);
    expect(r.detail).toContain("api.exe");
    expect(r.detail).toContain("4321");
    expect(r.fix).toContain("taskkill /F /PID 4321");
    // the image is one borgo runs under, so the advice says so - as a
    // condition the reader resolves, not as a fact doctor established
    expect(r.fix).toContain("your own borgo");
  });

  /**
   * The measured case, on a real machine: `bun some-script.ts` holding :3000
   * was reported "in use by borgo itself - bun.exe (pid 4284)" and doctor
   * exited 0, while `borgo dev` could not bind. Every bun is called bun, so
   * the image name never carried the identity the message claimed.
   *
   * A diagnostic must not assert more than it verified. It verified that the
   * port is taken and by which image; both of those are said, and neither is
   * turned into "that is us, carry on".
   */
  test("a bun that is not borgo is reported as a bun, and counts", async () => {
    const r = await checkPort(heldBy("bun.exe"), 3000, "front", "PORT");
    expect(isFailure(r)).toBe(true);
    expect(r.info).toBeUndefined();
    expect(r.detail).toBe("in use by bun.exe (pid 4321)");
    expect(r.detail).not.toContain("borgo itself");
  });

  // a neighbouring project's binary, sharing a substring with ours on purpose:
  // misclassified as a note, doctor reads healthy while nothing can start
  test("a port held by a stranger is a failure, not a note", async () => {
    const r = await checkPort(heldBy("myapi.exe"), 3000, "front", "PORT");
    expect(isFailure(r)).toBe(true);
    expect(r.info).toBeUndefined();
    expect(r.detail).toContain("in use by myapi.exe (pid 4321)");
    expect(r.detail).not.toContain("borgo itself");
    expect(r.fix).toContain("taskkill /F /PID 4321");
    expect(r.fix).toContain("PORT");
  });

  test("busy port without a known holder still suggests the env var", async () => {
    const r = await checkPort(
      fakeEnv({ isPortFree: async () => false, exec: () => ({ code: 1, out: "" }) }),
      3501,
      "api",
      "API_PORT",
    );
    expect(r.ok).toBe(false);
    expect(r.fix).toContain("API_PORT");
  });

  // the real probe, not the injected one: a holder bound to the wildcard
  // address without SO_EXCLUSIVEADDRUSE (go's net.Listen, and so borgo's own
  // api on windows) still leaves 127.0.0.1 bindable, so a loopback-pinned
  // probe would call an answering port free.
  // NOTE: this case separates the two probes only on windows - on linux a
  // wildcard holder already blocks a loopback bind. The test below does both.
  test("the real probe sees a wildcard holder that leaves loopback bindable", async () => {
    const held = Bun.serve({ port: 0, hostname: "0.0.0.0", reusePort: true, fetch: () => new Response("x") });
    try {
      expect(await realEnv().isPortFree(held.port!)).toBe(false);
    } finally {
      held.stop(true);
    }
  });

  // a non-loopback holder overlaps the wildcard the probe binds and nothing a
  // 127.0.0.1-pinned probe would try: the case that separates them on linux too
  const external = Object.values(networkInterfaces())
    .flat()
    .find((i) => i && i.family === "IPv4" && !i.internal)?.address;
  const hostBound = external ? test : test.skip;
  hostBound("the real probe sees a holder pinned to a non-loopback address", async () => {
    const held = Bun.serve({ port: 0, hostname: external!, fetch: () => new Response("x") });
    try {
      expect(await realEnv().isPortFree(held.port!)).toBe(false);
    } finally {
      held.stop(true);
    }
  });

  test("the real probe calls an unheld port free", async () => {
    const probe = Bun.serve({ port: 0, fetch: () => new Response("x") });
    const port = probe.port!;
    probe.stop(true);
    expect(await realEnv().isPortFree(port)).toBe(true);
  });

  // the short image names lsof leaves after truncation, matched exactly: on a
  // substring the neighbours below would read as ours too
  test("looksLikeOwnImage separates borgo's images from the ones that resemble them", () => {
    for (const own of ["bun", "api", "borgo", "api.exe", "BUN.EXE", "/usr/local/bin/bun", "C:\\app\\.borgo\\api.exe"]) {
      expect(`${own}: ${looksLikeOwnImage(own)}`).toBe(`${own}: true`);
    }
    for (const other of ["myapi.exe", "chat-api", "apiserver", "rapid.exe", "bunny.exe", "borgo-proxy", "nginx.exe"]) {
      expect(`${other}: ${looksLikeOwnImage(other)}`).toBe(`${other}: false`);
    }
  });

  /**
   * Measured by running it: `PORT=abc borgo doctor` threw
   * ERR_INVALID_ARG_VALUE out of net.listen and printed a stack trace instead
   * of a report; `PORT=70000` threw a RangeError; `PORT=0` printed
   * "port 0 free", which names no port `borgo dev` can be found on.
   */
  test("resolvePort refuses what is not a port instead of handing it to listen", () => {
    expect(resolvePort(undefined, 3000)).toBe(3000);
    expect(resolvePort("", 3000)).toBe(3000);
    expect(resolvePort("8080", 3000)).toBe(8080);
    expect(resolvePort("65535", 3000)).toBe(65535);
    for (const bad of ["abc", "3000abc", "0", "-1", "70000", "3000.5", " ", "NaN"]) {
      expect(`${bad}: ${resolvePort(bad, 3000)}`).toBe(`${bad}: null`);
    }
  });

  test("an unusable PORT is reported, not thrown", async () => {
    const r = await checkPortSetting(
      fakeEnv({ env: { PORT: "abc" }, isPortFree: async () => { throw new Error("must not bind"); } }),
      "PORT",
      3000,
      "front",
    );
    expect(isFailure(r)).toBe(true);
    expect(r.detail).toContain('PORT is "abc"');
    expect(r.fix).toContain("unset it to use 3000");
  });

  test("a usable PORT is checked as that port", async () => {
    const r = await checkPortSetting(fakeEnv({ env: { PORT: "8080" } }), "PORT", 3000, "front");
    expect(r.name).toBe("port 8080 (front)");
    expect(r.ok).toBe(true);
  });

  test("portHolder parses lsof output", () => {
    const out = [
      "COMMAND  PID  USER   FD   TYPE DEVICE SIZE/OFF NODE NAME",
      "api     4242 luigi   3u  IPv4 123456      0t0  TCP *:3501 (LISTEN)",
    ].join("\n");
    const holder = portHolder(fakeEnv({ exec: () => ({ code: 0, out }) }), 3501);
    expect(holder).toEqual({ pid: "4242", name: "api" });
  });
});

describe("checkApiBinary", () => {
  test("no binary is fine", () => {
    expect(checkApiBinary(fakeEnv()).ok).toBe(true);
  });

  /**
   * Measured by running it: with a healthy `borgo dev` up, this check printed
   * red and doctor exited 1 - `.borgo/api.exe is locked by a running "api"
   * process, dev cannot swap in a new build`. Both halves went past the
   * evidence. `openForWrite` calls every error but ENOENT "busy", so the
   * holder is not established; and dev kills its own api before the rename
   * and retries twenty times, so "cannot swap" is false in precisely the
   * state that produces the message.
   *
   * The check may say the file would not open. It may not say who has it or
   * what that prevents.
   */
  test("a binary that will not open reports that, and nothing beyond it", () => {
    const r = checkApiBinary(
      fakeEnv({
        platform: "win32",
        exists: (p) => p === ".borgo/api.exe",
        openForWrite: () => "busy",
      }),
    );
    expect(r.ok).toBe(false);
    expect(r.detail).toBe(".borgo/api.exe cannot be opened for writing");
    expect(r.detail).not.toContain("process");
    expect(r.detail).not.toContain("cannot swap");
    expect(r.fix).toContain("taskkill /F /IM api.exe");
  });

  // the port checks report what verifiably blocks a dev session; this one
  // verified only that a file would not open, which stops nothing by itself
  test("a locked binary is a note, so it does not fail a working dev session", () => {
    const r = checkApiBinary(
      fakeEnv({
        platform: "win32",
        exists: (p) => p === ".borgo/api.exe",
        openForWrite: () => "busy",
      }),
    );
    expect(r.info).toBe(true);
    expect(isFailure(r)).toBe(false);
  });

  // off windows the check returns before consulting openForWrite, so a linux
  // fake here tests the early return and leaves this branch uncovered
  test("an unlocked binary on windows passes", () => {
    const probed: string[] = [];
    const r = checkApiBinary(
      fakeEnv({
        platform: "win32",
        exists: (p) => p === ".borgo/api.exe",
        openForWrite: (p) => (probed.push(p), "ok"),
      }),
    );
    expect(probed).toEqual([".borgo/api.exe"]);
    expect(r.ok).toBe(true);
    expect(r.detail).toContain("swappable");
  });

  test("a running binary off windows still passes (ETXTBSY is not a lock)", () => {
    const r = checkApiBinary(
      fakeEnv({ exists: (p) => p === ".borgo/api", openForWrite: () => "busy" }),
    );
    expect(r.ok).toBe(true);
  });
});

describe("checkApiTypes", () => {
  test("skipped without an api dir", () => {
    expect(checkApiTypes(fakeEnv())).toBeNull();
  });

  test("missing types file fails", () => {
    const r = checkApiTypes(fakeEnv({ exists: (p) => p === "api" }));
    expect(r!.ok).toBe(false);
    expect(r!.fix).toContain("go tool borgogen");
  });

  test("stale types fail naming the newer file", () => {
    const r = checkApiTypes(
      fakeEnv({
        exists: (p) => p === "api",
        listTree: () => ["tasks.go", "notes.txt"],
        mtime: (p) => (p === ".borgo/api-types.d.ts" ? 1000 : 500_000),
      }),
    );
    expect(r!.ok).toBe(false);
    expect(r!.detail).toContain("api/tasks.go");
  });

  test("fresh types pass", () => {
    const r = checkApiTypes(
      fakeEnv({
        exists: (p) => p === "api",
        listTree: () => ["tasks.go"],
        mtime: (p) => (p === ".borgo/api-types.d.ts" ? 500_000 : 1000),
      }),
    );
    expect(r!.ok).toBe(true);
  });

  // borgogen reads every .go file under api/, at any depth. a non-recursive
  // listing reported "fresh" for an app whose handlers live one directory
  // down no matter how far behind the generated types had fallen - and that
  // is the layout every api past a handful of endpoints grows into
  test("a handler in a subdirectory is checked too", () => {
    const r = checkApiTypes(
      fakeEnv({
        exists: (p) => p === "api",
        listTree: () => ["users/handlers.go"],
        mtime: (p) => (p === ".borgo/api-types.d.ts" ? 1000 : 500_000),
      }),
    );
    expect(r!.ok).toBe(false);
    expect(r!.detail).toContain("api/users/handlers.go");
  });

  // the real env, not a stub: the recursion has to survive readdirSync's
  // parentPath shape and windows separators, which a hand-written fake hides
  test("realEnv.listTree walks the whole tree with forward slashes", () => {
    const dir = mkdtempSync(join(tmpdir(), "borgo-tree-"));
    try {
      mkdirSync(join(dir, "users"), { recursive: true });
      writeFileSync(join(dir, "root.go"), "package api");
      writeFileSync(join(dir, "users", "handlers.go"), "package users");
      expect(realEnv().listTree(dir).sort()).toEqual(["root.go", "users/handlers.go"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("project checks", () => {
  test("skipped outside an app", () => {
    expect(checkNodeModules(fakeEnv())).toBeNull();
    expect(checkDeps(fakeEnv())).toBeNull();
  });

  test("missing node_modules fails with bun install", () => {
    const r = checkNodeModules(fakeEnv({ exists: (p) => p === "package.json" }));
    expect(r!.ok).toBe(false);
    expect(r!.fix).toBe("bun install");
  });

  const appFs = (files: Record<string, string>) =>
    fakeEnv({
      exists: (p) => ["package.json", "node_modules", "api"].includes(p),
      resolve: (spec) => (files[spec] !== undefined ? spec : null),
      readFile: (p) => files[p] ?? null,
    });

  test("react/react-dom version mismatch fails", () => {
    const r = checkDeps(
      appFs({
        "borgo-framework/package.json": '{"version":"0.10.1"}',
        "react/package.json": '{"version":"19.2.0"}',
        "react-dom/package.json": '{"version":"19.1.0"}',
        "go.mod": "tool github.com/LuigiDavideMicca/borgo/cmd/borgogen",
      }),
    );
    expect(r!.ok).toBe(false);
    expect(r!.detail).toContain("differ");
  });

  test("missing tool directive fails", () => {
    const r = checkDeps(
      appFs({
        "borgo-framework/package.json": '{"version":"0.10.1"}',
        "react/package.json": '{"version":"19.2.0"}',
        "react-dom/package.json": '{"version":"19.2.0"}',
        "go.mod": "module app\n\ngo 1.25.0\n",
      }),
    );
    expect(r!.ok).toBe(false);
    expect(r!.fix).toContain("tool github.com/LuigiDavideMicca/borgo/cmd/borgogen");
  });

  test("sane deps pass", () => {
    const r = checkDeps(
      appFs({
        "borgo-framework/package.json": '{"version":"0.10.1"}',
        "react/package.json": '{"version":"19.2.0"}',
        "react-dom/package.json": '{"version":"19.2.0"}',
        "go.mod": "module app\n\ngo 1.25.0\n\ntool github.com/LuigiDavideMicca/borgo/cmd/borgogen\n",
      }),
    );
    expect(r!.ok).toBe(true);
    expect(r!.detail).toContain("borgo-framework 0.10.1");
  });
});

// A CHECK THAT WRITES TO FIND OUT WHETHER IT CAN WRITE, AND THEN LEAVES THE FILE.
//
// probeWrite was `write; remove; return "ok"` in one try. Measured on windows
// with delete denied by ACL (icacls /deny <user>:(DC) plus (OI)(CI)(DE) on the
// directory): it answered "denied" for a directory whose write had just
// succeeded, and `.borgo-doctor-3048` was still on disk afterwards - the file
// proving the write had worked was the same file the answer said was
// impossible. Both halves come from the same missing finally.
describe("probeWrite", () => {
  test("the answer is the write, not the removal", () => {
    const removed: string[] = [];
    const refuses = () => {
      throw new Error("EPERM");
    };
    // the write lands, the removal is refused: the directory is writable
    expect(probeWriteWith("/p", () => {}, refuses)).toBe("ok");
    // and the removal is still attempted on the branch that says no
    expect(probeWriteWith("/p", refuses, (path) => removed.push(path))).toBe("denied");
    expect(removed).toEqual(["/p"]);
  });

  test("the probe is removed on every branch", () => {
    const removed: string[] = [];
    const remove = (path: string) => removed.push(path);
    probeWriteWith("/ok", () => {}, remove);
    probeWriteWith(
      "/no",
      () => {
        throw new Error("EACCES");
      },
      remove,
    );
    expect(removed).toEqual(["/ok", "/no"]);
  });

  // borgo creates .borgo, dist and public/assets on demand, so a missing one is
  // the parent's permission and not its own
  test("probes the nearest existing ancestor of a directory borgo has not made yet", () => {
    const dir = mkdtempSync(join(tmpdir(), "borgo-probetarget-"));
    try {
      expect(probeTarget(dir, existsSync)).toBe(dir);
      expect(probeTarget(join(dir, "dist"), existsSync)).toBe(dir);
      expect(probeTarget(join(dir, "a", "b", "c"), existsSync)).toBe(dir);
      // a relative name whose ancestors run out lands on the cwd
      expect(probeTarget("borgo-nothing-here-at-all", existsSync)).toBe(".");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("the real probe leaves nothing behind", () => {
    const dir = mkdtempSync(join(tmpdir(), "borgo-probewrite-"));
    try {
      expect(realEnv().probeWrite(dir)).toBe("ok");
      expect(readdirSync(dir)).toEqual([]);
      // and for a directory borgo would create, the probe lands in the parent
      // and is cleaned up there too
      expect(realEnv().probeWrite(join(dir, "dist"))).toBe("ok");
      expect(readdirSync(dir)).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// A KILLED DOCTOR'S PROBE FILE, WHICH NOTHING EVER REMOVED.
//
// The window is two adjacent syscalls of a synchronous try/finally - 333 us
// per write+unlink pair against a 679 ms `borgo doctor` on examples/tasks - so
// a hard kill rarely lands in it, but the residue never heals: the name
// carries the pid and the next run writes a different one. Measured with
// taskkill /F held inside the window: the file is still there afterwards.
//
// It is not inert. Measured: a `.borgo-doctor-4242` in public/assets is
// indexed by buildAssetIndex and answered by findAsset, so it is served at a
// public url, and `borgo export` copies public/ wholesale into dist/site where
// countAssets counts it. In a project that has not built yet none of the three
// targets exist, so the probe lands in the project root or in public/ - which
// no template gitignore covers.
//
// The sweep reads ownership off the disk instead of inferring it from a name.
// Keeping the pid in that name is not decoration: two concurrent doctors
// sharing one fixed name collide on the write with EPERM, the code a real
// denial raises, 96 times in 3000 - bfaa0b4's false "denied" all over again.
describe("residues of a doctor that was killed", () => {
  const reads = (contents: Record<string, string>) => (path: string) =>
    contents[path.replaceAll("\\", "/")] ?? null;

  test("removes a residue whose content proves borgo wrote it", () => {
    const removed: string[] = [];
    const swept = sweepProbes(
      "/p",
      [".borgo-doctor-4242", ".borgo-doctor-9"],
      reads({ "/p/.borgo-doctor-4242": PROBE_MARK, "/p/.borgo-doctor-9": PROBE_MARK }),
      (path) => removed.push(path),
    );
    expect(removed.map((p) => p.replaceAll("\\", "/"))).toEqual([
      "/p/.borgo-doctor-4242",
      "/p/.borgo-doctor-9",
    ]);
    expect(swept.length).toBe(2);
  });

  // the whole point: the name is not the evidence. Everything here is named
  // exactly like a probe and is not one.
  test("leaves every file whose content is not the mark", () => {
    const removed: string[] = [];
    const names = [".borgo-doctor-1", ".borgo-doctor-2", ".borgo-doctor-3", ".borgo-doctor-4"];
    sweepProbes(
      "/p",
      names,
      reads({
        // an empty residue from a borgo that predates the mark
        "/p/.borgo-doctor-1": "",
        // the mark with something appended
        "/p/.borgo-doctor-2": PROBE_MARK + "x",
        // a user's file that happens to wear the name
        "/p/.borgo-doctor-3": "le mie note",
        // unreadable, or a directory: read returns null
        "/p/.borgo-doctor-4": undefined as unknown as string,
      }),
      (path) => removed.push(path),
    );
    expect(removed).toEqual([]);
  });

  test("leaves every name that is not exactly the probe's", () => {
    const removed: string[] = [];
    const names = [
      "borgo-doctor-42",
      ".borgo-doctor-",
      ".borgo-doctor-4242.txt",
      "x.borgo-doctor-42",
      ".borgo-doctor-abc",
      ".borgo-doctor-4242 ",
      ".borgo-doctor-4/../../secret",
      "package.json",
      ".borgo",
    ];
    // every one of them reads back as the mark, so only the name can save them
    sweepProbes("/p", names, () => PROBE_MARK, (path) => removed.push(path));
    expect(removed).toEqual([]);
  });

  // it runs after the answer exists, so a refusal cannot turn "ok" into
  // "denied" the way the removal used to
  test("a refusal to remove is not the diagnosis", () => {
    expect(() =>
      sweepProbes("/p", [".borgo-doctor-1"], () => PROBE_MARK, () => {
        throw new Error("EPERM");
      }),
    ).not.toThrow();
    expect(
      sweepProbes("/p", [".borgo-doctor-1"], () => PROBE_MARK, () => {
        throw new Error("EPERM");
      }),
    ).toEqual([]);
  });

  test("the real probeWrite sweeps what a killed run left, and nothing else", () => {
    const dir = mkdtempSync(join(tmpdir(), "borgo-sweep-"));
    try {
      // what a killed doctor leaves now
      writeFileSync(join(dir, ".borgo-doctor-4242"), PROBE_MARK);
      // and three files it did not write
      writeFileSync(join(dir, ".borgo-doctor-7"), "");
      writeFileSync(join(dir, ".borgo-doctor-nota"), PROBE_MARK);
      writeFileSync(join(dir, "app.js"), PROBE_MARK);
      expect(realEnv().probeWrite(dir)).toBe("ok");
      expect(readdirSync(dir).sort()).toEqual([".borgo-doctor-7", ".borgo-doctor-nota", "app.js"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // a residue in the parent is swept when the probe lands in the parent, and
  // never a directory doctor was not already writing into
  test("sweeps only the directory the probe itself lands in", () => {
    const root = mkdtempSync(join(tmpdir(), "borgo-sweep-scope-"));
    try {
      const near = join(root, "near");
      mkdirSync(near);
      writeFileSync(join(root, ".borgo-doctor-11"), PROBE_MARK);
      writeFileSync(join(near, ".borgo-doctor-22"), PROBE_MARK);
      // probing a directory borgo has not made yet lands in root, not in near
      expect(realEnv().probeWrite(join(root, "dist"))).toBe("ok");
      expect(existsSync(join(root, ".borgo-doctor-11"))).toBe(false);
      expect(existsSync(join(near, ".borgo-doctor-22"))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  // the probe the real env writes has to be the one the sweep recognises, or a
  // killed run's residue is indistinguishable from a file borgo did not write.
  // A removal that is refused is exactly what a kill inside the window leaves.
  test("what a killed run leaves is what the sweep recognises", () => {
    const dir = mkdtempSync(join(tmpdir(), "borgo-mark-"));
    try {
      const probe = join(dir, `.borgo-doctor-${process.pid}`);
      expect(
        probeWriteWith(probe, (path) => writeFileSync(path, PROBE_MARK), () => {
          throw new Error("killed before this ran");
        }),
      ).toBe("ok");
      expect(readFileSync(probe, "utf8")).toBe(PROBE_MARK);
      expect(realEnv().probeWrite(dir)).toBe("ok");
      expect(readdirSync(dir)).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // The structural guard, because neither property can be watched from
  // outside: realEnv removes its own probe, so a probe that wrote anything but
  // the mark would make the sweep a no-op that every test above still passes.
  // And the answer has to exist before the sweep runs, or a refusal in there
  // becomes the diagnosis - which is the defect bfaa0b4 closed.
  test("the probe writes the mark, and the sweep runs after the answer", () => {
    const source = readFileSync(join(import.meta.dir, "../src/doctor.ts"), "utf8");
    expect(source).toContain("writeFileSync(path, PROBE_MARK)");
    const answered = source.indexOf("const answer = probeWriteWith(");
    expect(answered).toBeGreaterThan(-1);
    const swept = source.indexOf("sweepProbes(", answered);
    expect(swept).toBeGreaterThan(answered);
    expect(source.indexOf("return answer;", swept)).toBeGreaterThan(swept);
  });
});
