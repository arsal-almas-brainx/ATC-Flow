import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { Form, redirect, useActionData, useLoaderData, useNavigation } from "react-router";
import {
  adminPasswordConfigured,
  checkAdminPassword,
  isAdmin,
  safeNext,
  signIn,
} from "../auth.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const next = safeNext(new URL(request.url).searchParams.get("next"));
  if (await isAdmin(request)) throw redirect(next);
  return { next, configured: await adminPasswordConfigured() };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const form = await request.formData();
  const next = safeNext(String(form.get("next") ?? ""));
  if (!(await checkAdminPassword(String(form.get("password") ?? "")))) {
    return { error: "Wrong password." };
  }
  return signIn(request, next);
};

export default function Login() {
  const { next, configured } = useLoaderData<typeof loader>();
  const result = useActionData<typeof action>();
  const busy = useNavigation().state !== "idle";

  return (
    <div style={{ maxWidth: 400, margin: "12vh auto", padding: "0 16px" }}>
      <s-section heading="ATC Flow — sign in">
        {configured ? (
          <Form method="post">
            <input type="hidden" name="next" value={next} />
            <s-stack direction="block" gap="base">
              <s-password-field label="Admin password" name="password" autocomplete="current-password" />
              {result?.error && (
                <s-banner tone="critical">
                  <s-paragraph>{result.error}</s-paragraph>
                </s-banner>
              )}
              <s-button type="submit" variant="primary" {...(busy ? { loading: true } : {})}>
                Sign in
              </s-button>
            </s-stack>
          </Form>
        ) : (
          <s-banner tone="critical" heading="No admin password set">
            <s-paragraph>
              Set the ADMIN_PASSWORD environment variable and restart the server.
            </s-paragraph>
          </s-banner>
        )}
      </s-section>
    </div>
  );
}
