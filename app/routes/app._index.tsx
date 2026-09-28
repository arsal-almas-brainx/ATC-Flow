import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { Form, Link, redirect, useActionData, useLoaderData, useNavigation } from "react-router";
import { requireAdmin } from "../auth.server";
import prisma from "../db.server";
import { createStore, listStores, validateStoreInput } from "../atc/stores.server";
import { describeWebBotAuthStatus } from "../atc/web-bot-auth.server";
import { StatusBadge } from "../components/StatusBadge";
import type { RunStatus } from "../atc/types";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await requireAdmin(request);
  const stores = await listStores();
  const lastRuns = await Promise.all(
    stores.map((s) =>
      prisma.flowRun.findFirst({
        where: { storeId: s.id },
        orderBy: { startedAt: "desc" },
        select: { status: true, startedAt: true },
      }),
    ),
  );
  return {
    stores: stores.map((s, i) => ({
      id: s.id,
      name: s.name,
      url: s.url,
      webBotAuth: describeWebBotAuthStatus(s),
      lastRun: lastRuns[i]
        ? { status: lastRuns[i]!.status as RunStatus, startedAt: lastRuns[i]!.startedAt.getTime() }
        : null,
    })),
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  await requireAdmin(request);
  const form = await request.formData();
  const result = validateStoreInput({
    name: String(form.get("name") ?? ""),
    url: String(form.get("url") ?? ""),
    productUrls: String(form.get("productUrls") ?? ""),
    discountCode: "",
  });
  if ("error" in result) return { error: result.error };
  const store = await createStore(result.data);
  return redirect(`/app/stores/${store.id}/settings`);
};

export default function Stores() {
  const { stores } = useLoaderData<typeof loader>();
  const result = useActionData<typeof action>();
  const busy = useNavigation().state === "submitting";

  return (
    <s-page heading="Stores">
      <s-section heading={`Stores (${stores.length})`}>
        {stores.length === 0 ? (
          <s-paragraph>No stores yet. Add one below.</s-paragraph>
        ) : (
          <s-table>
            <s-table-header-row>
              <s-table-header>Store</s-table-header>
              <s-table-header>Web Bot Auth</s-table-header>
              <s-table-header>Last check</s-table-header>
            </s-table-header-row>
            <s-table-body>
              {stores.map((s) => (
                <s-table-row key={s.id}>
                  <s-table-cell>
                    <s-stack direction="block" gap="small-500">
                      <Link to={`/app/stores/${s.id}`}>{s.name}</Link>
                      <s-text color="subdued">{s.url}</s-text>
                    </s-stack>
                  </s-table-cell>
                  <s-table-cell>
                    <s-badge
                      tone={
                        s.webBotAuth.expired
                          ? "critical"
                          : s.webBotAuth.expiringSoon
                            ? "warning"
                            : s.webBotAuth.configured
                              ? "success"
                              : "neutral"
                      }
                    >
                      {s.webBotAuth.expired
                        ? "Expired"
                        : s.webBotAuth.expiringSoon
                          ? "Expiring soon"
                          : s.webBotAuth.configured
                            ? "Active"
                            : "Not configured"}
                    </s-badge>
                  </s-table-cell>
                  <s-table-cell>
                    {s.lastRun ? (
                      <s-stack direction="inline" gap="small-200" alignItems="center">
                        <StatusBadge status={s.lastRun.status} />
                        <s-text color="subdued">
                          {new Date(s.lastRun.startedAt).toLocaleString()}
                        </s-text>
                      </s-stack>
                    ) : (
                      <s-text color="subdued">Never</s-text>
                    )}
                  </s-table-cell>
                </s-table-row>
              ))}
            </s-table-body>
          </s-table>
        )}
      </s-section>

      <s-section heading="Add a store">
        <Form method="post">
          <s-stack direction="block" gap="base">
            <s-text-field label="Name" name="name" placeholder="Wonderfold EU" />
            <s-url-field label="Store URL" name="url" placeholder="https://example.com" />
            <s-text-area
              label="Product URLs"
              name="productUrls"
              rows={3}
              details="One per line. The first one is used when you press Run check."
            />
            {result?.error && (
              <s-banner tone="critical">
                <s-paragraph>{result.error}</s-paragraph>
              </s-banner>
            )}
            <s-stack direction="inline" gap="base">
              <s-button type="submit" variant="primary" {...(busy ? { loading: true } : {})}>
                Add store
              </s-button>
            </s-stack>
          </s-stack>
        </Form>
      </s-section>
    </s-page>
  );
}
