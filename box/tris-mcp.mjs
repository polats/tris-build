#!/usr/bin/env node
// tris-mcp: zero-dependency stdio MCP server exposing `tris_godot_shot` to coding agents
// (Claude Code, Codex, Cursor, OpenCode) both inside `tris-box` and locally.

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
import { GEN_DIR, runAngeloWorker, safeWorkspacePath, searchLibrary } from "./tris-angelo.mjs";
const SERVER_INFO = { name: "tris-mcp", version: "0.2.0" };

const TOOLS = [
  {
    name: "tris_godot_shot",
    description:
      "Render a Godot 4.3+ scene and return the captured PNG image plus structured diagnostics " +
      "(errors, warnings, renderer, frame time). Works on CPU-only Codespaces (xvfb + Mesa " +
      "llvmpipe/lavapipe) and local GPUs with zero changes to game code.",
    inputSchema: {
      type: "object",
      properties: {
        project: {
          type: "string",
          description: "Path to the Godot project directory containing project.godot (default: workspace cwd).",
        },
        scene: {
          type: "string",
          description: "Godot scene path such as res://main.tscn (default: application/run/main_scene).",
        },
        size: {
          type: "string",
          description: "Viewport resolution WxH (default: 1280x720).",
        },
        frames: {
          type: "integer",
          minimum: 1,
          maximum: 600,
          description: "Number of frames to step before capturing (default: 12).",
        },
        wait: {
          type: "number",
          minimum: 0,
          maximum: 30,
          description: "Minimum elapsed seconds before capturing (default: 0).",
        },
        strip: {
          type: "integer",
          minimum: 1,
          maximum: 8,
          description: "Capture N frames into a horizontal contact sheet strip (default: 1).",
        },
        interval_frames: {
          type: "integer",
          minimum: 1,
          maximum: 240,
          description: "Frames between captures when strip > 1 (default: 8).",
        },
        input: {
          type: "string",
          description: "Optional scripted input sequence: action:start_sec:dur_sec,...",
        },
        renderer: {
          type: "string",
          enum: ["auto", "gl_compatibility", "mobile", "forward_plus"],
          description: "Override Godot rendering method (default: auto from project.godot).",
        },
        backend: {
          type: "string",
          enum: ["auto", "native", "xvfb-gl", "xvfb-vk"],
          description: "Rendering backend (default: auto).",
        },
        timeout: {
          type: "integer",
          minimum: 10,
          maximum: 300,
          description: "Hard timeout in seconds (default: 120).",
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "tris_angelo_library_search",
    description: "Search Angelo 6,437-model CC0 3D Library (Quaternius, Poly Haven, OpenGameArt, Smithsonian, ToonLab Rocks) by keyword, category, and source.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search keywords (e.g. stone arch, treasure chest, sword)." },
        category: { type: "string", description: "Optional category: architecture, props, nature, characters, furniture, tools, vehicles, food, history, science." },
        source: { type: "string", description: "Optional source: quaternius, polyhaven, toonlab-rock, opensource3d, opengameart, smithsonian, met." },
        limit: { type: "integer", minimum: 1, maximum: 40, description: "Max results (default: 10)." },
      },
    },
  },
  {
    name: "tris_angelo_prepare_asset",
    description: "Import a 3D model from Angelo Library (by asset_id or query) or a local .glb, optionally run native C++ Retopology, fit convex collision hulls (DECOMPOSE or CONVEX), run Engine-Contract Preflight, and write a game-ready .glb (Godot -colonly or Three.js OMI_physics) into the workspace.",
    inputSchema: {
      type: "object",
      properties: {
        asset_id: { type: "string", description: "Exact Angelo Library asset id from tris_angelo_library_search." },
        query: { type: "string", description: "Library search query if asset_id is omitted." },
        input_glb: { type: "string", description: "Path to an existing local .glb file to optimize instead of downloading from Library." },
        dest: { type: "string", description: "Workspace-relative output path (e.g. assets/arch.glb or res://assets/arch.glb)." },
        target: { type: "string", enum: ["godot", "threejs"], description: "Target physics format: godot (-colonly) or threejs (OMI_physics). Default: godot." },
        retopo_faces: { type: "integer", minimum: 200, maximum: 10000, description: "Optional target quad count for native Angelo C++ Retopology." },
        collider_mode: { type: "string", enum: ["decompose", "convex", "none"], description: "Collision hull mode (default: decompose)." },
      },
      required: ["dest"],
    },
  },
  {
    name: "tris_angelo_fracture_asset",
    description: "Fracture a 3D model into material-aware Voronoi rigid shards (stone, wood, or crystal) with interior cut caps, center-of-mass origins, and Angelo RIGID physics (Godot -rigid or Three.js OMI_physics).",
    inputSchema: {
      type: "object",
      properties: {
        input_glb: { type: "string", description: "Workspace-relative path to the source .glb to fracture." },
        asset_id: { type: "string", description: "Or an Angelo Library asset id to fetch and fracture." },
        preset: { type: "string", enum: ["stone", "wood", "crystal"], description: "Fracture pattern & material density preset (default: stone)." },
        dest: { type: "string", description: "Workspace-relative output .glb path for the fractured rigid shards." },
        target: { type: "string", enum: ["godot", "threejs"], description: "Target physics format (default: godot)." },
      },
      required: ["dest"],
    },
  },
  {
    name: "tris_angelo_edit_asset",
    description: "Run a Blender 5.3 / Angelo Python script against an existing .glb (for recoloring, kitbashing, rigging, or keyframe animation), re-fit convex collision hulls, run Engine Preflight, and write the updated .glb back to the workspace.",
    inputSchema: {
      type: "object",
      properties: {
        input_glb: { type: "string", description: "Workspace-relative path to the .glb to edit." },
        python_code: { type: "string", description: "Blender 5.3 Python code editing hero (HeroProp) in the scene." },
        dest: { type: "string", description: "Workspace-relative output .glb path (may overwrite input_glb)." },
        target: { type: "string", enum: ["godot", "threejs"], description: "Target physics format (default: godot)." },
      },
      required: ["input_glb", "python_code", "dest"],
    },
  }
];

