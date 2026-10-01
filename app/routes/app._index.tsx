import type { LoaderFunctionArgs } from "react-router";
import { Link, useLoaderData } from "react-router";
import { requireAdmin } from "../auth.server";
import { listChecks } from "../atc/store.server";
import { scheduleOf } from "../atc/scheduler.server";
import { describeSchedule, formatEastern } from "../atc/schedule";
import { listStores } from "../atc/stores.server";
import { describeWebBotAuthStatus } from "../atc/web-bot-auth.server";
import { StatusBadge } from "../components/StatusBadge";
import type { RunStatus } from "../atc/types";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await requireAdmin(request);
  const stores = await listStores();
  // The latest check's combined status (desktop + mobile), not just its last run.
  const lastChecks = await Promise.all(stores.map((s) => listChecks(s.id, 1)));
  return {
    stores: stores.map((s, i) => ({
      id: s.id,
      name: s.name,
      url: s.url,
      webBotAuth: describeWebBotAuthStatus(s),
      schedule: s.scheduleEnabled
        ? {
            description: describeSchedule(scheduleOf(s)),
            nextRunAt: s.nextRunAt ? formatEastern(s.nextRunAt) : null,
          }
        : null,
      lastRun: lastChecks[i][0]
        ? {
            status: lastChecks[i][0].status as RunStatus,
            startedAt: lastChecks[i][0].startedAt,
          }
        : null,
    })),
  };
};

export default function Stores() {
  const { stores } = useLoaderData<typeof loader>();

  return (
    <s-page heading="Stores">
      <s-section heading={`Stores (${stores.length})`}>
        <div
          style={{
            display: "flex",
            justifyContent: "flex-end",
            marginBottom: 12,
          }}
        >
          <s-button variant="primary" icon="plus" href="/app/stores/new">
            Add store
          </s-button>
        </div>
        {stores.length === 0 ? (
          <s-paragraph>
            No stores yet — press Add store to set one up.
          </s-paragraph>
        ) : (
          <s-table>
            <s-table-header-row>
              <s-table-header>Store</s-table-header>
              <s-table-header>Web Bot Auth</s-table-header>
              <s-table-header>Schedule</s-table-header>
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
                    {s.schedule ? (
                      <s-stack direction="block" gap="small-500">
                        <s-text>{s.schedule.description}</s-text>
                        {s.schedule.nextRunAt && (
                          <s-text color="subdued">
                            Next: {s.schedule.nextRunAt}
                          </s-text>
                        )}
                      </s-stack>
                    ) : (
                      <s-text color="subdued">Off</s-text>
                    )}
                  </s-table-cell>
                  <s-table-cell>
                    {s.lastRun ? (
                      <s-stack
                        direction="inline"
                        gap="small-200"
                        alignItems="center"
                      >
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
    </s-page>
  );
}
