// browser runtime: react is injected by the generated client entry, from the app's own node_modules
import type { createElement as CreateElement } from "react";
import type { hydrateRoot as HydrateRoot, Root } from "react-dom/client";
import { CSRF_FIELD, csrfCookieValue } from "./index";
import { withCsrf } from "./internal";
import {
  matchRoute,
  resolveHead,
  safeHeadAttrs,
  type Head,
  type LayoutModule,
  type PageModule,
} from "./router";

// the double-submit cookie was set by the response that carried this page
const csrfToken = () => csrfCookieValue(document.cookie);

declare global {
  interface Window {
    __PROPS__?: Record<string, unknown>;
    __BORGO_TITLE__?: string;
    __BORGO_DEV__?: number;
  }
}

// the client-side page module: loader and action are stripped at build time
export type ClientPageModule = Omit<PageModule, "loader" | "action">;

export type ClientRoute = {
  pattern: string;
  file: string;
  hydrate: true | "visible";
  load: () => Promise<ClientPageModule>;
  layouts: LayoutModule[];
};

function showOverlay(title: string, detail: string) {
  document.getElementById("borgo-overlay")?.remove();
  const el = document.createElement("div");
  el.id = "borgo-overlay";
  el.style.cssText =
    "position:fixed;inset:0;z-index:99999;background:rgba(34,27,22,.97);color:#f5ead9;" +
    "font-family:ui-monospace,monospace;overflow:auto;padding:3rem 1.5rem";
  const pre = document.createElement("pre");
  pre.textContent = detail;
  pre.style.cssText =
    "background:#1a140f;border:1px solid #3d2f24;border-radius:8px;padding:1rem;" +
    "white-space:pre-wrap;line-height:1.5;max-width:56rem;margin:0 auto";
  const header = document.createElement("div");
  header.innerHTML =
    '<div style="max-width:56rem;margin:0 auto 1rem">' +
    '<div style="color:#d9825f;font-weight:bold">⌂ borgo</div>' +
    `<h1 style="font-size:1.2rem;color:#e8a07e;margin:.5rem 0">${title}</h1>` +
    '<button style="position:absolute;top:1rem;right:1.5rem;background:none;border:1px solid #3d2f24;color:#b5a08f;border-radius:6px;padding:.3rem .8rem;cursor:pointer" onclick="this.closest(\'#borgo-overlay\').remove()">dismiss</button></div>';
  el.append(header, pre);
  document.body.appendChild(el);
}

function attachDevOverlay() {
  window.addEventListener("error", (event) => {
    showOverlay("client error", event.error?.stack ?? event.message);
  });
  window.addEventListener("unhandledrejection", (event) => {
    const reason = event.reason;
    showOverlay("unhandled rejection", reason?.stack ?? String(reason));
  });
}

export type MountIslandsOptions = {
  createElement: typeof CreateElement;
  hydrateRoot: typeof HydrateRoot;
  islands: Record<string, import("react").ComponentType<any>>;
};

// hydrates every <Island> marker on a page that ships no page bundle; client="visible" waits for the viewport
export function mountIslands({ createElement, hydrateRoot, islands }: MountIslandsOptions) {
  for (const el of document.querySelectorAll("[data-borgo-island]")) {
    const name = el.getAttribute("data-borgo-island")!;
    const component = islands[name];
    if (!component) continue;
    let props: Record<string, unknown>;
    try {
      props = JSON.parse(el.getAttribute("data-borgo-props") || "{}");
    } catch {
      // one unreadable marker must not stop the rest of the page
      continue;
    }
    const hydrate = () => hydrateRoot(el, withCsrf(createElement(component, props), csrfToken()));
    if (el.getAttribute("data-borgo-client") === "visible") {
      const observer = new IntersectionObserver((entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          observer.disconnect();
          hydrate();
        }
      });
      observer.observe(el);
    } else {
      hydrate();
    }
  }
}

// never handed to location.assign: "javascript:" executes in the page's origin
export function redirectUrl(raw: string): URL | null {
  try {
    const dest = new URL(raw, location.origin);
    return dest.protocol === "http:" || dest.protocol === "https:" ? dest : null;
  } catch {
    return null;
  }
}

