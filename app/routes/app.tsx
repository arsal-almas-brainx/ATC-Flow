import type { LoaderFunctionArgs } from "react-router";
import { Form, Link, Outlet } from "react-router";
import { requireAdmin } from "../auth.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await requireAdmin(request);
  return null;
};

export default function AppLayout() {
  return (
    <>
      <header
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 16,
          padding: "10px 16px",
          background: "#1a1a1a",
          color: "#fff",
          fontFamily: "Inter, -apple-system, BlinkMacSystemFont, sans-serif",
          fontSize: 14,
        }}
      >
        <Link to="/app" style={{ color: "#fff", textDecoration: "none", fontWeight: 600 }}>
          ATC Flow · Super admin
        </Link>
        <div style={{ display: "flex", alignItems: "center", gap: 20 }}>
          <Link to="/app/settings" style={{ color: "#fff", textDecoration: "none" }}>
            Settings
          </Link>
          <Form method="post" action="/logout">
            <button
              type="submit"
              style={{ background: "none", border: 0, color: "#fff", font: "inherit", cursor: "pointer" }}
            >
              Sign out
            </button>
          </Form>
        </div>
      </header>
      <Outlet />
    </>
  );
}
