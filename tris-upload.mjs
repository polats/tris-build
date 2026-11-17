#!/usr/bin/env node
// Publish a web build to Tris.
//
//   tris-upload.mjs <out-dir>
//
// Run from a GitHub Actions job with `id-token: write`: the job's own OIDC token says which
// repository the build belongs to, so no secret is configured anywhere.
//
// Environment:
//   TRIS_URL          the Tris API (default https://api.creds.club)
//   TRIS_AUDIENCE     audience to request for the OIDC token (default https://creds.club)
//   TRIS_OIDC_TOKEN   use this token instead of asking Actions for one

import { createReadStream, createWriteStream } from "node:fs";
import { appendFile, mkdtemp, open, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import { pipeline } from "node:stream/promises";
import { createGzip } from "node:zlib";

const origin = (process.env.TRIS_URL || "https://api.creds.club").replace(/\/$/, "");
const audience = process.env.TRIS_AUDIENCE || "https://creds.club";
const outDir = process.argv[2];
if (!outDir) fail("usage: tris-upload.mjs <out-dir>");

// Worth compressing; images, audio and zips already are.
const COMPRESSIBLE = new Set(["html", "js", "mjs", "css", "json", "webmanifest", "wasm", "pck", "svg", "txt", "ttf", "otf"]);

function fail(message) {
  console.error(`tris: error: ${message}`);
  process.exit(1);
}
const say = (message) => console.error(`tris: ${message}`);

async function oidcToken() {
  if (process.env.TRIS_OIDC_TOKEN) return process.env.TRIS_OIDC_TOKEN;
  const url = process.env.ACTIONS_ID_TOKEN_REQUEST_URL;
  const token = process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
  if (!url || !token) fail("no OIDC token available; the workflow job needs `permissions: id-token: write`");
  const response = await fetch(`${url}&audience=${encodeURIComponent(audience)}`, {
    headers: { authorization: `Bearer ${token}` },
  });
  if (!response.ok) fail(`could not get an OIDC token from Actions (${response.status})`);
  return (await response.json()).value;
}

async function walk(dir) {
  const found = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...(await walk(path)));
    else if (entry.isFile()) found.push(path);
  }
  return found;
}

async function call(method, path, token, body, headers = {}) {
  const response = await fetch(`${origin}${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, ...headers },
    body,
  });
  const text = await response.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = { error: text.slice(0, 200) };
  }
  if (!response.ok) fail(`${method} ${path}: ${response.status} ${data.error ?? ""}`);
  return data;
}

const scratch = await mkdtemp(join(tmpdir(), "tris-upload-"));
try {
  let build = {};
  try {
    build = JSON.parse(await readFile(join(outDir, "tris-build.json"), "utf8"));
  } catch {
    // A build made without tris-build.sh has no manifest; the files are enough.
  }

  // Compress first: the sizes Tris is told are the sizes it will store and check.
  const files = [];
  for (const [index, source] of (await walk(outDir)).entries()) {
    const path = relative(outDir, source).split(sep).join("/");
    if (path === "tris-build.json") continue;
    const rawSize = (await stat(source)).size;
    if (rawSize === 0) continue;
    const file = { path, source, size: rawSize };
    const extension = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
    if (COMPRESSIBLE.has(extension) && rawSize > 1024) {
      const packed = join(scratch, `${index}.gz`);
      await pipeline(createReadStream(source), createGzip({ level: 6 }), createWriteStream(packed));
      const packedSize = (await stat(packed)).size;
      if (packedSize < rawSize * 0.9) Object.assign(file, { source: packed, size: packedSize, encoding: "gzip" });
    }
    files.push(file);
  }
  const total = files.reduce((sum, file) => sum + file.size, 0);
  say(`uploading ${files.length} files, ${(total / 1048576).toFixed(0)} MiB`);

  const created = await call(
    "POST",
    "/api/builds",
    await oidcToken(),
    JSON.stringify({ build, files: files.map(({ path, size, encoding }) => ({ path, size, encoding })) }),
    { "content-type": "application/json" },
  );
  const { id, token, partBytes } = created;

  for (const file of files) {
    const target = `/api/builds/${id}/files/${file.path.split("/").map(encodeURIComponent).join("/")}`;
    if (file.size <= partBytes) {
      await call("PUT", target, token, await readFile(file.source));
      continue;
    }
    const { uploadId } = await call("POST", `${target}?uploads`, token);
    const handle = await open(file.source, "r");
    const parts = [];
    try {
      for (let part = 1, offset = 0; offset < file.size; part += 1, offset += partBytes) {
        const chunk = Buffer.alloc(Math.min(partBytes, file.size - offset));
        await handle.read(chunk, 0, chunk.length, offset);
        const query = `?uploadId=${encodeURIComponent(uploadId)}&part=${part}`;
        parts.push(await call("PUT", `${target}${query}`, token, chunk));
      }
    } finally {
      await handle.close();
    }
    await call("POST", `${target}?uploadId=${encodeURIComponent(uploadId)}`, token, JSON.stringify({ parts }), {
      "content-type": "application/json",
    });
  }

  const { url } = await call("POST", `/api/builds/${id}/complete`, token);
  say(`live at ${url}`);
  if (process.env.GITHUB_STEP_SUMMARY) {
    await appendFile(process.env.GITHUB_STEP_SUMMARY, `### Tris\n\nPlay: ${url}\n`);
  }
  console.log(url);
} finally {
  await rm(scratch, { recursive: true, force: true });
}
