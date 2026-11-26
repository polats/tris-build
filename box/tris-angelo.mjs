// Shared headless Angelo runner & 6,437-model CC0 Library search for tris-mcp and tris-pair-server.
// Zero external dependencies (Node 18+ built-ins only).

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const CACHE_DIR = process.env.TRIS_ANGELO_CACHE || "/tmp/tris-angelo-cache";
export const GEN_DIR = process.env.TRIS_ANGELO_GEN || "/tmp/tris-angelo-generated";
const INDEX_CACHE = path.join(CACHE_DIR, "library_index_cache.json");
const WORKER_SCRIPT = fs.existsSync(path.join(__dirname, "tris-angelo-worker.py"))
  ? path.join(__dirname, "tris-angelo-worker.py")
  : "/usr/local/lib/tris/tris-angelo-worker.py";

export function resolveAngeloBin() {
  const candidates = [
    process.env.ANGELO_BIN,
    "/usr/local/bin/angelo",
    "/opt/angelo/angelo",
    "/Applications/Angelo.app/Contents/MacOS/Angelo",
    "/Users/paulgadi/projects/build-angelo-native/bin/Angelo.app/Contents/MacOS/Angelo",
  ].filter(Boolean);
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return process.env.ANGELO_BIN || "angelo";
}

let cachedModels = null;
async function loadCatalogItems() {
  if (cachedModels) return cachedModels;
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  if (!fs.existsSync(INDEX_CACHE)) {
    const latestResp = await fetch("https://assets.toonlab.io/catalog/v1/latest.json", {
      headers: { "user-agent": "Angelo/2.1.0" },
    });
    if (!latestResp.ok) throw new Error(`Catalog latest.json failed (${latestResp.status})`);
    const latest = await latestResp.json();
    const gzResp = await fetch(latest.url, { headers: { "user-agent": "Angelo/2.1.0" } });
    if (!gzResp.ok) throw new Error(`Catalog index download failed (${gzResp.status})`);
    const raw = zlib.gunzipSync(Buffer.from(await gzResp.arrayBuffer()));
    fs.writeFileSync(INDEX_CACHE, raw);
  }
  const data = JSON.parse(fs.readFileSync(INDEX_CACHE, "utf8"));
  cachedModels = (data.items || [])
    .filter((i) => i.kind === "model")
    .map((i) => {
      const files = Array.isArray(i.files) ? i.files : [];
      const bytes = files.reduce((s, f) => s + (f.bytes || 0), 0);
      return {
        id: i.id,
        title: i.title || i.id,
        category: i.category || "other",
        source: i.source || "other",
        popularity: Number(i.popularity || 0),
        thumb: i.thumb || "",
        sizeKb: Math.round(bytes / 1024),
        searchText: `${i.title || ""} ${(i.tags || []).join(" ")} ${i.category || ""} ${i.source || ""}`.toLowerCase(),
      };
    })
    .sort((a, b) => b.popularity - a.popularity);
  return cachedModels;
}

export async function searchLibrary({ q = "", category = "all", source = "all", limit = 36, offset = 0 } = {}) {
  const all = await loadCatalogItems();
  const terms = String(q || "").trim().toLowerCase().split(/\s+/).filter(Boolean);
  const cat = String(category || "all").toLowerCase();
  const src = String(source || "all").toLowerCase();
  const filtered = all.filter((m) => {
    if (cat && cat !== "all" && m.category !== cat) return false;
    if (src && src !== "all" && m.source !== src) return false;
    for (const t of terms) {
      if (!m.searchText.includes(t)) return false;
    }
    return true;
  });
  const lim = Math.min(60, Math.max(1, Number(limit) || 36));
  const off = Math.max(0, Number(offset) || 0);
  return {
    total: filtered.length,
    catalogTotal: all.length,
    items: filtered.slice(off, off + lim).map(({ searchText, ...rest }) => rest),
  };
}

export function runAngeloWorker(payloadObj) {
  return new Promise((resolve, reject) => {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    fs.mkdirSync(GEN_DIR, { recursive: true });
    const bin = resolveAngeloBin();
    const child = spawn(
      bin,
      ["--background", "--factory-startup", "--python", WORKER_SCRIPT, "--", JSON.stringify(payloadObj)],
      {
        env: { ...process.env, TRIS_ANGELO_CACHE: CACHE_DIR },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => { stdout += d.toString(); });
    child.stderr.on("data", (d) => { stderr += d.toString(); });
    child.on("error", (err) => reject(new Error(`Could not launch Angelo (${bin}): ${err.message}`)));
    child.on("close", (code) => {
      const match = stdout.split("\n").reverse().find((l) => l.startsWith("ANGELO_RESULT:"));
      if (code === 0 && match) {
        try {
          resolve(JSON.parse(match.slice("ANGELO_RESULT:".length)));
        } catch (err) {
          reject(new Error(`Invalid Angelo result JSON: ${err.message}`));
        }
      } else {
        reject(new Error((stderr || stdout).slice(-600) || `Angelo exited with code ${code}`));
      }
    });
  });
}

export function safeWorkspacePath(workspace, relPath) {
  const root = path.resolve(workspace);
  const cleaned = String(relPath || "").replace(/^res:\/\//, "").replace(/^\/+/, "");
  const dest = path.resolve(root, cleaned);
  if (dest !== root && !dest.startsWith(root + path.sep)) {
    throw new Error(`Destination path escapes workspace: ${relPath}`);
  }
  return dest;
}
