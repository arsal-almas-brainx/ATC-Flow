import {
  ALERT_DROP,
  PAGE_LABEL,
  PAGES,
  type Rating,
  type SpeedPage,
  type SpeedResult,
  type SpeedRunView,
} from "../atc/speed";
import { SlackSend } from "./SlackSend";

const TONE: Record<Rating, "success" | "warning" | "critical"> = {
  GOOD: "success",
  AVERAGE: "warning",
  POOR: "critical",
};

const DEVICES = ["mobile", "desktop"] as const;
const DEVICE_LABEL = { mobile: "Mobile", desktop: "Desktop" } as const;

const secs = (ms?: number) => (ms == null ? "—" : `${(ms / 1000).toFixed(1)}s`);
const millis = (ms?: number) => (ms == null ? "—" : `${Math.round(ms)}ms`);

function ScoreBadge({ result }: { result?: SpeedResult }) {
  if (!result) return <s-text color="subdued">—</s-text>;
  if (result.score == null) return <s-badge tone="neutral">No score</s-badge>;
  return (
    <s-badge tone={TONE[result.rating ?? "POOR"]}>
      {`${result.rating} · ${result.score}`}
    </s-badge>
  );
}

/** One speed test: every page × device with its score and key timings. */
export function SpeedDetail({ speed }: { speed: SpeedRunView }) {
  const running = speed.status === "running";
  const errors = speed.results.filter((r) => r.error);

  return (
    <s-section
      heading={
        running
          ? "Speed test running… (Google takes up to a minute per page)"
          : `Speed test · ${new Date(speed.startedAt).toLocaleString()}`
      }
    >
      <s-stack direction="block" gap="base">
        {speed.alerts.length > 0 && (
          <s-banner tone="warning" heading="Speed alerts">
            {speed.alerts.map((a) => (
              <s-paragraph key={a}>{a}</s-paragraph>
            ))}
          </s-banner>
        )}

        {!running && (
          <s-table>
            <s-table-header-row>
              <s-table-header>Page</s-table-header>
              <s-table-header>Device</s-table-header>
              <s-table-header>Score</s-table-header>
              <s-table-header>Main content (LCP)</s-table-header>
              <s-table-header>Layout shift (CLS)</s-table-header>
              <s-table-header>Blocking (TBT)</s-table-header>
              <s-table-header>Real visitors (INP)</s-table-header>
              <s-table-header>Report</s-table-header>
            </s-table-header-row>
            <s-table-body>
              {PAGES.flatMap((page) =>
                DEVICES.map((device) => {
                  const r = speed.results.find((x) => x.page === page && x.device === device);
                  return (
                    <s-table-row key={`${page}-${device}`}>
                      <s-table-cell>{PAGE_LABEL[page]}</s-table-cell>
                      <s-table-cell>{DEVICE_LABEL[device]}</s-table-cell>
                      <s-table-cell>
                        <ScoreBadge result={r} />
                      </s-table-cell>
                      <s-table-cell>{secs(r?.lcpMs)}</s-table-cell>
                      <s-table-cell>{r?.cls == null ? "—" : r.cls.toFixed(2)}</s-table-cell>
                      <s-table-cell>{millis(r?.tbtMs)}</s-table-cell>
                      <s-table-cell>{millis(r?.fieldInpMs)}</s-table-cell>
                      <s-table-cell>
                        {r?.reportUrl ? (
                          <s-link href={r.reportUrl} target="_blank">
                            Google report
                          </s-link>
                        ) : (
                          "—"
                        )}
                      </s-table-cell>
                    </s-table-row>
                  );
                }),
              )}
            </s-table-body>
          </s-table>
        )}

        {!running && errors.length > 0 && (
          <s-banner tone="info" heading="Not measured">
            {errors.map((r) => (
              <s-paragraph key={`${r.page}-${r.device}`}>
                {PAGE_LABEL[r.page]} ({DEVICE_LABEL[r.device]}): {r.error}
              </s-paragraph>
            ))}
          </s-banner>
        )}

        {!running && <SlackSend key={speed.id} endpoint={`/api/speed/${speed.id}/slack`} />}
      </s-stack>
    </s-section>
  );
}

