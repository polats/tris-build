// The box's front door. The Paseo daemon is protected by a password generated on the box; this
// hands that password to whoever proves, with a GitHub sign-in, that they are the box's owner.
// Also exposes GitHub-owner-authenticated /api/angelo/* routes for Tris 3D Studio.
//
//   GET  /health               -> { ok: true }
//   POST /pair                 -> { password, port, workspace }
//   GET  /api/angelo/library   -> { total, catalogTotal, items }
//   POST /api/angelo/run       -> load / retopo / fit hulls / preflight / fracture
//   POST /api/angelo/save      -> copy generated GLB into workspace (e.g. assets/<name>.glb)
//   GET  /generated/<file>.glb -> stream generated GLB preview

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { createServer } from "node:http";
import path from "node:path";
import { GEN_DIR, runAngeloWorker, safeWorkspacePath, searchLibrary } from "./tris-angelo.mjs";

const owner = (process.env.TRIS_BOX_OWNER || process.env.GITHUB_USER || "").toLowerCase();
const password = process.env.PASEO_PASSWORD;
const origins = new Set((process.env.TRIS_ORIGINS || "https://creds.club,https://tris.creds.club").split(","));
const port = Number(process.env.TRIS_PAIR_PORT || 6768);
const workspace = process.env.TRIS_WORKSPACE || process.cwd();

if (!owner || !password) {
  console.error("tris-pair: GITHUB_USER (or TRIS_BOX_OWNER) and PASEO_PASSWORD are required");
  process.exit(1);
}

let checking = 0;
const tokenCache = new Map(); // sha256(token) -> expiresAtMs

async function belongsToOwner(token) {
  const key = createHash("sha256").update(token).digest("hex");
  const cached = tokenCache.get(key);
  if (cached && cached > Date.now()) return true;
  const response = await fetch("https://api.github.com/user", {
    headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "user-agent": "tris-box" },
  });
  if (!response.ok) return false;
  const user = await response.json();
  const ok = typeof user.login === "string" && user.login.toLowerCase() === owner;
  if (ok) tokenCache.set(key, Date.now() + 60_000);
  return ok;
}

