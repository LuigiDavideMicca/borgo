import { ApiError, CsrfField, redirect, type ActionContext, type LoaderContext } from "borgo-framework";

export const head = { title: "Log in · borgo tasks" };

export async function loader({ api, request }: LoaderContext) {
  try {
    await api("GET /api/me");
    return redirect("/account");
  } catch {
    // the account page sends a device here the instant its user logged out
    // everywhere, with the moment (see the "signed-out" event in api/users.go)
    const at = Number(new URL(request.url).searchParams.get("signed-out"));
    return { signedOut: at > 0 ? new Date(at * 1000).toLocaleTimeString() : null };
  }
}

export async function action({ request, api }: ActionContext) {
  const form = await request.formData();
  const username = String(form.get("username") ?? "").trim();
  const password = String(form.get("password") ?? "");
  try {
    await api("POST /api/login", { body: { username, password } });
  } catch (error) {
    if (error instanceof ApiError && (error.status === 401 || error.status === 400)) {
      return { error: "wrong username or password" };
    }
    throw error;
  }
  return redirect("/account");
}

export default function Login({ actionData, signedOut }: { actionData?: { error?: string }; signedOut?: string | null }) {
  return (
    <main>
      <h1>Log in</h1>
      {signedOut && <p className="notice">You were logged out everywhere at {signedOut}. Log in again to continue.</p>}
      <form method="post">
        <CsrfField />
        <input name="username" placeholder="Username" autoComplete="username" />
        <input name="password" type="password" placeholder="Password" autoComplete="current-password" />
        <button>Log in</button>
      </form>
      {actionData?.error && <p className="error">{actionData.error}</p>}
      <p>
        No account? <a href="/register">Register</a>
      </p>
    </main>
  );
}
