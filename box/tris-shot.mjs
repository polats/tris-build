#!/usr/bin/env node
// tris-shot: capture a rendered screenshot (or contact strip) + diagnostics from any Godot 4.3+ project.
// Works natively on desktop GPUs and on CPU-only Linux / GitHub Codespaces via xvfb + Mesa (llvmpipe / lavapipe).

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function usage() {
  console.log(`Usage: tris-shot [options] [-- <extra godot user args>]

Options:
  --project <dir>           Godot project directory (default: .)
  --scene <res://...>       Scene to capture (default: run/main_scene from project.godot)
  --out <file.png>          Output PNG path (default: <project>/.tris/shots/<name>.png)
  --metrics <file.json>     Output metrics JSON path (default: <out>.json)
  --size <WxH>              Viewport resolution (default: 1280x720)
  --frames <N>              Frames to step before first capture (default: 12)
  --wait <sec>              Minimum seconds before first capture (default: 0)
  --strip <N>               Capture N frames into a horizontal contact sheet (default: 1)
  --interval-frames <N>     Frames between strip captures (default: 8)
  --input <spec>            Scripted inputs: action:start_sec:dur_sec,...
  --backend <mode>          auto | native | xvfb-gl | xvfb-vk (default: auto)
  --renderer <method>       auto | gl_compatibility | mobile | forward_plus (default: auto)
  --import                  Force headless --import before capture
  --timeout <sec>           Hard timeout in seconds (default: 120)
  --godot <bin>             Path to Godot binary (default: $GODOT or godot)
  --help                    Show this help`);
}

