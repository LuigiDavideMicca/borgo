import { next, redirect, type PageMiddleware } from "borgo-framework";

// the guard of the pages only a signed-in user sees, in one place instead of
// inside each loader. It runs before the loader, the props a client
// navigation fetches, and the page's action - all three - with the session go
// already verified, so no page here asks the api who is signed in just to
// decide whether to render
export const matcher = ["/account", "/attach"];

export const middleware: PageMiddleware = (_request, { session }) => {
  if (!session) return redirect("/login");
  // next() can add response headers; e2e/middleware.e2e.ts reads this one to
  // tell a page the guard let through from one it never saw
  return next({ headers: { "x-account-guard": "middleware.ts" } });
};
