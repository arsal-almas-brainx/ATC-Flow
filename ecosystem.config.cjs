// pm2 config for the staging server (see README "Deploy to the staging server").
// Settings and secrets come from .env next to this file, which is created on
// the server and never committed. After editing .env:
//   pm2 startOrReload ecosystem.config.cjs --update-env
const fs = require("node:fs");
const path = require("node:path");
const { parseEnv } = require("node:util");

const env = parseEnv(fs.readFileSync(path.join(__dirname, ".env"), "utf8"));

module.exports = {
  apps: [
    {
      name: "atc-flow",
      cwd: __dirname,
      // Applies pending database migrations, then starts the app.
      script: "npm",
      args: "run docker-start",
      env: { NODE_ENV: "production", ...env },
      max_memory_restart: "1G",
    },
  ],
};
