import { useEffect, useRef } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { redirect, useFetcher, useLoaderData, useRevalidator } from "react-router";
import { requireAdmin } from "../auth.server";
import prisma from "../db.server";
import {
  deleteStore,
  getStore,
  saveStorefrontPassword,
  saveWebBotAuthCredentials,
  updateStore,
  validateStoreInput,
} from "../atc/stores.server";
import { describeWebBotAuthStatus } from "../atc/web-bot-auth.server";
import { parseScheduleForm, refreshNextRun, scheduleOf } from "../atc/scheduler.server";
import { describeSchedule, formatEastern } from "../atc/schedule";
import {
  ScheduleFields,
  StoreDetailsFields,
  StorefrontPasswordField,
  WebBotAuthFields,
  detailsFromForm,
} from "../components/StoreFields";

async function loadStore(id: string | undefined) {
  const store = id ? await getStore(id) : null;
  if (!store) throw new Response("Store not found", { status: 404 });
  return store;
}

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  await requireAdmin(request);
  const store = await loadStore(params.id);
  return {
    store: {
      id: store.id,
      name: store.name,
      url: store.url,
      productUrls: store.productUrls,
      discountCode: store.discountCode ?? "",
      searchQuery: store.searchQuery ?? "",
      slackChannel: store.slackChannel ?? "",
      internalSlackChannel: store.internalSlackChannel ?? "",
      speedCollectionUrl: store.speedCollectionUrl ?? "",
    },
    // Never send secret values back to the browser — only their status.
    passwordSaved: store.storefrontPassword !== null,
    schedule: {
      enabled: store.scheduleEnabled,
      period: store.schedulePeriod,
      frequency: String(store.scheduleFrequency),
      time: store.scheduleTime,
      description: describeSchedule(scheduleOf(store)),
      nextRunAt: store.nextRunAt ? formatEastern(store.nextRunAt) : null,
    },
    webBotAuth: describeWebBotAuthStatus(store),
  };
};

export const action = async ({ request, params }: ActionFunctionArgs) => {
  await requireAdmin(request);
  const store = await loadStore(params.id);
  const form = await request.formData();
  const intent = String(form.get("intent") ?? "");

  if (intent === "save-details") {
    const result = validateStoreInput(detailsFromForm(form));
    if ("error" in result) return { detailsError: result.error };
    await updateStore(store.id, result.data);
    return { detailsSavedMessage: "Store details saved." };
  }

  if (intent === "save-schedule") {
    const parsed = parseScheduleForm(form);
    if ("error" in parsed) return { scheduleError: parsed.error };
    await prisma.store.update({ where: { id: store.id }, data: parsed.data });
    await refreshNextRun(store.id);
    return { scheduleSavedMessage: "Schedule saved." };
  }

  if (intent === "save-password") {
    const saved = await saveStorefrontPassword(
      store.id,
      String(form.get("storefrontPassword") ?? ""),
    );
    return {
      savedMessage: saved
        ? "Storefront password saved. Every check will use it automatically."
        : "Storefront password cleared.",
    };
  }

  if (intent === "save-web-bot-auth") {
    const saved = await saveWebBotAuthCredentials(store.id, {
      signature: String(form.get("signature") ?? ""),
      signatureInput: String(form.get("signatureInput") ?? ""),
      expiresAt: String(form.get("expiresAt") ?? "").trim() || null,
    });
    return {
      wbaSavedMessage: saved
        ? "Web Bot Auth signature saved. The real-browser checks will use it automatically."
        : "Web Bot Auth signature cleared — the real-browser checks will be skipped.",
    };
  }

  if (intent === "delete-store") {
    await deleteStore(store.id);
    return redirect("/app");
  }

  return { error: "Unknown action." };
};

type ActionData = {
  scheduleError?: string;
  scheduleSavedMessage?: string;
  detailsError?: string;
  detailsSavedMessage?: string;
  savedMessage?: string;
  wbaSavedMessage?: string;
};

