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
  const email = String(form.get("email") ?? "").trim();
  const password = String(form.get("password") ?? "");
  if (!username || !password) return { error: "username and password required" };
  // the api refuses an empty username or password; the rest of the form is
  // this app's to validate, here, where the message can be shown
  if (!/^[^\s@]+@[^\s@]+$/.test(email)) return { error: "a valid email is required" };
  try {
    await api("POST /api/register", { body: { username, password, email } });
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
        <input name="email" type="email" placeholder="Email" autoComplete="email" />
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
