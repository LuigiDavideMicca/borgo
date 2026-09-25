import { CsrfField, redirect, type ActionContext, type LoaderContext } from "borgo-framework";
import type { Me } from "@/.borgo/api-types";

export const head = { title: "Account · {{name}}" };

// the guard is middleware.ts: an unauthenticated visit is redirected to
// /login before this loader runs, on full loads and client navigations alike
export async function loader({ api }: LoaderContext) {
  return { me: await api("GET /api/me") };
}

// logout as a form action: works without client javascript too
export async function action({ api }: ActionContext) {
  await api("POST /api/logout");
  return redirect("/");
}

export default function Account({ me }: { me: Me }) {
  return (
    <main>
      <h1>Account</h1>
      <p>
        Signed in as <strong>{me.username}</strong>.
      </p>
      <form method="post">
        <CsrfField />
        <button type="submit">Log out</button>
      </form>
    </main>
  );
}
