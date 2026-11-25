#!/usr/bin/env node
// tris-mcp: zero-dependency stdio MCP server exposing `tris_godot_shot` to coding agents
// (Claude Code, Codex, Cursor, OpenCode) both inside `tris-box` and locally.

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER_INFO = { name: "tris-mcp", version: "0.1.0" };

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
        if (name !== "tris_godot_shot") {
          sendError(id, -32602, `Unknown tool: ${name}`);
          return;
        }
        const toolResult = await handleGodotShot(params?.arguments || {});
        sendResult(id, toolResult);
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
