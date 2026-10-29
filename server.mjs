// Production server: react-router-serve's setup plus "trust proxy", so the
// app sees the original https:// URL when it runs behind nginx. Without it,
// React Router's cross-site check rejects every form post (e.g. login) because
// the browser's Origin is https:// while the forwarded request is http://.
// Proxy headers are trusted from this machine only (nginx on the same server).
import path from "node:path";
import compression from "compression";
import express from "express";
import { createRequestHandler } from "@react-router/express";

const build = await import(path.resolve("build/server/index.js"));
const port = Number(process.env.PORT) || 3000;
const host = process.env.HOST || "0.0.0.0";

const app = express();
app.disable("x-powered-by");
app.set("trust proxy", "loopback");
app.use(compression());
app.use("/assets", express.static("build/client/assets", { immutable: true, maxAge: "1y" }));
app.use(express.static("build/client"));
app.use(express.static("public", { maxAge: "1h" }));
app.all("*", createRequestHandler({ build, mode: process.env.NODE_ENV }));

app.listen(port, host, () => console.log(`[server] http://${host}:${port}`));