async function readJson(request) {
  const chunks = [];
  for await (const c of request) chunks.push(c);
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

function callBoxLlm(provider, fullPrompt, outFile, onEvent) {
  return new Promise((resolve, reject) => {
    const isClaude = provider === "claude";
    const cmd = isClaude ? "claude" : "codex";
    const args = isClaude
      ? ["-p", "--output-format", "text"]
      : ["exec", "--skip-git-repo-check", "--ephemeral", "--json", "-c", "model_reasoning_effort=\"low\"", "-s", "read-only", "-o", outFile, "-"];
    const child = spawn(cmd, args, { env: process.env, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = ""; let stderr = ""; let lineBuf = "";
    const reasoning = [];
    let lastMessage = "";
    child.stdout.on("data", (d) => {
      const chunk = d.toString();
      stdout += chunk;
      if (!isClaude) {
        lineBuf += chunk;
        const lines = lineBuf.split("\n");
        lineBuf = lines.pop() || "";
        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const ev = JSON.parse(line);
            const item = ev.item || {};
            if (ev.type === "item.completed" && item.type === "reasoning" && item.text) {
              reasoning.push(item.text);
              onEvent?.("thinking", { text: item.text });
            } else if (ev.type === "item.updated" && item.type === "reasoning" && item.text) {
              onEvent?.("thinking_delta", { text: item.text });
            } else if (ev.type === "item.completed" && item.type === "agent_message" && item.text) {
              lastMessage = item.text;
            }
          } catch {}
        }
      }
    });
    child.stderr.on("data", (d) => { stderr += d.toString(); });
    child.stdin.write(fullPrompt);
    child.stdin.end();
    child.on("close", (c) => {
      if (c !== 0) return reject(new Error(`${provider} failed (${c}): ${(stderr || stdout).slice(-400)}`));
      const raw = isClaude ? stdout : (fs.existsSync(outFile) ? fs.readFileSync(outFile, "utf8") : lastMessage || stdout);
      const fence = raw.match(/```(?:python|py)?\s*([\s\S]*?)```/i);
      const summaryMatch = raw.match(/^SUMMARY:\s*(.+)$/im);
      const summary = summaryMatch ? summaryMatch[1].trim() : (raw.split("```")[0] || "").trim().slice(0, 260);
      resolve({ code: (fence ? fence[1] : raw).trim(), summary, thinking: reasoning.join("\n\n") });
    });
  });
}

const server = createServer(async (request, response) => {
  const origin = request.headers.origin;
  if (origin && origins.has(origin)) {
    response.setHeader("access-control-allow-origin", origin);
    response.setHeader("access-control-allow-headers", "authorization, content-type, accept");
    response.setHeader("access-control-allow-methods", "GET, POST, OPTIONS");
    response.setHeader("vary", "origin");
  }
  const send = (status, body) => {
    response.statusCode = status;
    response.setHeader("content-type", "application/json");
    response.setHeader("cache-control", "no-store");
    response.end(JSON.stringify(body));
  };
  const url = new URL(request.url, "http://box");
  const pathname = url.pathname;

  if (request.method === "OPTIONS") return send(204, {});
  if (request.method === "GET" && pathname === "/health") return send(200, { ok: true });

  // Serve generated preview GLBs (random timestamped names, no-store)
  if (request.method === "GET" && pathname.startsWith("/generated/")) {
    const name = path.basename(pathname);
    const full = path.join(GEN_DIR, name);
    if (!name.endsWith(".glb") || !fs.existsSync(full)) return send(404, { error: "not found" });
    response.statusCode = 200;
    response.setHeader("content-type", "model/gltf-binary");
    response.setHeader("cache-control", "no-store");
    fs.createReadStream(full).pipe(response);
    return;
  }

  // Public CC0 catalog search (read-only)
  if (request.method === "GET" && pathname === "/api/angelo/library") {
    try {
      const data = await searchLibrary({
        q: url.searchParams.get("q") || "",
        category: url.searchParams.get("category") || "all",
        source: url.searchParams.get("source") || "all",
        limit: url.searchParams.get("limit") || 36,
        offset: url.searchParams.get("offset") || 0,
      });
      return send(200, data);
    } catch (err) {
      return send(500, { ok: false, error: err.message });
    }
  }

  // All mutating / private routes require owner's GitHub Bearer token
  const header = request.headers.authorization || "";
  if (!header.startsWith("Bearer ")) return send(401, { error: "sign in with GitHub first" });
  if (checking >= 4) return send(429, { error: "busy, try again" });
  checking += 1;
  let authed = false;
  try {
    authed = await belongsToOwner(header.slice(7));
  } catch {
    return send(502, { error: "could not reach GitHub to check the sign-in" });
  } finally {
    checking -= 1;
  }
  if (!authed) {
    await new Promise((done) => setTimeout(done, 1000));
    return send(403, { error: "this box belongs to someone else" });
  }

  if (request.method === "POST" && pathname === "/pair") {
    return send(200, { password, port: Number(process.env.TRIS_DAEMON_PORT || 6767), workspace });
  }

  if (request.method === "POST" && pathname === "/api/angelo/run") {
    try {
      const body = await readJson(request);
      fs.mkdirSync(GEN_DIR, { recursive: true });
      const stamp = Date.now();
      const liveFile = `asset_${stamp}_live.glb`;
      const godotFile = `asset_${stamp}_godot.glb`;
      const omiFile = `asset_${stamp}_omi.glb`;
      const shardsFile = `asset_${stamp}_shards.glb`;
      const blendFile = `scene_${stamp}.blend`;
      let inputGlb = null;
      if (body.uploadBase64) {
        inputGlb = path.join(GEN_DIR, `upload_${stamp}.glb`);
        fs.writeFileSync(inputGlb, Buffer.from(body.uploadBase64, "base64"));
      }
      const parsed = await runAngeloWorker({
        mode: body.mode || "load",
        editKind: body.editKind || "",
        editArg: body.editArg || "",
        title: body.title || "",
        source: body.source || "",
        assetId: body.assetId || null,
        prompt: body.prompt || "",
        target: body.target || "godot",
        retopo: Boolean(body.retopo),
        fitColliders: body.fitColliders !== false,
        blendIn: body.blendFile ? path.join(GEN_DIR, path.basename(body.blendFile)) : null,
        blendOut: path.join(GEN_DIR, blendFile),
        outLive: path.join(GEN_DIR, liveFile),
        outGodot: path.join(GEN_DIR, godotFile),
        outOmi: path.join(GEN_DIR, omiFile),
        outShards: path.join(GEN_DIR, shardsFile),
        inputGlb,
        uploadName: body.uploadName || null,
      });
      return send(200, {
        ...parsed,
        liveUrl: `/generated/${liveFile}`,
        godotUrl: `/generated/${godotFile}`,
        omiUrl: `/generated/${omiFile}`,
        shardsUrl: parsed.shardCount ? `/generated/${shardsFile}` : null,
        blendFile,
      });
    } catch (err) {
      return send(500, { ok: false, error: err.message });
    }
  }

  if (request.method === "POST" && pathname === "/api/angelo/ai-edit") {
    const wantStream = (request.headers.accept || "").includes("text/event-stream");
    const sendSse = (event, data) => {
      if (!wantStream) return;
      response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };
    if (wantStream) {
      response.setHeader("content-type", "text/event-stream");
      response.setHeader("cache-control", "no-cache");
      response.setHeader("connection", "keep-alive");
    }
    try {
      const body = await readJson(request);
      const provider = body.provider === "claude" ? "claude" : "codex";
      const userPrompt = String(body.prompt || "").trim();
      if (!userPrompt) throw new Error("Prompt is empty");
      if (!body.blendFile) throw new Error("Load a model from the library first");
      fs.mkdirSync(GEN_DIR, { recursive: true });
      const stamp = Date.now();
      const blendIn = path.join(GEN_DIR, path.basename(body.blendFile));
      sendSse("status", { text: "Inspecting live .blend scene in headless Angelo…" });
      const sceneFacts = await runAngeloWorker({ mode: "inspect", blendIn, outLive: path.join(GEN_DIR, "unused.glb") });
      const systemInstructions = [
        "You are Angelo, a Blender 5.3 Python 3D artist & technical animator.",
        "Start with one short plain-English line: SUMMARY: <what you changed in 1 sentence>.",
        "Then output a single python code block that edits the currently open Blender 5.3 scene.",
        "Already in scope: bpy, bmesh, math, random, hero (the main mesh object named HeroProp).",
        "Rules:",
        "- Blender 5.3: Principled BSDF materials already have nodes enabled; never set mat.use_nodes = True.",
        "- CRITICAL for material/color changes: if a Principled BSDF input is already linked to an Image Texture, unlink it first or assign a new material.",
        "- For geometry/kitbash additions, you may add new meshes, parent them to hero or join them into hero, and keep the asset grounded at Z >= 0.",
        "- For rigging/animation requests, ONLY call obj.keyframe_insert(data_path=..., frame=f) or pose_bone.keyframe_insert(...) at frames 1, 16, 31, 46, 61 (frame 1 == frame 61, fps=30). NEVER read or write action.fcurves, action.slots, or channelbag.",
        "- Do NOT save or export files; the host handles saving, collision fitting, preflight, and glTF export.",
        "Current scene facts: " + JSON.stringify(sceneFacts),
        "User request: " + userPrompt,
      ].join("\n");
      const scriptFile = path.join(GEN_DIR, `ai_${stamp}.py`);
      const rawOutFile = path.join(GEN_DIR, `ai_${stamp}_raw.txt`);
      sendSse("status", { text: `Asking ${provider.toUpperCase()} to plan the 3D edit…` });
      let llmRes = await callBoxLlm(provider, systemInstructions, rawOutFile, sendSse);
      fs.writeFileSync(scriptFile, llmRes.code);
      sendSse("plan", { summary: llmRes.summary, code: llmRes.code, thinking: llmRes.thinking });
      const liveFile = `asset_${stamp}_live.glb`;
      const godotFile = `asset_${stamp}_godot.glb`;
      const omiFile = `asset_${stamp}_omi.glb`;
      const blendFile = `scene_${stamp}.blend`;
      const workerPayload = {
        mode: "edit", editKind: "ai_script", prompt: userPrompt, scriptPath: scriptFile,
        title: body.title || "Hero Asset", source: body.source || "Angelo Library",
        target: body.target || "godot", fitColliders: body.fitColliders !== false,
        blendIn, blendOut: path.join(GEN_DIR, blendFile),
        outLive: path.join(GEN_DIR, liveFile), outGodot: path.join(GEN_DIR, godotFile), outOmi: path.join(GEN_DIR, omiFile),
      };
      sendSse("status", { text: "Running script in headless Angelo + fitting colliders & preflight…" });
      let parsed;
      try {
        parsed = await runAngeloWorker(workerPayload);
      } catch (firstErr) {
        sendSse("status", { text: "Script hit a Blender error — asking AI to self-heal…" });
        llmRes = await callBoxLlm(provider, systemInstructions + "\n\nPrevious error:\n" + firstErr.message + "\nReturn SUMMARY + corrected Python code.", rawOutFile, sendSse);
        fs.writeFileSync(scriptFile, llmRes.code);
        sendSse("plan", { summary: llmRes.summary, code: llmRes.code, thinking: llmRes.thinking });
        parsed = await runAngeloWorker(workerPayload);
      }
      const finalData = {
        ...parsed, provider,
        aiSummary: llmRes.summary, aiThinking: llmRes.thinking, aiCode: llmRes.code,
        liveUrl: `/generated/${liveFile}`, godotUrl: `/generated/${godotFile}`, omiUrl: `/generated/${omiFile}`, blendFile,
      };
      if (wantStream) { sendSse("done", finalData); response.end(); return; }
      return send(200, finalData);
    } catch (err) {
      if (wantStream) { sendSse("error", { ok: false, error: err.message }); response.end(); return; }
      return send(500, { ok: false, error: err.message });
    }
  }

  if (request.method === "POST" && pathname === "/api/angelo/save") {
    try {
      const body = await readJson(request);
      const srcName = path.basename(String(body.file || ""));
      const srcAbs = path.join(GEN_DIR, srcName);
      if (!srcName.endsWith(".glb") || !fs.existsSync(srcAbs)) {
        return send(400, { ok: false, error: "Generated .glb file not found" });
      }
      const destAbs = safeWorkspacePath(workspace, body.dest || `assets/${srcName}`);
      fs.mkdirSync(path.dirname(destAbs), { recursive: true });
      fs.copyFileSync(srcAbs, destAbs);
      return send(200, { ok: true, saved: path.relative(workspace, destAbs) });
    } catch (err) {
      return send(400, { ok: false, error: err.message });
    }
  }

  return send(404, { error: "not found" });
});

server.listen(port, "0.0.0.0", () => console.log(`tris-pair: listening on ${port} for ${owner}`));