// `borgo export` sets BORGO_STATIC and the bundler substitutes it, so a static
// build compiles the props path out: a static host answers ?__borgo=props
// with the page's own html and a 200, res.ok passes, res.json() throws.
// declared here because the name never survives to the browser and the dts
// project compiles with no ambient types at all - tsc 7 stopped leaking a
// global `process` into it, which is the stricter reading, not a regression
declare const process: { env: { BORGO_STATIC?: string } };
export const propsPathEnabled = (): boolean => process.env.BORGO_STATIC !== "1";

// "reload" for what fast refresh cannot express, "apply" for a refreshable
// change touching what is rendered, "skip" for other pages. decided on the
// whole set: index.tsx and about.tsx in one rebuild while on `/` has to apply
export function devUpdatePlan(files: string[], currentFile: string | null): "reload" | "apply" | "skip" {
  if (!files.length) return "skip";
  // layouts, the shell, _404/_500 and anything not a module: not refreshable
  if (files.some((f) => !/\.tsx?$/.test(f) || /(^|\/)_(layout|404|500)\.tsx$/.test(f))) {
    return "reload";
  }
  if (!currentFile) return "reload";
  // a module outside pages/ (a component, a hook) can be under the page on screen
  return files.some((f) => !f.startsWith("pages/") || f === "pages/" + currentFile) ? "apply" : "skip";
}

// the server is not trusted to answer with an object: a string or an array would blow up in createElement
export const asProps = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

// the status is read before the markers: the body limit refuses BEFORE the
// action runs (`bodyTooLarge` in util.ts, no X-Borgo marker yet) and a proxy's
// own 413 arrives the same way; unmarked would mean "custom response" and
// reload, throwing away the one thing the server said
export type ActionOutcome = "too-large" | "raw" | "action" | "unknown";

export const actionOutcome = (res: Response): ActionOutcome => {
  if (res.status === 413) return "too-large";
  const marker = res.headers.get("X-Borgo");
  return marker === "raw" ? "raw" : marker === "action" ? "action" : "unknown";
};

const REFUSED_TOO_LARGE =
  "the server refused this submission before the action ran: the request body is over the size limit.\n" +
  "nothing was saved, and nothing you typed was lost - shrink it (a smaller file, less text) and submit again.";

// the server's text names the limit (BORGO_MAX_BODY); a proxy answers with a
// whole html page, which tells nobody anything, so only prose is passed on, capped
export async function tooLargeDetail(res: Response): Promise<string> {
  const said = (await res.text().catch(() => "")).trim();
  const prose = said && !said.startsWith("<") ? said.slice(0, 500) : "";
  return prose ? `${REFUSED_TOO_LARGE}\n\n${prose}` : REFUSED_TOO_LARGE;
}

export type MountOptions = {
  createElement: typeof CreateElement;
  hydrateRoot: typeof HydrateRoot;
  routes: ClientRoute[];
  notFound: ClientRoute | null;
};

function compose(
  createElement: MountOptions["createElement"],
  route: ClientRoute,
  module: ClientPageModule,
  props: Record<string, unknown>,
) {
  let element = createElement(module.default, props);
  for (let i = route.layouts.length - 1; i >= 0; i--) {
    element = createElement(route.layouts[i].default, null, element);
  }
  return withCsrf(element, csrfToken());
}

