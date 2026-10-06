// the typing of subscribe and publish over WsEvents, held by tsc itself: a
// probe with every expectation written as code and every refusal as a
// expect-error directive, compiled against the live index.ts. An expectation that
// stops holding is a type error; a refusal that stops refusing is an unused
// expect-error directive, also an error. The verifier of phase 5 step 2 found the
// template-key matching guarded by nothing but the example's tsc.
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const src = resolve(import.meta.dir, "../src/index.ts");


const probe = `
import { subscribe } from "borgo-framework";

declare module "borgo-framework" {
  interface WsEvents {
    "live/task-created": string;
    [k: \`channel:\${string}/message\`]: { id: number; text: string };
    [k: \`channel:\${string}/typing\`]: boolean;
  }
}

// a literal topic
subscribe("live", (event, data) => {
  if (event === "task-created") data.toUpperCase();
  if (event === "__count") data.toFixed(0);
});
// a computed topic, spelled as a literal and as a template
subscribe("channel:42", (event, data) => {
  if (event === "message") data.text.toUpperCase();
  if (event === "typing") data.valueOf();
});
export function forId(id: string) {
  subscribe(\`channel:\${id}\`, (event, data) => {
    if (event === "message") data.id.toFixed(1);
  });
}
// a topic nobody declared stays untyped, and so does a topic that is any
// string: with no name there is nothing to narrow on
subscribe("nothing", (event, data) => {
  const e: string = event;
  const d: unknown = data;
  void e;
  void d;
});
export function forAny(topic: string) {
  subscribe(topic, (event, data) => {
    const d: unknown = data;
    void event;
    void d;
  });
}
// the wrong payload, the undeclared event, the wrong publish
subscribe("channel:7", (event, data) => {
  // @ts-expect-error a message payload is not a number
  if (event === "message") data.toFixed(2);
});
subscribe("channel:7", (event) => {
  // @ts-expect-error not an event of channel:*
  if (event === "nope") void 0;
});
const channel = subscribe("channel:9", () => {});
channel.publish("message", { id: 1, text: "hi" });
// @ts-expect-error the wrong payload
channel.publish("message", 42);
// @ts-expect-error an undeclared event
channel.publish("nope", 1);
// @ts-expect-error the relay's own event is not a browser's to publish
channel.publish("__count", 1);
const free = subscribe("free", () => {});
free.publish("anything", { any: true });
`;

test("subscribe and publish are typed by literal and pattern keys alike, and refuse what they must", () => {
  const dir = mkdtempSync(join(tmpdir(), "borgo-ws-types-"));
  try {
    writeFileSync(join(dir, "probe.ts"), probe);
    writeFileSync(
      join(dir, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: {
          strict: true,
          noEmit: true,
          target: "es2022",
          lib: ["es2022", "dom"],
          module: "esnext",
          moduleResolution: "bundler",
          skipLibCheck: true,
          paths: { "borgo-framework": [src.replaceAll("\\", "/")] },
        },
        files: ["probe.ts"],
      }),
    );
    // bunx, as scripts/typecheck.ts runs it: the one spelling that works on
    // every platform the repo is developed on
    const run = Bun.spawnSync(["bunx", "tsc", "-p", dir], { stdout: "pipe", stderr: "pipe" });
    const out = run.stdout.toString() + run.stderr.toString();
    expect(out.trim(), out).toBe("");
    expect(run.exitCode).toBe(0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