/** Score history: one row per test, a column per page × device. Click a row to open it. */
export function SpeedHistory({
  runs,
  activeId,
  onPick,
}: {
  runs: SpeedRunView[];
  activeId: string | null;
  onPick: (id: string) => void;
}) {
  if (runs.length === 0) {
    return (
      <s-section heading="Speed history">
        <s-paragraph>No speed tests yet.</s-paragraph>
      </s-section>
    );
  }
  return (
    <s-section heading="Speed history">
      <s-table>
        <s-table-header-row>
          <s-table-header>Tested</s-table-header>
          {PAGES.flatMap((page) =>
            DEVICES.map((device) => (
              <s-table-header key={`${page}-${device}`}>
                {`${PAGE_LABEL[page]} ${device === "mobile" ? "📱" : "🖥"}`}
              </s-table-header>
            )),
          )}
        </s-table-header-row>
        <s-table-body>
          {runs.map((run) => (
            <s-table-row key={run.id}>
              <s-table-cell>
                <s-clickable onClick={() => onPick(run.id)}>
                  <s-text type={run.id === activeId ? "strong" : undefined}>
                    {new Date(run.startedAt).toLocaleString()}
                  </s-text>
                </s-clickable>
                {run.trigger === "schedule" && <s-badge tone="info">Scheduled</s-badge>}
                {run.alerts.length > 0 && <s-badge tone="warning">{`${run.alerts.length} alert(s)`}</s-badge>}
              </s-table-cell>
              {PAGES.flatMap((page) =>
                DEVICES.map((device) => {
                  const r = run.results.find((x) => x.page === page && x.device === device);
                  return (
                    <s-table-cell key={`${page}-${device}`}>
                      {run.status === "running" ? "…" : <ScoreBadge result={r} />}
                    </s-table-cell>
                  );
                }),
              )}
            </s-table-row>
          ))}
        </s-table-body>
      </s-table>
    </s-section>
  );
}

const RATING_BANDS: Array<{ rating: Rating; range: string; meaning: string }> = [
  { rating: "GOOD", range: "90–100", meaning: "Fast" },
  { rating: "AVERAGE", range: "50–89", meaning: "Needs improvement" },
  { rating: "POOR", range: "0–49", meaning: "Slow — worth fixing" },
];

/**
 * The Speed Test tab's side panel: which pages are tested, what the ratings
 * mean, and when an alert is raised — laid out as short lists rather than a
 * paragraph, with the same rating colours as the results table.
 */
export function SpeedMeasuredPanel({ pages }: { pages: Record<SpeedPage, string> }) {
  return (
    <s-section slot="aside" heading="What's measured">
      <s-stack direction="block" gap="base">
        <s-text color="subdued">
          Google PageSpeed Insights (pagespeed.web.dev), each page on 📱 mobile and 🖥 desktop.
        </s-text>

        <s-stack direction="block" gap="small-200">
          <s-text type="strong">Pages tested</s-text>
          <s-unordered-list>
            {PAGES.map((page) => (
              <s-list-item key={page}>
                <s-text type="strong">{PAGE_LABEL[page]}</s-text> —{" "}
                <s-text color="subdued">{pages[page]}</s-text>
              </s-list-item>
            ))}
          </s-unordered-list>
        </s-stack>

        <s-stack direction="block" gap="small-200">
          <s-text type="strong">Score ratings</s-text>
          {RATING_BANDS.map((band) => (
            <s-stack key={band.rating} direction="inline" gap="small-200" alignItems="center">
              <s-badge tone={TONE[band.rating]}>{band.rating}</s-badge>
              <s-text>{band.range}</s-text>
              <s-text color="subdued">· {band.meaning}</s-text>
            </s-stack>
          ))}
        </s-stack>

        <s-stack direction="block" gap="small-200">
          <s-text type="strong">⚠️ Alerts are raised when a page</s-text>
          <s-unordered-list>
            <s-list-item>turns POOR, or</s-list-item>
            <s-list-item>drops {ALERT_DROP}+ points since the previous test</s-list-item>
          </s-unordered-list>
        </s-stack>
      </s-stack>
    </s-section>
  );
}
