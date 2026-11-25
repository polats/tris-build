#!/usr/bin/env node
// tris-night: branch-isolated teammate workflow for `creds.club`.
//   tris-night start <slug>
//   tris-night finish --title "..." --summary "..." [--scene res://...] [--dry-run]

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function usage() {
  console.log(`Usage:
  tris-night start <slug> [--base <branch>]
  tris-night finish --title "<title>" --summary "<note>" [options]

Finish options:
  --scene <res://...>   Scene to capture for preview (default: main_scene)
  --size <WxH>          Screenshot size (default: 1280x720)
  --frames <N>          Frames before capture (default: 12)
  --wait <sec>          Minimum seconds before capture (default: 0)
  --input <spec>        Scripted input spec for tris-shot
  --allow-errors        Allow opening PR even if Godot logged errors
  --dry-run             Run tris-shot and print PR payload without committing/pushing`);
}

function run(cmd, args, opts = {}) {
  const res = spawnSync(cmd, args, { encoding: "utf8", ...opts });
  return res;
}

function mustRun(cmd, args, opts = {}) {
  const res = run(cmd, args, opts);
  if (res.status !== 0) {
    const msg = (res.stderr || res.stdout || res.error?.message || "").trim();
    throw new Error(`${cmd} ${args.join(" ")} failed: ${msg}`);
  }
  return (res.stdout || "").trim();
}

function sanitizeSlug(raw) {
  return String(raw || "")
    .toLowerCase()
    .replace(/^night\//, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
}

function findShotBin() {
  for (const p of [path.join(__dirname, "tris-shot.mjs"), "/usr/local/bin/tris-shot"]) {
    if (fs.existsSync(p)) return p;
  }
  return "tris-shot";
}

function cmdStart(argv) {
  let slug = "";
  let base = "";
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--base") base = argv[++i] || "";
    else if (!slug && !argv[i].startsWith("-")) slug = argv[i];
  }
  const clean = sanitizeSlug(slug);
  if (!clean) {
    console.error("tris-night start: provide a branch slug, e.g. `tris-night start faster-stars`");
    process.exit(2);
  }
  const branch = `night/${clean}`;
  if (base) {
    mustRun("git", ["checkout", "-B", branch, base]);
  } else {
    mustRun("git", ["checkout", "-B", branch]);
  }
  console.log(JSON.stringify({ ok: true, branch }, null, 2));
}

function cmdFinish(argv) {
  const opts = {
    title: "",
    summary: "",
    scene: "",
    size: "1280x720",
    frames: 12,
    wait: 0,
    input: "",
    allowErrors: false,
    dryRun: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i] || "";
    if (a === "--title") opts.title = next();
    else if (a === "--summary") opts.summary = next();
    else if (a === "--scene") opts.scene = next();
    else if (a === "--size") opts.size = next();
    else if (a === "--frames") opts.frames = Number(next()) || 12;
    else if (a === "--wait") opts.wait = Number(next()) || 0;
    else if (a === "--input") opts.input = next();
    else if (a === "--allow-errors") opts.allowErrors = true;
    else if (a === "--dry-run") opts.dryRun = true;
  }

  const branch = mustRun("git", ["rev-parse", "--abbrev-ref", "HEAD"]);
  if (!/^(night|tris)\//.test(branch)) {
    throw new Error(`Refusing to run on "${branch}". Start a branch first with \`tris-night start <slug>\`.`);
  }
  if (!opts.title) opts.title = branch.replace(/^(night|tris)\//, "").replace(/-/g, " ");
  if (!opts.summary) opts.summary = `Automated exploration on \`${branch}\`.`;

  const shotPath = ".tris/shots/preview.png";
  const metricsPath = ".tris/shots/preview.json";
  const shotBin = findShotBin();
  const shotArgs = [
    "--project", ".",
    "--out", shotPath,
    "--metrics", metricsPath,
    "--size", opts.size,
    "--frames", String(opts.frames),
    "--wait", String(opts.wait),
  ];
  if (opts.scene) shotArgs.push("--scene", opts.scene);
  if (opts.input) shotArgs.push("--input", opts.input);

  const shotRun = shotBin.endsWith(".mjs")
    ? run(process.execPath, [shotBin, ...shotArgs])
    : run(shotBin, shotArgs);

  let shot;
  try {
    shot = JSON.parse((shotRun.stdout || "").trim());
  } catch {
    throw new Error(`tris-shot failed: ${(shotRun.stderr || shotRun.stdout || "").trim()}`);
  }

  if (!shot.ok) {
    throw new Error(`tris-shot failed to capture preview: ${JSON.stringify(shot.errors || shot.log_tail || shot)}`);
  }
  if ((shot.errors?.length || 0) > 0 && !opts.allowErrors) {
    throw new Error(`Godot reported ${shot.errors.length} error(s): ${shot.errors.join(" | ")}`);
  }

  const meta = {
    summary: opts.summary,
    shot_path: shotPath,
    metrics: {
      avg_frame_ms: shot.avg_frame_ms,
      errors: shot.errors?.length || 0,
      warnings: shot.warnings?.length || 0,
      renderer: shot.renderer,
      backend: shot.backend,
      width: shot.width,
      height: shot.height,
    },
  };

  const prBody = [
    opts.summary,
    "",
    `- **Frame time**: ${shot.avg_frame_ms} ms (${shot.renderer} / ${shot.backend})`,
    `- **Godot errors**: ${shot.errors?.length || 0}`,
    `- **Preview shot**: \`${shotPath}\``,
    "",
    `<!-- tris-night: ${JSON.stringify(meta)} -->`,
  ].join("\n");

  if (opts.dryRun) {
    console.log(JSON.stringify({ ok: true, dry_run: true, branch, title: opts.title, meta, pr_body: prBody }, null, 2));
    return;
  }

  mustRun("git", ["add", "-A"]);
  const staged = run("git", ["diff", "--cached", "--quiet"]);
  if (staged.status !== 0) {
    mustRun("git", ["commit", "-m", opts.title]);
  }
  mustRun("git", ["push", "-u", "origin", branch]);

  const existing = run("gh", ["pr", "view", branch, "--json", "url", "-q", ".url"]);
  let prUrl = "";
  if (existing.status === 0 && existing.stdout.trim()) {
    mustRun("gh", ["pr", "edit", branch, "--title", opts.title, "--body", prBody]);
    prUrl = existing.stdout.trim();
  } else {
    prUrl = mustRun("gh", ["pr", "create", "--head", branch, "--title", opts.title, "--body", prBody]);
  }

  console.log(JSON.stringify({ ok: true, branch, pr_url: prUrl, meta }, null, 2));
}

try {
  const [sub, ...rest] = process.argv.slice(2);
  if (!sub || sub === "--help" || sub === "-h") {
    usage();
    process.exit(0);
  }
  if (sub === "start") cmdStart(rest);
  else if (sub === "finish") cmdFinish(rest);
  else {
    console.error(`tris-night: unknown subcommand "${sub}"`);
    usage();
    process.exit(2);
  }
} catch (err) {
  console.error(`tris-night: ${err.message}`);
  process.exit(1);
}