function findShotBin() {
  const candidates = [
    path.join(__dirname, "tris-shot.mjs"),
    path.join(__dirname, "tris-shot"),
    "/usr/local/bin/tris-shot",
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return "tris-shot";
}

function runShot(args) {
  return new Promise((resolve) => {
    const bin = findShotBin();
    const isJs = bin.endsWith(".mjs");
    const cmd = isJs ? process.execPath : bin;
    const cmdArgs = isJs ? [bin, ...args] : args;

    const child = spawn(cmd, cmdArgs, {
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
    });

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk.toString("utf8"); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
    child.on("error", (err) => {
      resolve({ ok: false, error: err.message, stdout, stderr, code: -1 });
    });
    child.on("close", (code) => {
      let parsed = null;
      try {
        parsed = JSON.parse(stdout.trim());
      } catch {
        parsed = null;
      }
      resolve({ ok: code === 0 && Boolean(parsed?.ok), parsed, stdout, stderr, code });
    });
  });
}

async function handleGodotShot(params = {}) {
  const project = params.project || process.env.TRIS_WORKSPACE || process.cwd();
  const cliArgs = ["--project", String(project)];
  if (params.scene) cliArgs.push("--scene", String(params.scene));
  if (params.size) cliArgs.push("--size", String(params.size));
  if (params.frames != null) cliArgs.push("--frames", String(params.frames));
  if (params.wait != null) cliArgs.push("--wait", String(params.wait));
  if (params.strip != null) cliArgs.push("--strip", String(params.strip));
  if (params.interval_frames != null) cliArgs.push("--interval-frames", String(params.interval_frames));
  if (params.input) cliArgs.push("--input", String(params.input));
  if (params.renderer) cliArgs.push("--renderer", String(params.renderer));
  if (params.backend) cliArgs.push("--backend", String(params.backend));
  if (params.timeout != null) cliArgs.push("--timeout", String(params.timeout));

  const res = await runShot(cliArgs);
  const content = [];

  const resultObj = res.parsed || {
    ok: false,
    exit_code: res.code,
    error: res.error || res.stderr.trim() || res.stdout.trim() || "tris-shot failed",
  };

  if (resultObj.image_path && fs.existsSync(resultObj.image_path)) {
    const stat = fs.statSync(resultObj.image_path);
    if (stat.size > 0) {
      const data = fs.readFileSync(resultObj.image_path).toString("base64");
      content.push({ type: "image", data, mimeType: "image/png" });
    }
  }

  content.push({ type: "text", text: JSON.stringify(resultObj, null, 2) });
  return { content, isError: !resultObj.ok };
}

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + "\n");
}


