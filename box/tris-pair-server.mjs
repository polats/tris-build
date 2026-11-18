// The box's front door. The Paseo daemon is protected by a password generated on the box; this
// hands that password to whoever proves, with a GitHub sign-in, that they are the box's owner.
// GitHub is the identity, as in freeagent: no secret has to travel from the dashboard to the box,
// and a second device needs nothing but the same sign-in.
//
//   GET  /health   -> { ok: true }
//   POST /pair     Authorization: Bearer <GitHub user token>
//                  -> { password, port, workspace } when the token belongs to the owner
//
// Environment: GITHUB_USER (set by Codespaces) or TRIS_BOX_OWNER, PASEO_PASSWORD,
// TRIS_ORIGINS (comma-separated pages allowed to call this), TRIS_PAIR_PORT, TRIS_WORKSPACE.

import { createServer } from "node:http";

const owner = (process.env.TRIS_BOX_OWNER || process.env.GITHUB_USER || "").toLowerCase();
const password = process.env.PASEO_PASSWORD;
const origins = new Set((process.env.TRIS_ORIGINS || "https://creds.club,https://tris.creds.club").split(","));
const port = Number(process.env.TRIS_PAIR_PORT || 6768);

if (!owner || !password) {
  console.error("tris-pair: GITHUB_USER (or TRIS_BOX_OWNER) and PASEO_PASSWORD are required");
  process.exit(1);
}

// A wrong token costs the caller a second, and only a few can be in flight: guessing is pointless
// anyway (the token has to be a real one for the owner's account), this just keeps it cheap.
let checking = 0;

async function belongsToOwner(token) {
  const response = await fetch("https://api.github.com/user", {
    headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "user-agent": "tris-box" },
  });
  if (!response.ok) return false;
  const user = await response.json();
  return typeof user.login === "string" && user.login.toLowerCase() === owner;
}

const server = createServer(async (request, response) => {
  const origin = request.headers.origin;
  if (origin && origins.has(origin)) {
    response.setHeader("access-control-allow-origin", origin);
    response.setHeader("access-control-allow-headers", "authorization, content-type");
    response.setHeader("access-control-allow-methods", "GET, POST, OPTIONS");
    response.setHeader("vary", "origin");
  }
  const send = (status, body) => {
    response.statusCode = status;
    response.setHeader("content-type", "application/json");
    response.setHeader("cache-control", "no-store");
    response.end(JSON.stringify(body));
  };
  const path = new URL(request.url, "http://box").pathname;

  if (request.method === "OPTIONS") return send(204, {});
  if (request.method === "GET" && path === "/health") return send(200, { ok: true });
  if (request.method !== "POST" || path !== "/pair") return send(404, { error: "not found" });

  const header = request.headers.authorization || "";
  if (!header.startsWith("Bearer ")) return send(401, { error: "sign in with GitHub first" });
  if (checking >= 4) return send(429, { error: "busy, try again" });
  checking += 1;
  try {
    if (await belongsToOwner(header.slice(7))) {
      return send(200, { password, port: Number(process.env.TRIS_DAEMON_PORT || 6767), workspace: process.env.TRIS_WORKSPACE || process.cwd() });
    }
    await new Promise((done) => setTimeout(done, 1000));
    return send(403, { error: "this box belongs to someone else" });
  } catch {
    return send(502, { error: "could not reach GitHub to check the sign-in" });
  } finally {
    checking -= 1;
  }
});

server.listen(port, "0.0.0.0", () => console.log(`tris-pair: listening on ${port} for ${owner}`));
