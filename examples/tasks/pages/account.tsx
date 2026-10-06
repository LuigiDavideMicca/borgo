import { useEffect } from "react";
import { CsrfField, redirect, subscribe, type ActionContext, type LoaderContext } from "borgo-framework";
import type { Me } from "@/.borgo/api-types";

export const head = { title: "Account · borgo tasks" };

// guarded by middleware.ts, which runs before this loader, before the props a
// client navigation fetches and before the action below. So there is always a
// session here, and it is the one go verified: what the session stores is
// exactly Me (see Principal in api/users.go), with no api call to fetch it
export async function loader({ session }: LoaderContext) {
  return { me: session as unknown as Me };
}

// logout is a classic form post, so it works without client javascript
export async function action({ api }: ActionContext) {
  await api("POST /api/logout");
  return redirect("/");
}

export default function Account({ me }: { me: Me }) {
  // the user's own topic, typed by the //borgo:topic directive on the push
  // in api/users.go: "signed-out" carries { at }, and a wrong reading fails
  // tsc. Only this user's sockets may hold it (api/realtime.go)
  useEffect(() => {
    const ch = subscribe(`user:${me.username}`, (event, data) => {
      if (event === "signed-out") location.assign("/login?signed-out=" + data.at);
    });
    return () => ch.close();
  }, [me.username]);
  return (
    <main>
      <h1>Account</h1>
      <p>
        Signed in as <strong>{me.username}</strong>.
      </p>
      <form method="post">
        <CsrfField />
        <button>Log out</button>
      </form>
    </main>
  );
}
