// Two bugs from building 0.30, pinned where the repo pins orchestration: in
// the helper when there is one, in the source when the behaviour lives in a
// closure no test can reach without running the whole dev loop.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { frontTopology, renderEnv, withoutRenderEnv } from "../src/util";

const source = (file: string) => readFileSync(join(import.meta.dir, "../src", file), "utf8").replaceAll("\r\n", "\n");

// borgo start and borgo export make their own process the render service and
// then spread process.env into the go binary: every go child carried
// BORGO_RENDER=1 and the render port. Inert only while go reads neither name
describe("a go child is not handed the render half's switches", () => {
  test("withoutRenderEnv takes the two render switches and nothing else", () => {
    const topology = frontTopology({ API_PORT: "9000", BORGO_RENDER_PORT: "9100" });
    const env: Record<string, string> = { PATH: "/bin", SESSION_SECRET: "s", ...renderEnv(topology) };
    const child = withoutRenderEnv(env);
    expect(child.BORGO_RENDER).toBeUndefined();
    expect(child.BORGO_RENDER_PORT).toBeUndefined();
    // the key and the api port are go's too, and the app's own env is the app's
    expect(child.BORGO_INTERNAL_KEY).toBe(topology.key);
    expect(child.API_PORT).toBe("9000");
    expect(child.PATH).toBe("/bin");
    expect(child.SESSION_SECRET).toBe("s");
    // and the process's own environment is left as it was
    expect(env.BORGO_RENDER).toBe("1");
  });

  test("borgo start and borgo export spawn go from it", () => {
    expect(source("cli.ts")).toContain("...withoutRenderEnv(process.env),\n          ...goFrontEnv(topology),");
    expect(source("export.ts")).toContain("...withoutRenderEnv(process.env),\n          API_PORT: String(apiPort),");
  });
});

// Every hot restart printed "the front server exited on its own (143)": the
// exit handler asks whether the dying process is still the render service,
// and startFront killed it while frontProc still pointed at it. The one
// message that means the render service really died was being printed for a
// kill the same function had just sent.
describe("a restart borgo dev asked for is not reported as a crash", () => {
  test("the render service is detached before it is killed, as the api is", () => {
    const dev = source("dev.ts");
    expect(dev).toContain("const previous = frontProc;\n    frontProc = null;\n    previous?.kill();\n    await previous?.exited;");
    // the guard the detaching feeds, which is what stays silent for it
    expect(dev).toContain("if (frontProc !== proc) return;");
    // the api's restart already did this; the two must not drift apart again
    expect(dev).toContain("const previous = goProc;\n    goProc = null;");
  });
});
