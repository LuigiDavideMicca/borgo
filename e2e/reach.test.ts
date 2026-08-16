// The Playwright suite lives in this directory, and `bun test` with no
// arguments walks the whole repo collecting anything bun considers a test file.
// A Playwright spec cannot run under bun's runner: it throws "Playwright Test
// did not expect test() to be called here" while loading, before a single
// assertion, once per file. For most of this project's life that made the most
// obvious command in the repo print 17 stack traces on a healthy tree - a red
// that meant "you typed the wrong command" and looked exactly like a broken
// one. A gate that goes red for something that is not a defect is a gate people
// learn to scroll past, so the day the red is real it reads the same.
//
// The specs are therefore named *.e2e.ts: not one of bun's discovery patterns,
// and picked up by playwright.config.ts through testMatch. This file is the one
// test here that bun is meant to run, and the only thing it asserts is that the
// arrangement still holds.
import { expect, test } from "bun:test";
import { readdirSync } from "node:fs";

// bun collects *.test.*, *_test.*, *.spec.* and *_spec.* (js/jsx/ts/tsx, with
// the cjs/mjs variants)
const collectedByBun = /[._](test|spec)\.[cm]?[jt]sx?$/;

// recursive: a spec one directory down is just as collectable, and a check that
// only reads the top level would call that arrangement safe
const here = readdirSync(import.meta.dir, { recursive: true }).map((entry) =>
  String(entry).replaceAll("\\", "/"),
);
const self = import.meta.file;

test("the e2e specs stay out of `bun test`'s reach - run `bun run e2e` for them", () => {
  const strays = here.filter((file) => file !== self && collectedByBun.test(file));
  if (strays.length > 0) {
    throw new Error(
      [
        `e2e/ holds ${strays.length} file(s) that \`bun test\` will collect and Playwright cannot run under bun:`,
        ...strays.map((file) => `  e2e/${file}`),
        "",
        "rename them to *.e2e.ts - playwright.config.ts matches that, bun does not.",
        "left as they are, `bun test` fails on a healthy tree with",
        '"Playwright Test did not expect test() to be called here", once per file.',
      ].join("\n"),
    );
  }
});

// without this the check above passes on an empty directory, which is also what
// it would look like if the suite were renamed out from under it
test("...and the specs are still here to be out of reach", () => {
  expect(here.filter((file) => file.endsWith(".e2e.ts")).length).toBeGreaterThan(0);
});