export function mount({ createElement, hydrateRoot, routes, notFound }: MountOptions) {
  if (window.__BORGO_DEV__) attachDevOverlay();

  const initial = matchRoute(location.pathname, routes);
  const initialRoute = initial?.route ?? notFound;

  const container = document.getElementById("root")!;
  let root: Root;
  let currentRoute: ClientRoute | null = null;
  // what root shows, without the hash: popstate tells a route change from a fragment move by it
  let renderedUrl = location.pathname + location.search;

  async function hydrate(route: ClientRoute) {
    const module = await route.load();
    currentRoute = route;
    root = hydrateRoot(container, compose(createElement, route, module, window.__PROPS__ ?? {}));
    attachNavigation();
  }

  if (window.__BORGO_DEV__) attachDevChannel();

  // a page with no route (and no _404) still edits like any other: the dev channel reloads it
  if (!initialRoute) return;

  if (initialRoute.hydrate === "visible") {
    const target = document.querySelector("[data-borgo-visible]") ?? container;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) {
        observer.disconnect();
        hydrate(initialRoute);
      }
    });
    observer.observe(target);
  } else {
    hydrate(initialRoute);
  }

  const defaultTitle = window.__BORGO_TITLE__ || document.title;

  function applyHead(head: Head) {
    document.title = head.title ?? defaultTitle;
    for (const el of document.querySelectorAll("[data-borgo-head]")) el.remove();
    for (const meta of head.meta ?? []) {
      const el = document.createElement("meta");
      // the server's filter, not a looser one: setAttribute throws on names the server merely dropped
      for (const [key, value] of safeHeadAttrs(meta)) el.setAttribute(key, value);
      el.setAttribute("data-borgo-head", "");
      document.head.appendChild(el);
    }
  }

  // props prefetched on hover; the route chunk import is idempotent and needs no cache
  const propsTtl = 10_000;
  const propsMax = 16;
  type PropsEntry = { promise: Promise<Response>; time: number };
  const propsCache = new Map<string, PropsEntry>();

  // a prefetch nobody navigates to keeps its body, and the socket reading it, alive until the tab closes
  const drainProps = (entry: PropsEntry) =>
    void entry.promise.then((res) => res.body?.cancel().catch(() => {})).catch(() => {});

  // insertion order is age order
  function trimProps() {
    const now = performance.now();
    for (const [key, entry] of propsCache) {
      if (propsCache.size <= propsMax && now - entry.time < propsTtl) break;
      propsCache.delete(key);
      drainProps(entry);
    }
  }

  function clearProps() {
    for (const entry of propsCache.values()) drainProps(entry);
    propsCache.clear();
  }

  function fetchProps(to: URL) {
    const sep = to.search ? "&" : "?";
    return fetch(to.pathname + to.search + sep + "__borgo=props", {
      headers: { Accept: "application/json" },
    });
  }

  function prefetch(to: URL, withProps: boolean) {
    const matched = matchRoute(to.pathname, routes);
    if (!matched) return;
    // an import failing here (offline, dev server mid-restart) must not surface
    // as an unhandled rejection, in dev the error overlay, over a healthy page
    matched.route.load().catch(() => {});
    if (!withProps || !propsPathEnabled()) return;
    const cacheKey = to.pathname + to.search;
    const hit = propsCache.get(cacheKey);
    if (hit && performance.now() - hit.time < propsTtl) return;
    if (hit) {
      propsCache.delete(cacheKey);
      drainProps(hit);
    }
    const promise = fetchProps(to);
    promise.catch(() => {});
    propsCache.set(cacheKey, { promise, time: performance.now() });
    trimProps();
  }

  // every history entry gets a key; positions are saved to sessionStorage
  const newKey = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  let entryKey: string = history.state?.__borgo ?? newKey();

  function saveScroll() {
    try {
      sessionStorage.setItem(`borgo:scroll:${entryKey}`, `${scrollX},${scrollY}`);
    } catch {}
  }

  function restoreScroll(key: string) {
    let saved: string | null = null;
    try {
      saved = sessionStorage.getItem(`borgo:scroll:${key}`);
    } catch {}
    if (!saved) return scrollTo(0, 0);
    const [x, y] = saved.split(",").map(Number);
    scrollTo(x, y);
  }

  // a back/forward or reload that missed bfcache arrives as a full load with
  // native restoration off (the previous visit set it to manual), so the saved
  // position is replayed; a fresh entry or a hash jump stays where the browser put it
  const [navEntry] = performance.getEntriesByType?.("navigation") ?? [];
  const navType = (navEntry as PerformanceNavigationTiming | undefined)?.type;
  if (navType === "back_forward" || navType === "reload") {
    let saved: string | null = null;
    try {
      saved = sessionStorage.getItem(`borgo:scroll:${entryKey}`);
    } catch {}
    if (saved) restoreScroll(entryKey);
  }

  const afterRender = (fn: () => void) =>
    requestAnimationFrame(() => requestAnimationFrame(fn));

  // the newest navigation wins: a slower one must not render over it
  let navSeq = 0;

  // keepScroll: an action redirecting back to its own page refreshes in place.
  // hops caps loader-redirect chains, which have no native browser limit.
  // push: true adds a history entry, "replace" rewrites it, false is a back/forward render
  async function navigate(to: URL, push: boolean | "replace", keepScroll = false, hops = 0) {
    const seq = ++navSeq;
    const matched = matchRoute(to.pathname, routes);
    // a static export has no props endpoint: the navigation goes to the browser
    // at once instead of fetching that document twice to discover it
    if (!matched || !propsPathEnabled()) {
      location.assign(to.href);
      return;
    }

    let module: ClientPageModule;
    let props: Record<string, unknown>;
    try {
      const cacheKey = to.pathname + to.search;
      const cached = propsCache.get(cacheKey);
      propsCache.delete(cacheKey);
      const fresh = cached && performance.now() - cached.time < propsTtl;
      if (cached && !fresh) drainProps(cached);
      const propsPromise = fresh ? cached!.promise : fetchProps(to);
      const [loaded, res] = await Promise.all([matched.route.load(), propsPromise]);
      if (seq !== navSeq) return;
      if (!res.ok) throw new Error(`props fetch failed: ${res.status}`);
      module = loaded;
      const data = await res.json();
      if (seq !== navSeq) return;
      if (data.redirect) {
        const dest = redirectUrl(data.redirect);
        // the catch reloads `to`, and the browser follows the server's redirect natively
        if (!dest) throw new Error("unusable redirect");
        if (dest.origin !== location.origin || hops >= 10) {
          location.assign(dest.href);
          return;
        }
        // a redirect followed without a push (back/forward) must still fix the address bar
        if (!push) {
          history.replaceState({ __borgo: entryKey }, "", dest.pathname + dest.search + dest.hash);
        }
        navigate(dest, push, keepScroll, hops + 1);
        return;
      }
      props = asProps(data.props);
    } catch {
      if (seq !== navSeq) return;
      location.assign(to.href);
      return;
    }

    if (push === true) {
      saveScroll();
      entryKey = newKey();
      history.pushState({ __borgo: entryKey }, "", to.pathname + to.search + to.hash);
    } else if (push === "replace") {
      history.replaceState({ __borgo: entryKey }, "", to.pathname + to.search + to.hash);
    }
    currentRoute = matched.route;
    renderedUrl = to.pathname + to.search;
    root.render(compose(createElement, matched.route, module, props));
    applyHead(resolveHead(module, props));
    const key = entryKey;
    afterRender(() => {
      if (seq !== navSeq) return;
      if (keepScroll) {
        // nothing: the browser keeps the current position
      } else if (push) {
        const target = to.hash && document.getElementById(to.hash.slice(1));
        target ? target.scrollIntoView() : scrollTo(0, 0);
      } else {
        restoreScroll(key);
      }
      observeLinks();
    });
  }

  // post forms run the action over fetch and re-render in place; data-borgo-native
  // opts out, and get forms, cross-origin targets and non-page urls stay native
  let nativePass: HTMLFormElement | null = null;

  // a double-clicked submit must not fire the action twice; the native-resubmit path is exempt
  const inFlight = new WeakSet<HTMLFormElement>();

  function nativeResubmit(form: HTMLFormElement, submitter: HTMLElement | null) {
    nativePass = form;
    form.requestSubmit(submitter ?? undefined);
    // an onSubmit that preventDefaults would leave the latch armed
    setTimeout(() => {
      if (nativePass === form) nativePass = null;
    }, 0);
  }

  async function submitForm(
    form: HTMLFormElement,
    submitter: HTMLElement | null,
    to: URL,
    matched: { route: ClientRoute; params: Record<string, string> },
  ) {
    inFlight.add(form);
    try {
      await runSubmit(form, submitter, to, matched);
    } finally {
      inFlight.delete(form);
    }
  }

  async function runSubmit(
    form: HTMLFormElement,
    submitter: HTMLElement | null,
    to: URL,
    matched: { route: ClientRoute; params: Record<string, string> },
  ) {
    const seq = ++navSeq;
    const data = new FormData(form, submitter ?? undefined);
    // the cookie may have rotated since the last render (a login in another
    // tab); the server compares field to cookie, so the live cookie is echoed.
    // a form without the field is left alone: adding it would mask a missing
    // <CsrfField /> that classic no-js posts still need
    if (data.has(CSRF_FIELD)) {
      const live = csrfToken();
      if (live) data.set(CSRF_FIELD, live);
    }
    const enctype = (
      submitter?.getAttribute("formenctype") ||
      form.getAttribute("enctype") ||
      ""
    ).toLowerCase();
    // urlencoded serialization of a file input is its filename (the spec's
    // "entry list" conversion), not String(File) = "[object File]"
    const body =
      enctype === "multipart/form-data"
        ? data
        : new URLSearchParams(
            [...data].map(([k, v]) => [k, typeof v === "string" ? v : v.name]),
          );

    // the mutation changes what any prefetched loader returns: dropped now, not on success only
    clearProps();
    let res: Response;
    try {
      res = await fetch(to.pathname + to.search, {
        method: "POST",
        body,
        headers: { "X-Borgo-Action": "1", Accept: "application/json" },
      });
    } catch {
      // never reached the server: the native path can retry it
      if (seq === navSeq) nativeResubmit(form, submitter);
      return;
    }
    if (seq !== navSeq) return;

    const outcome = actionOutcome(res);
    if (outcome === "too-large") {
      // no reload: the page on screen still holds what was typed
      showOverlay("submission too large", await tooLargeDetail(res));
      return;
    }
    if (outcome === "raw") {
      // a full document (error overlay, 500 page, custom html): swapped in
      // wholesale like a native submit. a popstate while the body streamed
      // moved the document to another entry, and every url-changing navigation
      // bumps navSeq: writing the document then would show it under that url
      const html = await res.text().catch(() => "");
      if (seq !== navSeq) return;
      if (!html) return location.reload();
      document.open();
      document.write(html);
      document.close();
      return;
    }
    if (outcome === "unknown") {
      // a custom response the runtime cannot interpret: a reload shows the new state
      location.reload();
      return;
    }
    if (res.status === 403 || res.status === 405) {
      // stale csrf token, or a post to a page without an action: neither ran
      // the action, so the native submit can surface the real error
      nativeResubmit(form, submitter);
      return;
    }
    // the action ran: from here a thrown parse or a chunk that will not load
    // must never leave the form dead
    let payload: {
      redirect?: string;
      props?: Record<string, unknown>;
      actionData?: unknown;
    };
    try {
      payload = await res.json();
    } catch {
      return location.reload();
    }
    if (seq !== navSeq) return;
    if (payload.redirect) {
      const dest = redirectUrl(payload.redirect);
      if (!dest) return location.reload();
      if (dest.origin !== location.origin) {
        location.assign(dest.href);
        return;
      }
      const back = dest.pathname === location.pathname && dest.search === location.search;
      navigate(dest, !back, back);
      return;
    }

    let module: ClientPageModule;
    try {
      module = await matched.route.load();
    } catch {
      return location.reload();
    }
    if (seq !== navSeq) return;
    const props = { ...asProps(payload.props), actionData: payload.actionData };
    const samePage = to.pathname === location.pathname && to.search === location.search;
    if (!samePage) {
      saveScroll();
      entryKey = newKey();
      history.pushState({ __borgo: entryKey }, "", to.pathname + to.search);
    }
    currentRoute = matched.route;
    renderedUrl = to.pathname + to.search;
    root.render(compose(createElement, matched.route, module, props));
    applyHead(resolveHead(module, props));
    afterRender(() => {
      if (seq !== navSeq) return;
      if (!samePage) scrollTo(0, 0);
      observeLinks();
    });
  }

  function attachFormEnhancement() {
    document.addEventListener("submit", (event) => {
      const form = event.target as HTMLFormElement;
      if (nativePass === form) {
        nativePass = null;
        return;
      }
      if (event.defaultPrevented) return;
      if (inFlight.has(form)) {
        // double-click, enter mashed twice: the first submit wins
        event.preventDefault();
        return;
      }
      const submitter = (event as SubmitEvent).submitter;
      const method = (
        submitter?.getAttribute("formmethod") ||
        form.getAttribute("method") ||
        "get"
      ).toLowerCase();
      if (method !== "post") return;
      if (form.hasAttribute("data-borgo-native")) return;
      // text/plain would be silently rewritten to urlencoded: left to the browser
      const enctype = (
        submitter?.getAttribute("formenctype") ||
        form.getAttribute("enctype") ||
        ""
      ).toLowerCase();
      if (enctype === "text/plain") return;
      // getAttribute here too: an input named "target" shadows the property
      const targetAttr = form.getAttribute("target");
      if (targetAttr && targetAttr !== "_self") return;
      // getAttribute, not form.action: an input named "action" shadows it
      const raw = submitter?.getAttribute("formaction") || form.getAttribute("action") || "";
      const to = new URL(raw, location.href);
      if (to.origin !== location.origin) return;
      const matched = matchRoute(to.pathname, routes);
      if (!matched) return;
      event.preventDefault();
      submitForm(form, submitter, to, matched);
    });
  }

  function linkTarget(anchor: HTMLAnchorElement | null): URL | null {
    if (!anchor || anchor.hasAttribute("download")) return null;
    if (anchor.target && anchor.target !== "_self") return null;
    const to = new URL(anchor.href, location.href);
    if (to.origin !== location.origin) return null;
    return to;
  }

  // links scrolled into view get their route chunk prefetched
  const linkObserver = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      linkObserver.unobserve(entry.target);
      const to = linkTarget(entry.target as HTMLAnchorElement);
      if (to) prefetch(to, false);
    }
  });

  // an observer holds its targets strongly: without the disconnect every
  // anchor of every page visited stays alive for the session
  function observeLinks() {
    linkObserver.disconnect();
    for (const anchor of document.querySelectorAll("a[href]")) linkObserver.observe(anchor);
  }

  function attachNavigation() {
    attachFormEnhancement();
    history.scrollRestoration = "manual";
    if (!history.state?.__borgo) {
      history.replaceState({ ...history.state, __borgo: entryKey }, "");
    }
    let scrollTimer: ReturnType<typeof setTimeout> | undefined;
    addEventListener(
      "scroll",
      () => {
        clearTimeout(scrollTimer);
        scrollTimer = setTimeout(saveScroll, 100);
      },
      { passive: true },
    );
    // leaving natively (external link, document swap, tab close) can beat the debounce
    addEventListener("pagehide", () => {
      clearTimeout(scrollTimer);
      saveScroll();
    });

    // hovering runs a loader on the server, so a pointer crossing a long list
    // must not fire one request per anchor: only a settled hover counts.
    // focus and touch are deliberate already
    let intentTimer: ReturnType<typeof setTimeout> | undefined;
    const onIntent = (delay: number) => (event: Event) => {
      clearTimeout(intentTimer);
      const anchor = (event.target as Element).closest?.("a");
      const to = anchor && linkTarget(anchor);
      // the search too, or paginated links to the current page never get their props
      if (!to || to.pathname + to.search === location.pathname + location.search) return;
      if (delay) intentTimer = setTimeout(() => prefetch(to, true), delay);
      else prefetch(to, true);
    };
    document.addEventListener("mouseover", onIntent(60));
    document.addEventListener("focusin", onIntent(0));
    document.addEventListener("touchstart", onIntent(0), { passive: true });

    observeLinks();

    document.addEventListener("click", (event) => {
      if (event.defaultPrevented || event.button !== 0) return;
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;

      const anchor = (event.target as Element).closest("a");
      const to = linkTarget(anchor);
      if (!to) return;
      const samePage = to.pathname === location.pathname && to.search === location.search;
      if (samePage && to.hash) return;

      event.preventDefault();
      // a link to the current page refreshes it like the browser does: a pushed
      // identical entry only means back has to be pressed twice
      navigate(to, samePage ? "replace" : true);
    });

    // the browser pushes a fragment entry with no state of ours: claim it, or
    // the scroll writes that follow land on the key of the entry just left
    window.addEventListener("hashchange", () => {
      if (history.state?.__borgo) return;
      entryKey = newKey();
      history.replaceState({ ...history.state, __borgo: entryKey }, "");
    });

    window.addEventListener("popstate", () => {
      // flush under the key of the page being left, or the pending timer saves
      // the old position under the restored entry's key
      clearTimeout(scrollTimer);
      saveScroll();
      const stamped = history.state?.__borgo;
      entryKey = stamped ?? newKey();
      if (location.pathname + location.search === renderedUrl) {
        // a fragment entry the browser pushed on its own: page and loader data unchanged
        if (!stamped) history.replaceState({ ...history.state, __borgo: entryKey }, "");
        const target = location.hash && document.getElementById(location.hash.slice(1));
        target ? target.scrollIntoView() : restoreScroll(entryKey);
        return;
      }
      navigate(new URL(location.href), false);
    });
  }

  function attachDevChannel() {
    // the stamp survives reloads, so a boot's welcome message is applied once
    let lastStamp = Number(sessionStorage.getItem("borgo:devstamp") ?? 0);

    async function applyUpdate(msg: {
      files?: string[];
      file?: string;
      chunks: Record<string, string>;
      stamp: number;
    }) {
      const { chunks } = msg;
      // `file` is what a server older than this runtime sends
      const files = msg.files ?? (msg.file ? [msg.file] : []);
      if (msg.stamp && msg.stamp <= lastStamp) return;
      // a page loaded after the rebuild already runs the new code
      if (msg.stamp && msg.stamp <= performance.timeOrigin) return;
      lastStamp = msg.stamp;
      try {
        sessionStorage.setItem("borgo:devstamp", String(msg.stamp));
      } catch {}
      // reverting an edit restores the previous chunk hash, which the module cache would serve stale
      const bust = msg.stamp ? `?v=${msg.stamp}` : "";
      for (const route of [...routes, ...(notFound ? [notFound] : [])]) {
        const chunk = chunks[route.file];
        if (chunk) route.load = () => import(chunk + bust);
      }
      if (!currentRoute || !root) return location.reload();
      const plan = devUpdatePlan(files, currentRoute.file);
      if (plan === "reload") return location.reload();
      if (plan === "skip") return;
      const chunk = chunks[currentRoute.file];
      if (!chunk) return location.reload();
      try {
        const route = currentRoute;
        const seq = navSeq;
        const [module, res] = await Promise.all([
          import(chunk + bust) as Promise<ClientPageModule>,
          fetchProps(new URL(location.href)),
        ]);
        if (!res.ok) throw new Error(`props fetch failed: ${res.status}`);
        const props = asProps((await res.json()).props);
        // a navigation started while this was in flight already owns root
        if (seq !== navSeq) return;
        // refresh first: families must swap (and hook-signature changes remount)
        // before the new module renders against existing fibers
        (globalThis as { $RefreshRuntime$?: { performReactRefresh: () => void } }).$RefreshRuntime$?.performReactRefresh();
        root.render(compose(createElement, route, module, props));
        applyHead(resolveHead(module, props));
      } catch {
        // a rapid next edit restarts the server mid-apply and kills these
        // fetches: its welcome message gets a chance to take over first
        await new Promise((resolve) => setTimeout(resolve, 3_000));
        if (lastStamp !== msg.stamp) return;
        location.reload();
      }
    }

    let attempts = 0;
    const connect = () => {
      const scheme = location.protocol === "https:" ? "wss" : "ws";
      const ws = new WebSocket(`${scheme}://${location.host}/__borgo/dev`);
      // edits made before the channel is open are lost: tests wait on this flag
      ws.onopen = () => {
        attempts = 0;
        (window as unknown as Record<string, unknown>).__borgoDevConnected = true;
      };
      ws.onmessage = (event) => {
        const msg = JSON.parse(event.data);
        if (msg.type === "reload") {
          // a reconnect after our own reload re-delivers the boot's welcome message: applying it would loop
          if (msg.stamp && (msg.stamp <= performance.timeOrigin || msg.stamp <= lastStamp)) return;
          if (msg.stamp) {
            lastStamp = msg.stamp;
            try {
              sessionStorage.setItem("borgo:devstamp", String(msg.stamp));
            } catch {}
          }
          location.reload();
        }
        else if (msg.type === "css") {
          for (const link of document.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"]')) {
            link.href = link.href.split("?")[0] + "?t=" + Date.now();
          }
        } else if (msg.type === "js") applyUpdate(msg);
      };
      // a stopped dev server is not probed three times a second until the tab closes
      ws.onclose = () => setTimeout(connect, Math.min(3_000, 300 * ++attempts));
    };
    connect();
  }
}
