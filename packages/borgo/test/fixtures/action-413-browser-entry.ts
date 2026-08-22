import { mount, type MountOptions } from "../../src/runtime";

// the client bundle Chrome loads in action-413-browser.test.ts: the real
// runtime, with React stubbed out - the page under test is a form, not a tree
declare global {
  interface Window {
    __hydrated?: boolean;
  }
}

mount({
  createElement: ((type: unknown, props: unknown) => ({ type, props })) as MountOptions["createElement"],
  hydrateRoot: (() => {
    window.__hydrated = true;
    return { render: () => {}, unmount: () => {} };
  }) as unknown as MountOptions["hydrateRoot"],
  routes: [{ pattern: "/form", file: "form.tsx", hydrate: true, load: async () => ({ default: () => null }), layouts: [] }],
  notFound: null,
});
