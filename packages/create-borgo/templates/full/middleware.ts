import { next, redirect, type PageMiddleware } from "borgo-framework";

// The account page's guard, in one place instead of inside its loader. It
// runs before the loader, the props a client navigation fetches, and the
// logout action - all three doors - with the session go already verified,
// so the page never asks the api who is signed in just to decide whether to
// render. A matcher entry may not name /api: that side is api/middleware.go's.
export const matcher = ["/account"];

export const middleware: PageMiddleware = (_request, { session, locals }) => {
  if (!session) return redirect("/login");
  // what api/middleware.go forwarded is here as locals; next() may add
  // response headers, which a page can read to tell a guarded load apart
  return next({ headers: { "x-account-guard": String(locals.username ?? "") } });
};
