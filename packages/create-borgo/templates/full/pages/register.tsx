import { ApiError, CsrfField, redirect, type ActionContext, type LoaderContext } from "borgo-framework";

export const head = { title: "Register · {{name}}" };

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
  if (!username || !password) return { error: "username and password required" };
  try {
    await api("POST /api/register", { body: { username, password } });
  } catch (error) {
    if (error instanceof ApiError && error.status === 409) return { error: "username taken" };
    throw error;
  }
  return redirect("/account");
}

export default function Register({ actionData }: { actionData?: { error?: string } }) {
  return (
    <main>
      <h1>Register</h1>
      <form method="post">
        <CsrfField />
        <input name="username" placeholder="Username" autoComplete="username" />
        <input name="password" type="password" placeholder="Password" autoComplete="new-password" />
        <button type="submit">Create account</button>
      </form>
      {actionData?.error && <p className="error">{actionData.error}</p>}
      <p>
        Already registered? <a href="/login">Log in</a>
      </p>
    </main>
  );
}
