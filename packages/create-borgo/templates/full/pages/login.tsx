import { ApiError, CsrfField, redirect, type ActionContext, type LoaderContext } from "borgo-framework";

export const head = { title: "Log in · {{name}}" };

export async function loader({ api }: LoaderContext) {
  try {
    await api("GET /api/me");
    return redirect("/account");
  } catch {
    return {};
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

export default function Login({ actionData }: { actionData?: { error?: string } }) {
  return (
    <main>
      <h1>Log in</h1>
      <form method="post">
        <CsrfField />
        <input name="username" placeholder="Username" autoComplete="username" />
        <input name="password" type="password" placeholder="Password" autoComplete="current-password" />
        <button type="submit">Log in</button>
      </form>
      {actionData?.error && <p className="error">{actionData.error}</p>}
      <p>
        No account? <a href="/register">Register</a>
      </p>
    </main>
  );
}
