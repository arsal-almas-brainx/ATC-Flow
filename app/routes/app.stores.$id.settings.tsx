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
import { refreshNextRun, scheduleOf } from "../atc/scheduler.server";
import { describeSchedule, formatEastern, parseTime } from "../atc/schedule";

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
    const result = validateStoreInput({
      name: String(form.get("name") ?? ""),
      url: String(form.get("url") ?? ""),
      productUrls: String(form.get("productUrls") ?? ""),
      discountCode: String(form.get("discountCode") ?? ""),
      searchQuery: String(form.get("searchQuery") ?? ""),
      slackChannel: String(form.get("slackChannel") ?? ""),
    });
    if ("error" in result) return { detailsError: result.error };
    await updateStore(store.id, result.data);
    return { detailsSavedMessage: "Store details saved." };
  }

  if (intent === "save-schedule") {
    const period = String(form.get("period") ?? "day");
    const frequency = Number(form.get("frequency") ?? 1);
    const time = String(form.get("time") ?? "").trim();
    if (!["day", "week", "month"].includes(period)) return { scheduleError: "Pick a period." };
    if (![1, 2].includes(frequency)) return { scheduleError: "Pick once or twice." };
    const parsed = parseTime(time);
    if (!parsed) return { scheduleError: "Time must be 24-hour HH:MM, e.g. 09:00 or 21:30." };
    await prisma.store.update({
      where: { id: store.id },
      data: {
        scheduleEnabled: form.get("enabled") === "on",
        schedulePeriod: period,
        scheduleFrequency: frequency,
        scheduleTime: `${String(parsed.h).padStart(2, "0")}:${String(parsed.m).padStart(2, "0")}`,
      },
    });
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
            <s-text-field label="Name" name="name" value={store.name} />
            <s-url-field label="Store URL" name="url" value={store.url} />
            <s-text-area
              label="Product URLs (optional)"
              name="productUrls"
              rows={4}
              value={store.productUrls}
              details="Optional, one per line. Each run tests one of these at random. Leave blank to pick an in-stock best seller automatically."
            />
            <s-text-field
              label="Discount code (optional)"
              name="discountCode"
              value={store.discountCode}
              details="Applied on every check. Leave blank to skip the discount check."
            />
            <s-text-field
              label="Search query (optional)"
              name="searchQuery"
              value={store.searchQuery}
              details="Typed into the store's search. Leave blank to search for the tested product's name."
            />
            <s-text-field
              label="Client Slack channel ID (optional)"
              name="slackChannel"
              value={store.slackChannel}
              placeholder="C0123ABCD"
              details="This client's reports go here, alongside the PDC and department-head channels set in Settings. In Slack: channel details → Channel ID at the bottom."
            />
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

            <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13 }}>
              <input type="checkbox" name="enabled" defaultChecked={schedule.enabled} />
              Run checks on a schedule
            </label>
            <s-stack direction="inline" gap="base">
              <s-select label="Routine" name="period" value={schedule.period}>
                <s-option value="day">Daily</s-option>
                <s-option value="week">Weekly</s-option>
                <s-option value="month">Monthly</s-option>
              </s-select>
              <s-select label="How often" name="frequency" value={schedule.frequency}>
                <s-option value="1">Once</s-option>
                <s-option value="2">Twice</s-option>
              </s-select>
              <s-text-field
                label="Start time (EST, 24h)"
                name="time"
                value={schedule.time}
                placeholder="09:00"
              />
            </s-stack>
            <s-text color="subdued">
              Runs are spread evenly: twice a day at 09:00 is 9 AM and 9 PM; twice a week is Monday
              and Thursday; twice a month is the 1st and 15th.
            </s-text>
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
              <s-password-field
                label="Storefront password"
                name="storefrontPassword"
                details="Leave blank and save to clear the stored password."
              />
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

          <s-paragraph>
            Authorizes a real Chromium browser to click the theme&apos;s actual Add-to-cart
            button, past Shopify&apos;s bot protection. Create a signature in the store&apos;s
            Shopify Admin → Online Store → Preferences → Crawler access, then paste its values
            below. There is no API to create or renew one — it expires after at most 3 months.
          </s-paragraph>

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
              <s-password-field label="Signature" name="signature" details="From Shopify Admin's Crawler access page." />
              <s-password-field
                label="Signature-Input"
                name="signatureInput"
                details="From the same page, alongside Signature."
              />
              <s-date-field
                label="Expires"
                name="expiresAt"
                value={expiresDefault}
                details="The expiry date Shopify Admin showed for this signature."
              />
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
