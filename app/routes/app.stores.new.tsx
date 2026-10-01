import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { Form, redirect, useActionData, useNavigation } from "react-router";
import { requireAdmin } from "../auth.server";
import prisma from "../db.server";
import {
  createStore,
  saveStorefrontPassword,
  saveWebBotAuthCredentials,
  validateStoreInput,
} from "../atc/stores.server";
import { parseScheduleForm, refreshNextRun } from "../atc/scheduler.server";
import {
  DEFAULT_SCHEDULE,
  EMPTY_DETAILS,
  ScheduleFields,
  StoreDetailsFields,
  StorefrontPasswordField,
  WebBotAuthFields,
  detailsFromForm,
  type ScheduleValues,
} from "../components/StoreFields";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await requireAdmin(request);
  return null;
};

/** Creates the store with everything in one go, then opens it. */
export const action = async ({ request }: ActionFunctionArgs) => {
  await requireAdmin(request);
  const form = await request.formData();
  const details = detailsFromForm(form);
  const schedule: ScheduleValues = {
    enabled: form.get("enabled") === "on",
    period: String(form.get("period") ?? "day"),
    frequency: String(form.get("frequency") ?? "1"),
    time: String(form.get("time") ?? ""),
  };
  // Typed values go back on error so nothing has to be retyped (secrets excepted).
  const fail = (error: string) => ({ error, details, schedule });

  const validated = validateStoreInput(details);
  if ("error" in validated) return fail(validated.error);
  const parsedSchedule = parseScheduleForm(form);
  if ("error" in parsedSchedule) return fail(parsedSchedule.error);

  const signature = String(form.get("signature") ?? "").trim();
  const signatureInput = String(form.get("signatureInput") ?? "").trim();
  if (Boolean(signature) !== Boolean(signatureInput)) {
    return fail("Web Bot Auth needs both the Signature and the Signature-Input.");
  }

  const store = await createStore(validated.data);
  await prisma.store.update({ where: { id: store.id }, data: parsedSchedule.data });
  if (signature) {
    await saveWebBotAuthCredentials(store.id, {
      signature,
      signatureInput,
      expiresAt: String(form.get("expiresAt") ?? "").trim() || null,
    });
  }
  const password = String(form.get("storefrontPassword") ?? "");
  if (password.trim()) await saveStorefrontPassword(store.id, password);
  await refreshNextRun(store.id);

  return redirect(`/app/stores/${store.id}`);
};

export default function NewStore() {
  const result = useActionData<typeof action>();
  const busy = useNavigation().state === "submitting";

  return (
    <s-page heading="Add a store">
      <s-link slot="breadcrumb-actions" href="/app">
        Stores
      </s-link>

      <Form method="post">
        <s-stack direction="block" gap="base">
          <s-section heading="Store details">
            <s-stack direction="block" gap="base">
              <StoreDetailsFields values={result?.details ?? EMPTY_DETAILS} />
            </s-stack>
          </s-section>

          <s-section heading="Web Bot Auth (needed for flow tests)">
            <s-stack direction="block" gap="base">
              <WebBotAuthFields expires="" />
            </s-stack>
          </s-section>

          <s-section heading="Storefront password">
            <s-stack direction="block" gap="base">
              <StorefrontPasswordField saved={false} />
            </s-stack>
          </s-section>

          <s-section heading="Schedule">
            <s-stack direction="block" gap="base">
              <ScheduleFields values={result?.schedule ?? DEFAULT_SCHEDULE} />
            </s-stack>
          </s-section>

          <s-section>
            <s-stack direction="block" gap="base">
              {result?.error && (
                <s-banner tone="critical" heading="Couldn't add the store">
                  <s-paragraph>
                    {result.error.replace(/\.?$/, ".")} Re-enter the Web Bot Auth values and storefront password — they
                    aren&apos;t kept after an error.
                  </s-paragraph>
                </s-banner>
              )}
              <s-stack direction="inline" gap="base">
                <s-button type="submit" variant="primary" {...(busy ? { loading: true } : {})}>
                  Add store
                </s-button>
                <s-button variant="tertiary" href="/app">
                  Cancel
                </s-button>
              </s-stack>
              <s-text color="subdued">
                Everything except the name and URL is optional and can be changed later in the
                store&apos;s Settings.
              </s-text>
            </s-stack>
          </s-section>
        </s-stack>
      </Form>
    </s-page>
  );
}