export default function StoreSettings() {
  const { store, passwordSaved, webBotAuth, schedule } = useLoaderData<typeof loader>();
  const detailsSaver = useFetcher<ActionData>();
  const passwordSaver = useFetcher<ActionData>();
  const scheduleSaver = useFetcher<ActionData>();
  const wbaSaver = useFetcher<ActionData>();
  const deleter = useFetcher();
  const revalidator = useRevalidator();

  const detailsFormRef = useRef<HTMLFormElement>(null);
  const passwordFormRef = useRef<HTMLFormElement>(null);
  const scheduleFormRef = useRef<HTMLFormElement>(null);
  const scheduleSavedMessage = scheduleSaver.data?.scheduleSavedMessage ?? null;
  const scheduleError = scheduleSaver.data?.scheduleError ?? null;
  const wbaFormRef = useRef<HTMLFormElement>(null);

  const detailsSavedMessage = detailsSaver.data?.detailsSavedMessage ?? null;
  const detailsError = detailsSaver.data?.detailsError ?? null;
  const savedMessage = passwordSaver.data?.savedMessage ?? null;
  const wbaSavedMessage = wbaSaver.data?.wbaSavedMessage ?? null;

  useEffect(() => {
    if (detailsSavedMessage || savedMessage || wbaSavedMessage || scheduleSavedMessage) {
      revalidator.revalidate();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [detailsSavedMessage, savedMessage, wbaSavedMessage]);

  const submit = (fetcher: typeof detailsSaver, ref: React.RefObject<HTMLFormElement | null>) => {
    if (ref.current) fetcher.submit(ref.current, { method: "POST" });
  };

  const confirmDelete = () => {
    if (!window.confirm(`Delete ${store.name} and all of its check history?`)) return;
    deleter.submit({ intent: "delete-store" }, { method: "POST" });
  };

  const wbaBadge = webBotAuth.expired
    ? { tone: "critical" as const, label: "Expired" }
    : webBotAuth.expiringSoon
      ? {
          tone: "warning" as const,
          label: `Expires in ${daysUntil(webBotAuth.expiresAt)}d`,
        }
      : webBotAuth.configured
        ? { tone: "success" as const, label: "Active" }
        : { tone: "neutral" as const, label: "Not configured" };

  const showWbaBanner = webBotAuth.expiringSoon || webBotAuth.expired;
  const expiresDefault = webBotAuth.expiresAt
    ? new Date(webBotAuth.expiresAt).toISOString().slice(0, 10)
    : "";

  return (
    <s-page heading={`${store.name} · Settings`}>
      <s-link slot="breadcrumb-actions" href={`/app/stores/${store.id}`}>
        Store
      </s-link>

      <s-section heading="Store details">
        <form ref={detailsFormRef} onSubmit={(e) => e.preventDefault()}>
          <input type="hidden" name="intent" value="save-details" />
          <s-stack direction="block" gap="base">
            <StoreDetailsFields values={store} />
            {detailsError && (
              <s-banner tone="critical">
                <s-paragraph>{detailsError}</s-paragraph>
              </s-banner>
            )}
            {detailsSavedMessage && (
              <s-banner tone="success">
                <s-paragraph>{detailsSavedMessage}</s-paragraph>
              </s-banner>
            )}
            <s-stack direction="inline" gap="base">
              <s-button
                onClick={() => submit(detailsSaver, detailsFormRef)}
                {...(detailsSaver.state !== "idle" ? { loading: true } : {})}
              >
                Save details
              </s-button>
            </s-stack>
          </s-stack>
        </form>
      </s-section>

      <s-section heading="Schedule">
        <form ref={scheduleFormRef} onSubmit={(e) => e.preventDefault()}>
          <input type="hidden" name="intent" value="save-schedule" />
          <s-stack direction="block" gap="base">
            <s-stack direction="inline" gap="small-200" alignItems="center">
              <s-text>Status:</s-text>
              <s-badge tone={schedule.enabled ? "success" : "neutral"}>
                {schedule.enabled ? "On" : "Off"}
              </s-badge>
              {schedule.enabled && <s-text color="subdued">{schedule.description}</s-text>}
            </s-stack>
            {schedule.enabled && schedule.nextRunAt && (
              <s-paragraph>
                Next check: <s-text type="strong">{schedule.nextRunAt} EST</s-text>. Each scheduled
                check runs on desktop and mobile and posts its report to every Slack channel set
                for this store.
              </s-paragraph>
            )}

            <ScheduleFields values={schedule} />
            {scheduleError && (
              <s-banner tone="critical">
                <s-paragraph>{scheduleError}</s-paragraph>
              </s-banner>
            )}
            {scheduleSavedMessage && (
              <s-banner tone="success">
                <s-paragraph>{scheduleSavedMessage}</s-paragraph>
              </s-banner>
            )}
            <s-stack direction="inline" gap="base">
              <s-button
                onClick={() => submit(scheduleSaver, scheduleFormRef)}
                {...(scheduleSaver.state !== "idle" ? { loading: true } : {})}
              >
                Save schedule
              </s-button>
            </s-stack>
          </s-stack>
        </form>
      </s-section>

      <s-section heading="Storefront password">
        <s-stack direction="block" gap="base">
          <s-stack direction="inline" gap="small-200" alignItems="center">
            <s-text>Status:</s-text>
            <s-badge tone={passwordSaved ? "success" : "neutral"}>
              {passwordSaved ? "Saved" : "Not set"}
            </s-badge>
          </s-stack>

          <s-paragraph>
            Only needed while the store is password protected (Online Store → Preferences →
            Password protection).
          </s-paragraph>

          <form ref={passwordFormRef} onSubmit={(e) => e.preventDefault()}>
            <input type="hidden" name="intent" value="save-password" />
            <s-stack direction="block" gap="base">
              <StorefrontPasswordField saved={passwordSaved} />
              <s-stack direction="inline" gap="base">
                <s-button
                  onClick={() => submit(passwordSaver, passwordFormRef)}
                  {...(passwordSaver.state !== "idle" ? { loading: true } : {})}
                >
                  {passwordSaved ? "Update password" : "Save password"}
                </s-button>
              </s-stack>
              {savedMessage && (
                <s-banner tone="success" heading="Saved">
                  <s-paragraph>{savedMessage}</s-paragraph>
                </s-banner>
              )}
            </s-stack>
          </form>
        </s-stack>
      </s-section>

      <s-section heading="Web Bot Auth (real-browser checks)">
        <s-stack direction="block" gap="base">
          <s-stack direction="inline" gap="small-200" alignItems="center">
            <s-text>Status:</s-text>
            <s-badge tone={wbaBadge.tone}>{wbaBadge.label}</s-badge>
          </s-stack>

          {showWbaBanner && (
            <s-banner tone={webBotAuth.expired ? "critical" : "warning"} heading={wbaBadge.label}>
              <s-paragraph>
                {webBotAuth.expired
                  ? "This signature has expired, so the real-browser checks are being skipped. "
                  : "This signature is expiring soon — once it does, the real-browser checks will be skipped. "}
                Create a new one in Shopify Admin → Online Store → Preferences → Crawler access
                and paste it below.
              </s-paragraph>
            </s-banner>
          )}

          <form ref={wbaFormRef} onSubmit={(e) => e.preventDefault()}>
            <input type="hidden" name="intent" value="save-web-bot-auth" />
            <s-stack direction="block" gap="base">
              <WebBotAuthFields expires={expiresDefault} />
              <s-stack direction="inline" gap="base">
                <s-button
                  onClick={() => submit(wbaSaver, wbaFormRef)}
                  {...(wbaSaver.state !== "idle" ? { loading: true } : {})}
                >
                  {webBotAuth.configured ? "Update signature" : "Save signature"}
                </s-button>
              </s-stack>
              {wbaSavedMessage && (
                <s-banner tone="success" heading="Saved">
                  <s-paragraph>{wbaSavedMessage}</s-paragraph>
                </s-banner>
              )}
            </s-stack>
          </form>
        </s-stack>
      </s-section>

      <s-section heading="Delete store">
        <s-stack direction="block" gap="base">
          <s-paragraph>Removes this store and all of its check history.</s-paragraph>
          <s-stack direction="inline" gap="base">
            <s-button tone="critical" onClick={confirmDelete}>
              Delete store
            </s-button>
          </s-stack>
        </s-stack>
      </s-section>
    </s-page>
  );
}

function daysUntil(epochMs?: number): number {
  if (!epochMs) return 0;
  return Math.max(0, Math.ceil((epochMs - Date.now()) / 86_400_000));
}
