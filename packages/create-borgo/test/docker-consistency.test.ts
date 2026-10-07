import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..", "..", "..");
const read = (...p: string[]) => readFileSync(join(root, ...p), "utf8").replaceAll("\r\n", "\n");

// the ENV line of a Dockerfile's runtime stage, as name -> value
function dockerEnv(dockerfile: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of dockerfile.split("\n").filter((l) => l.startsWith("ENV "))) {
    for (const pair of line.slice(4).trim().split(/\s+/)) {
      const [name, ...value] = pair.split("=");
      out[name!] = value.join("=");
    }
  }
  return out;
}

// what an app keeps must land on the volume compose mounts at /data, and
// the image and compose must name the same file: a Dockerfile that drifted
// to /app/app.db left a plain docker run unable to open the database, and
// passed every test there was (found by the verifier of phase 6)
for (const [name, dir, keeps] of [
  ["the full template", ["packages", "create-borgo", "templates", "full"], ["DB_PATH"]],
  ["examples/tasks", ["examples", "tasks"], ["DB_PATH", "UPLOADS_DIR"]],
] as const) {
  test(`${name}: what it keeps lives on the /data volume, named alike by the image and compose`, () => {
    const env = dockerEnv(read(...dir, "Dockerfile"));
    const compose = Bun.YAML.parse(read(...dir, "docker-compose.yml")) as {
      services: { app: { environment: Record<string, string>; volumes: string[] } };
    };
    for (const variable of keeps) {
      expect(env[variable], variable).toStartWith("/data/");
      const fromCompose = compose.services.app.environment[variable];
      if (fromCompose !== undefined) expect(fromCompose, variable).toBe(env[variable]);
    }
    expect(compose.services.app.volumes).toContain("data:/data");
  });
}

// every image boots the render service, which imports middleware.ts when
// the app has one: an image that left it out built clean and exited at
// start (found by the verifier of phase 6); /data/uploads is the image's,
// so a volume there is writable
for (const dockerfile of [
  ["packages", "create-borgo", "templates", "base", "Dockerfile"],
  ["packages", "create-borgo", "templates", "full", "Dockerfile"],
  ["packages", "create-borgo", "templates", "minimal", "Dockerfile"],
  ["examples", "tasks", "Dockerfile"],
]) {
  test(`${dockerfile.join("/")} copies middleware.ts and owns /data/uploads`, () => {
    const text = read(...dockerfile);
    expect(text).toContain("for d in islands components lib middleware.ts; do [ -e \"$d\" ] && cp -r \"$d\" /out/; done;");
    expect(text).toContain("RUN mkdir -p /data/uploads && chown -R bun:bun /data");
  });
}