async function handleAngeloTool(name, args) {
  const workspace = process.env.TRIS_WORKSPACE || process.cwd();
  if (name === "tris_angelo_library_search") {
    const res = await searchLibrary({
      q: args.query || "",
      category: args.category || "all",
      source: args.source || "all",
      limit: args.limit || 10,
    });
    return { content: [{ type: "text", text: JSON.stringify(res, null, 2) }] };
  }

  fs.mkdirSync(GEN_DIR, { recursive: true });
  const stamp = Date.now();
  const target = args.target === "threejs" ? "threejs" : "godot";
  const destAbs = safeWorkspacePath(workspace, args.dest);
  fs.mkdirSync(path.dirname(destAbs), { recursive: true });

  const outLive = path.join(GEN_DIR, `mcp_${stamp}_live.glb`);
  const outGodot = target === "godot" ? destAbs : path.join(GEN_DIR, `mcp_${stamp}_godot.glb`);
  const outOmi = target === "threejs" ? destAbs : path.join(GEN_DIR, `mcp_${stamp}_omi.glb`);
  const blendMid = path.join(GEN_DIR, `mcp_${stamp}.blend`);

  if (name === "tris_angelo_prepare_asset") {
    const inputAbs = args.input_glb ? safeWorkspacePath(workspace, args.input_glb) : null;
    const loaded = await runAngeloWorker({
      mode: "load",
      assetId: args.asset_id || null,
      prompt: args.query || "",
      inputGlb: inputAbs,
      target,
      fitColliders: args.collider_mode !== "none",
      blendOut: blendMid,
      outLive,
      outGodot,
      outOmi,
    });
    let finalRes = loaded;
    if (args.retopo_faces) {
      finalRes = await runAngeloWorker({
        mode: "edit",
        editKind: "retopology",
        editArg: String(args.retopo_faces),
        title: loaded.title,
        source: loaded.source,
        blendIn: blendMid,
        blendOut: blendMid,
        target,
        fitColliders: args.collider_mode !== "none",
        outLive,
        outGodot,
        outOmi,
      });
    } else if (args.collider_mode === "convex") {
      finalRes = await runAngeloWorker({
        mode: "edit",
        editKind: "fit_convex",
        editArg: "1",
        title: loaded.title,
        source: loaded.source,
        blendIn: blendMid,
        blendOut: blendMid,
        target,
        fitColliders: true,
        outLive,
        outGodot,
        outOmi,
      });
    }
    return { content: [{ type: "text", text: JSON.stringify({ ...finalRes, written: args.dest }, null, 2) }] };
  }

  if (name === "tris_angelo_fracture_asset") {
    const inputAbs = args.input_glb ? safeWorkspacePath(workspace, args.input_glb) : null;
    const loaded = await runAngeloWorker({
      mode: "load",
      assetId: args.asset_id || null,
      inputGlb: inputAbs,
      target,
      fitColliders: false,
      blendOut: blendMid,
      outLive,
    });
    const outShards = path.join(GEN_DIR, `mcp_${stamp}_shards.glb`);
    const fractured = await runAngeloWorker({
      mode: "edit",
      editKind: "fracture",
      editArg: args.preset || "stone",
      title: loaded.title,
      source: loaded.source,
      blendIn: blendMid,
      blendOut: blendMid,
      target,
      fitColliders: false,
      outLive,
      outGodot,
      outOmi,
      outShards,
    });
    return { content: [{ type: "text", text: JSON.stringify({ ...fractured, written: args.dest }, null, 2) }] };
  }

  if (name === "tris_angelo_edit_asset") {
    const inputAbs = safeWorkspacePath(workspace, args.input_glb);
    const loaded = await runAngeloWorker({
      mode: "load",
      inputGlb: inputAbs,
      target,
      fitColliders: false,
      blendOut: blendMid,
      outLive,
    });
    const scriptPath = path.join(GEN_DIR, `mcp_${stamp}.py`);
    fs.writeFileSync(scriptPath, String(args.python_code || ""));
    const edited = await runAngeloWorker({
      mode: "edit",
      editKind: "ai_script",
      prompt: "MCP edit",
      scriptPath,
      title: loaded.title,
      source: loaded.source,
      blendIn: blendMid,
      blendOut: blendMid,
      target,
      fitColliders: true,
      outLive,
      outGodot,
      outOmi,
    });
    return { content: [{ type: "text", text: JSON.stringify({ ...edited, written: args.dest }, null, 2) }] };
  }
  throw new Error(`Unknown tool: ${name}`);
}

function sendResult(id, result) {
  send({ jsonrpc: "2.0", id, result });
}

function sendError(id, code, message) {
  send({ jsonrpc: "2.0", id, error: { code, message } });
}

async function handleMessage(msg) {
  if (!msg || typeof msg !== "object") return;
  const { id, method, params } = msg;

  // Notifications have no id and expect no reply.
  if (id === undefined || id === null) return;

  try {
    switch (method) {
      case "initialize": {
        const clientVersion = params?.protocolVersion || "2024-11-05";
        sendResult(id, {
          protocolVersion: clientVersion,
          capabilities: { tools: {} },
          serverInfo: SERVER_INFO,
        });
        return;
      }
      case "ping":
        sendResult(id, {});
        return;
      case "tools/list":
        sendResult(id, { tools: TOOLS });
        return;
      case "tools/call": {
        const name = params?.name;
        if (name === "tris_godot_shot") {
          const toolResult = await handleGodotShot(params?.arguments || {});
          sendResult(id, toolResult);
          return;
        }
        if (name && name.startsWith("tris_angelo_")) {
          const toolResult = await handleAngeloTool(name, params?.arguments || {});
          sendResult(id, toolResult);
          return;
        }
        sendError(id, -32602, `Unknown tool: ${name}`);
        return;
      }
      default:
        sendError(id, -32601, `Method not found: ${method}`);
    }
  } catch (err) {
    sendError(id, -32603, err?.message || String(err));
  }
}

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on("line", (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  let parsed;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return;
  }
  handleMessage(parsed);
});
