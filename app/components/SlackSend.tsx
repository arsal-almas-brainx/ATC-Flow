import { useEffect, useState } from "react";
import { useFetcher } from "react-router";
import type { Audience, DeliveryResult } from "../atc/report.server";

type SlackInfo = {
  botConfigured: boolean;
  targets: Array<{ audience: Audience; label: string; configured: boolean }>;
  preview: string;
  deliveries: Array<{ label: string; ok: boolean; error: string | null; sentAt: number }>;
};

type SendResult = { error: string } | { results: DeliveryResult[] };

/**
 * "Send to Slack" for one finished check or speed test: pick channels,
 * preview, send, see past sends. `endpoint` serves the info (GET) and sends (POST).
 */
export function SlackSend({ endpoint }: { endpoint: string }) {
  const info = useFetcher<SlackInfo>();
  const sender = useFetcher<SendResult>();
  const [selected, setSelected] = useState<Audience[] | null>(null);
  const [showPreview, setShowPreview] = useState(false);

  useEffect(() => {
    info.load(endpoint);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [endpoint]);

  // Refresh the "Sent" history once a send completes.
  useEffect(() => {
    if (sender.state === "idle" && sender.data) info.load(endpoint);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sender.state, sender.data]);

  const data = info.data;
  if (!data) return null;

  // The client channel is opt-in: a report reaches a client only when ticked on purpose.
  const configured = data.targets
    .filter((t) => t.configured && t.audience !== "client")
    .map((t) => t.audience);
  const chosen = selected ?? configured;
  const toggle = (a: Audience) =>
    setSelected(chosen.includes(a) ? chosen.filter((x) => x !== a) : [...chosen, a]);

  const send = () => {
    const form = new FormData();
    for (const a of chosen) form.append("audience", a);
    sender.submit(form, { method: "POST", action: endpoint });
  };

  const result = sender.data;
  const busy = sender.state !== "idle";

  return (
    <s-box background="subdued" borderRadius="base" padding="base">
      <s-stack direction="block" gap="base">
        <s-stack direction="inline" gap="small-200" alignItems="center">
          <s-icon type="send" size="small" color="subdued" />
          <s-text type="strong">Send to Slack</s-text>
        </s-stack>

        {!data.botConfigured ? (
          <s-paragraph>
            <s-text color="subdued">
              Slack isn&apos;t connected yet — add the bot token in Settings.
            </s-text>
          </s-paragraph>
        ) : (
          <>
            <s-stack direction="inline" gap="large-100">
              {data.targets.map((t) => (
                <label
                  key={t.audience}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 6,
                    fontSize: 13,
                    opacity: t.configured ? 1 : 0.5,
                  }}
                  title={t.configured ? undefined : "No channel ID set"}
                >
                  <input
                    type="checkbox"
                    disabled={!t.configured}
                    checked={t.configured && chosen.includes(t.audience)}
                    onChange={() => toggle(t.audience)}
                  />
                  {t.label}
                  {!t.configured && " (not set)"}
                </label>
              ))}
            </s-stack>

            <s-stack direction="inline" gap="base" alignItems="center">
              <s-button
                variant="primary"
                onClick={send}
                disabled={chosen.length === 0 || undefined}
                {...(busy ? { loading: true } : {})}
              >
                Send report
              </s-button>
              <s-clickable onClick={() => setShowPreview((v) => !v)}>
                <s-text color="subdued">{showPreview ? "Hide preview" : "Preview message"}</s-text>
              </s-clickable>
            </s-stack>
          </>
        )}

        {showPreview && (
          <pre
            style={{
              margin: 0,
              padding: 12,
              background: "#fff",
              border: "1px solid #e3e3e3",
              borderRadius: 8,
              whiteSpace: "pre-wrap",
              font: "13px/1.5 -apple-system, BlinkMacSystemFont, sans-serif",
            }}
          >
            {data.preview}
          </pre>
        )}

        {result && "error" in result && (
          <s-banner tone="critical">
            <s-paragraph>{result.error}</s-paragraph>
          </s-banner>
        )}
        {result && "results" in result && (
          <s-banner
            tone={result.results.every((r) => r.ok) ? "success" : "warning"}
            heading={result.results.every((r) => r.ok) ? "Sent" : "Some channels failed"}
          >
            {result.results.map((r) => (
              <s-paragraph key={r.audience}>
                {r.ok ? "✓" : "✗"} {r.label}
                {r.error ? ` — ${r.error}` : ""}
              </s-paragraph>
            ))}
          </s-banner>
        )}

        {data.deliveries.length > 0 && (
          <s-stack direction="block" gap="small-500">
            <s-text color="subdued">Sent</s-text>
            {data.deliveries.map((d, i) => (
              <s-text key={i} color="subdued">
                {d.ok ? "✓" : "✗"} {d.label} · {new Date(d.sentAt).toLocaleString()}
                {d.error ? ` — ${d.error}` : ""}
              </s-text>
            ))}
          </s-stack>
        )}
      </s-stack>
    </s-box>
  );
}