function parseArgs(argv) {
  const opts = {
    project: ".",
    scene: "",
    out: "",
    metrics: "",
    size: "1280x720",
    frames: 12,
    wait: 0,
    strip: 1,
    intervalFrames: 8,
    input: "",
    backend: "auto",
    renderer: "auto",
    forceImport: false,
    timeout: 120,
    godot: process.env.GODOT || "godot",
    extraUserArgs: [],
  };

  let i = 0;
  while (i < argv.length) {
    const arg = argv[i];
    if (arg === "--") {
      opts.extraUserArgs = argv.slice(i + 1);
      break;
    }
    const next = () => {
      if (i + 1 >= argv.length) throw new Error(`Missing value for ${arg}`);
      return argv[++i];
    };
    switch (arg) {
      case "--help":
      case "-h":
        usage();
        process.exit(0);
      case "--project": opts.project = next(); break;
      case "--scene": opts.scene = next(); break;
      case "--out": opts.out = next(); break;
      case "--metrics": opts.metrics = next(); break;
      case "--size": opts.size = next(); break;
      case "--frames": opts.frames = Math.max(1, Number(next())); break;
      case "--wait": opts.wait = Math.max(0, Number(next())); break;
      case "--strip": opts.strip = Math.max(1, Number(next())); break;
      case "--interval-frames": opts.intervalFrames = Math.max(1, Number(next())); break;
      case "--input": opts.input = next(); break;
      case "--backend": opts.backend = next(); break;
      case "--renderer": opts.renderer = next(); break;
      case "--import": opts.forceImport = true; break;
      case "--timeout": opts.timeout = Math.max(5, Number(next())); break;
      case "--godot": opts.godot = next(); break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
    i++;
  }
  return opts;
}

function findProjectDir(startDir) {
  const abs = path.resolve(startDir);
  if (fs.existsSync(path.join(abs, "project.godot"))) return abs;
  throw new Error(`No project.godot found in ${abs}`);
}

function readProjectConfig(projectDir) {
  const text = fs.readFileSync(path.join(projectDir, "project.godot"), "utf8");
  const matchSetting = (key) => {
    const re = new RegExp(`^${key}\\s*=\\s*"([^"]+)"`, "m");
    const m = text.match(re);
    return m ? m[1] : "";
  };
  return {
    mainScene: matchSetting("run/main_scene"),
    renderingMethod: matchSetting("renderer/rendering_method") || "forward_plus",
  };
}

function findHarnessPath() {
  const candidates = [
    path.join(__dirname, "tris-shot-harness.gd"),
    "/usr/local/lib/tris/tris-shot-harness.gd",
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  throw new Error(`Could not find tris-shot-harness.gd (checked: ${candidates.join(", ")})`);
}

function findLavapipeIcd() {
  const candidates = [
    "/usr/share/vulkan/icd.d/lvp_icd.x86_64.json",
    "/usr/share/vulkan/icd.d/lvp_icd.aarch64.json",
    "/usr/share/vulkan/icd.d/lvp_icd.json",
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return "";
}

function commandExists(cmd) {
  const res = spawnSync("which", [cmd], { stdio: "ignore" });
  return res.status === 0;
}

function chooseBackend(requested, renderingMethod) {
  if (requested !== "auto") return requested;
  const isLinux = process.platform === "linux";
  const hasDisplay = Boolean(process.env.DISPLAY || process.env.WAYLAND_DISPLAY);
  if (!isLinux || hasDisplay) return "native";
  if (renderingMethod === "gl_compatibility") return "xvfb-gl";
  return "xvfb-vk";
}

function parseGodotLogs(combined) {
  const errors = [];
  const warnings = [];
  for (const rawLine of combined.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    if (/^(ERROR:|SCRIPT ERROR:|Parse Error:|TRIS_SHOT_ERROR:|USER ERROR:)/i.test(line)) {
      errors.push(line);
    } else if (/^(WARNING:|USER WARNING:)/i.test(line)) {
      warnings.push(line);
    }
  }
  return { errors: errors.slice(0, 30), warnings: warnings.slice(0, 30) };
}

function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(`tris-shot: ${err.message}`);
    process.exit(2);
  }

  const projectDir = findProjectDir(opts.project);
  const cfg = readProjectConfig(projectDir);
  const harnessPath = findHarnessPath();
  const scene = opts.scene || cfg.mainScene;
  if (!scene) {
    console.error("tris-shot: no --scene provided and project.godot has no run/main_scene");
    process.exit(2);
  }

  const renderingMethod = opts.renderer === "auto" ? cfg.renderingMethod : opts.renderer;
  const backend = chooseBackend(opts.backend, renderingMethod);

  const sizeMatch = opts.size.match(/^(\d+)x(\d+)$/);
  if (!sizeMatch) {
    console.error(`tris-shot: invalid --size "${opts.size}", expected WxH`);
    process.exit(2);
  }
  const [, width, height] = sizeMatch;

  const sceneSlug = scene
    .replace(/^res:\/\//, "")
    .replace(/\.[^.]+$/, "")
    .replace(/[^A-Za-z0-9._-]+/g, "_") || "shot";
  const outPath = path.resolve(opts.out || path.join(projectDir, ".tris", "shots", `${sceneSlug}.png`));
  const metricsPath = path.resolve(opts.metrics || `${outPath.replace(/\.png$/i, "")}.json`);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.mkdirSync(path.dirname(metricsPath), { recursive: true });
  if (fs.existsSync(metricsPath)) fs.unlinkSync(metricsPath);

  const timeoutMs = opts.timeout * 1000;
  const startedAt = Date.now();

  // Step 1: ensure .godot import cache exists so textures/shaders/UIDs load cleanly.
  const dotGodot = path.join(projectDir, ".godot");
  if (opts.forceImport || !fs.existsSync(dotGodot)) {
    const imp = spawnSync(
      opts.godot,
      ["--headless", "--audio-driver", "Dummy", "--path", projectDir, "--import"],
      { encoding: "utf8", timeout: timeoutMs },
    );
    if (imp.error) {
      console.error(`tris-shot: failed to run godot --import: ${imp.error.message}`);
      process.exit(1);
    }
  }

  // Step 2: assemble Godot command + environment for the selected backend.
  const godotArgs = [
    "--path", projectDir,
    "--resolution", `${width}x${height}`,
    "--windowed",
    "--audio-driver", "Dummy",
  ];

  const env = { ...process.env };
  if (backend === "xvfb-gl") {
    godotArgs.push("--rendering-driver", "opengl3", "--rendering-method", "gl_compatibility");
    env.LIBGL_ALWAYS_SOFTWARE = "1";
    env.MESA_GL_VERSION_OVERRIDE = env.MESA_GL_VERSION_OVERRIDE || "3.3";
  } else if (backend === "xvfb-vk") {
    godotArgs.push("--rendering-driver", "vulkan");
    if (renderingMethod === "mobile" || renderingMethod === "forward_plus") {
      godotArgs.push("--rendering-method", renderingMethod);
    }
    const icd = findLavapipeIcd();
    if (icd && !env.VK_ICD_FILENAMES) {
      env.VK_ICD_FILENAMES = icd;
    }
  } else if (backend === "native") {
    if (renderingMethod) godotArgs.push("--rendering-method", renderingMethod);
  } else {
    console.error(`tris-shot: unknown backend "${backend}"`);
    process.exit(2);
  }

  godotArgs.push(
    "--script", harnessPath,
    "--",
    `--tris-out=${outPath}`,
    `--tris-metrics=${metricsPath}`,
    `--tris-scene=${scene}`,
    `--tris-frames=${opts.frames}`,
    `--tris-wait=${opts.wait}`,
    `--tris-strip=${opts.strip}`,
    `--tris-interval-frames=${opts.intervalFrames}`,
  );
  if (opts.input) godotArgs.push(`--tris-input=${opts.input}`);
  if (opts.extraUserArgs.length) godotArgs.push(...opts.extraUserArgs);

  let cmd = opts.godot;
  let args = godotArgs;
  if (backend === "xvfb-gl" || backend === "xvfb-vk") {
    if (!commandExists("xvfb-run")) {
      console.error(`tris-shot: backend "${backend}" requires xvfb-run, which is not installed`);
      process.exit(1);
    }
    cmd = "xvfb-run";
    args = ["-a", "-s", `-screen 0 ${width}x${height}x24`, opts.godot, ...godotArgs];
  }

  const run = spawnSync(cmd, args, {
    encoding: "utf8",
    env,
    timeout: timeoutMs,
    maxBuffer: 16 * 1024 * 1024,
  });

  const wallMs = Date.now() - startedAt;
  const combinedLogs = `${run.stdout || ""}\n${run.stderr || ""}`;
  const { errors, warnings } = parseGodotLogs(combinedLogs);

  let harnessMetrics = {};
  if (fs.existsSync(metricsPath)) {
    try {
      harnessMetrics = JSON.parse(fs.readFileSync(metricsPath, "utf8"));
    } catch {
      harnessMetrics = {};
    }
  }

  const imageExists = fs.existsSync(outPath) && fs.statSync(outPath).size > 0;
  const ok = Boolean(harnessMetrics.ok && imageExists && run.status === 0);

  const result = {
    ok,
    backend,
    renderer: backend === "xvfb-gl" ? "gl_compatibility" : renderingMethod,
    scene,
    image_path: outPath,
    image_bytes: imageExists ? fs.statSync(outPath).size : 0,
    width: harnessMetrics.width || Number(width),
    height: harnessMetrics.height || Number(height),
    frames_rendered: harnessMetrics.frames_rendered || 0,
    strip_frames: harnessMetrics.strip_frames || 0,
    avg_frame_ms: harnessMetrics.avg_frame_ms || 0,
    wall_ms: wallMs,
    exit_code: run.status,
    timed_out: Boolean(run.error && run.error.code === "ETIMEDOUT"),
    errors,
    warnings,
  };

  if (!ok && !result.errors.length) {
    const tail = combinedLogs.trim().split(/\r?\n/).slice(-10);
    result.log_tail = tail;
  }

  fs.writeFileSync(metricsPath, JSON.stringify(result, null, 2) + "\n");
  console.log(JSON.stringify(result, null, 2));
  process.exit(ok ? 0 : 1);
}

main();
