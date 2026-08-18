/**
 * Installs the app as a pair of always-on background services on this Mac, so
 * it keeps serving Shopify Admin with no terminal open and restarts on boot:
 *
 *   com.atcflow.server  — the built app on PORT (default 3000)
 *   com.atcflow.ngrok   — ngrok, exposing that port on your static domain
 *
 * Usage:
 *   npm run service:install -- your-domain.ngrok-free.app
 *
 * Re-run it any time to pick up a rebuild or a changed domain. To remove:
 *   npm run service:uninstall
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const AGENTS = path.join(homedir(), "Library", "LaunchAgents");
const LOGS = path.join(ROOT, ".logs");
const NODE = process.execPath;
const SERVE = path.join(ROOT, "node_modules", "@react-router", "serve", "bin.js");
const PORT = process.env.PORT || "3000";

const LABELS = { server: "com.atcflow.server", ngrok: "com.atcflow.ngrok" };
const uninstall = process.argv.includes("--uninstall");

const run = (cmd, args, opts = {}) =>
  execFileSync(cmd, args, { cwd: ROOT, encoding: "utf8", ...opts });

const plistPath = (label) => path.join(AGENTS, `${label}.plist`);

function unload(label) {
  const file = plistPath(label);
  if (!existsSync(file)) return;
  try {
    run("launchctl", ["bootout", `gui/${process.getuid()}/${label}`], {
      stdio: "ignore",
    });
  } catch {
    // Not loaded — fine.
  }
}

// ---------------------------------------------------------------- uninstall
if (uninstall) {
  for (const label of Object.values(LABELS)) {
    unload(label);
    const file = plistPath(label);
    if (existsSync(file)) {
      run("rm", ["-f", file]);
      console.log(`removed ${file}`);
    }
  }
  console.log("\nServices removed. The app no longer runs in the background.");
  process.exit(0);
}

// ---------------------------------------------------------------- validate
const domain = process.argv.slice(2).find((a) => !a.startsWith("-"));
if (!domain) {
  console.error(
    "Missing your ngrok domain.\n\n" +
      "  1. Go to https://dashboard.ngrok.com/domains and click 'Create domain'\n" +
      "     (the free plan includes one, e.g. tidy-otter-1234.ngrok-free.app)\n" +
      "  2. Re-run:  npm run service:install -- tidy-otter-1234.ngrok-free.app\n",
  );
  process.exit(2);
}
if (/^https?:\/\//.test(domain)) {
  console.error(`Pass the bare hostname, without https:// — e.g. ${domain.replace(/^https?:\/\//, "")}`);
  process.exit(2);
}

const appUrl = `https://${domain}`;

// -------------------------------------------- free the port before building
// Unload our own services first so re-running this script is safe, then make
// sure nothing else (typically a `npm run dev` session) is holding the port.
for (const label of Object.values(LABELS)) unload(label);

const portHolders = (() => {
  try {
    return run("lsof", ["-nP", `-iTCP:${PORT}`, "-sTCP:LISTEN", "-t"])
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean);
  } catch {
    return []; // lsof exits non-zero when nothing is listening.
  }
})();

if (portHolders.length) {
  let who = "";
  try {
    who = run("ps", ["-o", "command=", "-p", portHolders.join(",")]).trim();
  } catch {
    who = portHolders.join(", ");
  }
  console.error(
    `\nPort ${PORT} is already in use, so the service cannot start:\n\n${who}\n\n` +
      "Stop it first — if that is 'shopify app dev', press Ctrl+C in its terminal —\n" +
      "then re-run this command.\n",
  );
  process.exit(1);
}

// A hand-started ngrok would fight the launch agent over the same domain.
try {
  const tunnels = run("curl", ["-s", "--max-time", "2", "http://127.0.0.1:4040/api/tunnels"]);
  if (tunnels.includes("public_url")) {
    console.error(
      "\nAn ngrok process is already running (its dashboard is on :4040).\n" +
        "Stop it first (Ctrl+C in its terminal) so the launch agent can own the domain,\n" +
        "then re-run this command.\n",
    );
    process.exit(1);
  }
} catch {
  // No ngrok running — good.
}

// ------------------------------------------------- Shopify credentials
console.log("Reading Shopify credentials…");
let env = {};
try {
  const shown = run("npm", ["run", "--silent", "env", "--", "show"]);
  for (const line of shown.split("\n")) {
    const m = line.trim().match(/^([A-Z_]+)=(.*)$/);
    if (m) env[m[1]] = m[2];
  }
} catch (err) {
  console.error(`Could not run 'shopify app env show': ${err.message}`);
  process.exit(1);
}

if (!env.SHOPIFY_API_KEY || !env.SHOPIFY_API_SECRET) {
  console.error(
    "Shopify credentials not found. Run 'npm run config:link' first, then retry.",
  );
  process.exit(1);
}

// SCOPES must match shopify.app.toml or the app will loop on re-authorisation.
env.SCOPES = env.SCOPES || "read_products";
env.SHOPIFY_APP_URL = appUrl;
env.PORT = PORT;
env.NODE_ENV = "production";
env.DATABASE_URL = process.env.DATABASE_URL || "file:dev.sqlite";

const envFile = path.join(ROOT, ".env.production");
writeFileSync(
  envFile,
  "# Generated by scripts/setup-service.mjs — contains secrets, never commit.\n" +
    Object.entries(env)
      .map(([k, v]) => `${k}=${v}`)
      .join("\n") +
    "\n",
  { mode: 0o600 },
);
console.log(`Wrote ${path.relative(ROOT, envFile)} (chmod 600)`);

// ------------------------------------------------- point Shopify at ngrok
const tomlPath = path.join(ROOT, "shopify.app.toml");
let toml = readFileSync(tomlPath, "utf8");
const before = toml;

toml = toml.replace(/^application_url = .*$/m, `application_url = "${appUrl}"`);
toml = toml.replace(
  /^\s*redirect_urls = \[[^\]]*\]/m,
  `redirect_urls = [ "${appUrl}/auth/callback" ]`,
);
// Otherwise `npm run dev` silently repoints the app at a temporary tunnel.
toml = toml.replace(
  /^automatically_update_urls_on_dev = .*$/m,
  "automatically_update_urls_on_dev = false",
);

if (toml !== before) {
  writeFileSync(tomlPath, toml);
  console.log("Updated shopify.app.toml → application_url, redirect_urls");
}

// ------------------------------------------------- build
console.log("Building the app…");
run("npm", ["run", "build"], { stdio: "inherit" });

// ------------------------------------------------- write launch agents
mkdirSync(AGENTS, { recursive: true });
mkdirSync(LOGS, { recursive: true });

const xmlEscape = (s) =>
  String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function plist({ label, args, environment = {} }) {
  const argXml = args.map((a) => `    <string>${xmlEscape(a)}</string>`).join("\n");
  const envXml = Object.entries(environment)
    .map(
      ([k, v]) =>
        `    <key>${xmlEscape(k)}</key>\n    <string>${xmlEscape(v)}</string>`,
    )
    .join("\n");

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${label}</string>
  <key>ProgramArguments</key>
  <array>
${argXml}
  </array>
  <key>WorkingDirectory</key>
  <string>${xmlEscape(ROOT)}</string>
  <key>EnvironmentVariables</key>
  <dict>
${envXml}
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${xmlEscape(path.join(LOGS, `${label}.out.log`))}</string>
  <key>StandardErrorPath</key>
  <string>${xmlEscape(path.join(LOGS, `${label}.err.log`))}</string>
</dict>
</plist>
`;
}

// launchd starts services with a bare PATH, so every binary is absolute and
// PATH is set explicitly for anything the app shells out to.
const basePath = `${path.dirname(NODE)}:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin`;

const serverPlist = plist({
  label: LABELS.server,
  args: [NODE, SERVE, path.join(ROOT, "build", "server", "index.js")],
  environment: { ...env, PATH: basePath, HOME: homedir() },
});

const ngrokPath = (() => {
  try {
    return run("which", ["ngrok"]).trim();
  } catch {
    return "/opt/homebrew/bin/ngrok";
  }
})();

const ngrokPlist = plist({
  label: LABELS.ngrok,
  args: [ngrokPath, "http", PORT, `--domain=${domain}`, "--log=stdout"],
  environment: { PATH: basePath, HOME: homedir() },
});

writeFileSync(plistPath(LABELS.server), serverPlist);
writeFileSync(plistPath(LABELS.ngrok), ngrokPlist);
console.log(`Wrote launch agents to ${AGENTS}`);

// ------------------------------------------------- load
for (const label of Object.values(LABELS)) {
  run("launchctl", ["bootstrap", `gui/${process.getuid()}`, plistPath(label)]);
  console.log(`loaded ${label}`);
}

console.log(`
Done. Both services are running and will restart on boot.

  App URL:  ${appUrl}
  Logs:     .logs/com.atcflow.server.err.log
            .logs/com.atcflow.ngrok.err.log

Next, push the new URL to Shopify and install on the store:

  1. npm run deploy
  2. Dev dashboard -> your app -> Distribution -> Custom distribution
     -> enter the store's .myshopify.com domain -> open the install link

To stop and remove the services:  npm run service:uninstall
`);
