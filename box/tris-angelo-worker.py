"""Headless Cloud Angelo worker — 100% genuine Angelo-only features:
1. Angelo Library (angelo_agent.library_catalog) — 6,437 CC0 models + user .glb drop
2. Native C++ Retopology (bpy.ops.object.retopology) — real _angelo_retopology facts
3. Fit Collision Hulls (angelo_agent.collision_fit) — DECOMPOSE vs CONVEX on seam-welded proxy
4. Engine-Contract Preflight (angelo_agent.engine_preflight) — GODOT, WEB, UNITY, UNREAL
5. Multi-Engine Physics glTF Export (io_scene_gltf2/angelo_physics) — OMI_physics & Godot -colonly
"""
import gzip
import json
import math
import random
import os
import re
import sys
import time
import urllib.request
import addon_utils
import bmesh
import bpy

argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
req = json.loads(argv[0]) if argv else {}

mode = req.get("mode") or "load"           # "load" | "edit"
edit_kind = req.get("editKind") or ""      # retopology | fit_decompose | fit_convex | preflight
edit_arg = req.get("editArg") or ""
asset_id = (req.get("assetId") or "").strip()
prompt = (req.get("prompt") or "").strip()
target = req.get("target") or "threejs"
do_hulls = bool(req.get("fitColliders", True))
blend_in = req.get("blendIn")
blend_out = req.get("blendOut")
out_live = req["outLive"]
out_omi = req.get("outOmi")
out_godot = req.get("outGodot")
out_shards = req.get("outShards")
input_glb = req.get("inputGlb")

CACHE_DIR = os.environ.get("TRIS_ANGELO_CACHE", "/tmp/tris-angelo-cache")
INDEX_CACHE = os.path.join(CACHE_DIR, "library_index_cache.json")
os.makedirs(CACHE_DIR, exist_ok=True)

t0 = time.time()
addon_utils.enable("angelo_agent", default_set=False, persistent=False)
from angelo_agent import collision_fit, engine_preflight, library_catalog

def http_get(url):
    r = urllib.request.Request(url, headers={"User-Agent": "Angelo/2.1.0"})
    return urllib.request.urlopen(r, timeout=25).read()

def load_catalog():
    if not os.path.exists(INDEX_CACHE):
        latest = json.loads(http_get("https://assets.toonlab.io/catalog/v1/latest.json"))
        raw = gzip.decompress(http_get(latest["url"]))
        with open(INDEX_CACHE, "wb") as f:
            f.write(raw)
    with open(INDEX_CACHE, "r", encoding="utf-8") as f:
        data = json.load(f)
    base_url, items, _ = library_catalog.parse(data)
    return base_url, library_catalog.Catalog(base_url, items)

def download_library_item(item, base_url):
    files, _res = library_catalog.files_for(item, base_url)
    safe_id = re.sub(r"[^a-zA-Z0-9._-]+", "_", item["id"])
    item_dir = os.path.join(CACHE_DIR, safe_id)
    os.makedirs(item_dir, exist_ok=True)
    model_path = None
    for f in files:
        dest = os.path.join(item_dir, f["name"])
        os.makedirs(os.path.dirname(dest), exist_ok=True)
        if not os.path.exists(dest):
            with open(dest, "wb") as out:
                out.write(http_get(f["url"]))
        if f.get("role") == "model" or f["name"].lower().endswith((".glb", ".gltf")):
            model_path = dest
    return model_path

def clear_existing_hulls(hero):
    for o in list(bpy.data.objects):
        is_hull = (
            o.name.startswith("COLLIDER_")
            or "_Hull_" in o.name
            or (hasattr(o, "angelo_physics") and getattr(o.angelo_physics, "collision_only", False))
        )
        if is_hull:
            bpy.data.objects.remove(o, do_unlink=True)

def fit_hulls_for(hero, method="DECOMPOSE", max_hulls=6):
    clear_existing_hulls(hero)
    proxy = hero.copy()
    proxy.data = hero.data.copy()
    bpy.context.collection.objects.link(proxy)
    bm = bmesh.new()
    bm.from_mesh(proxy.data)
    bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=0.005)
    bm.to_mesh(proxy.data)
    bm.free()
    proxy.data.update()
    bpy.context.view_layer.update()

    hulls, report = collision_fit.fit(proxy, method, max_hulls, 32)
    if not hulls and method == "DECOMPOSE":
        hulls, report = collision_fit.fit(proxy, "CONVEX", 1, 32)

    for h in hulls:
        hmw = h.matrix_world.copy()
        h.parent = hero
        h.matrix_world = hmw
    bpy.data.objects.remove(proxy, do_unlink=True)
    bpy.context.view_layer.update()
    return hulls, report


def make_interior_mat(preset):
    mat = bpy.data.materials.new(name=f"Mat_Interior_{preset}")
    bsdf = mat.node_tree.nodes.get("Principled BSDF")
    if preset == "wood":
        bsdf.inputs["Base Color"].default_value = (0.78, 0.58, 0.34, 1.0)
        bsdf.inputs["Roughness"].default_value = 0.78
    elif preset == "crystal":
        bsdf.inputs["Base Color"].default_value = (0.45, 0.88, 1.0, 1.0)
        bsdf.inputs["Roughness"].default_value = 0.08
        bsdf.inputs["Emission Color"].default_value = (0.25, 0.82, 1.0, 1.0)
        bsdf.inputs["Emission Strength"].default_value = 1.6
    else:
        bsdf.inputs["Base Color"].default_value = (0.56, 0.54, 0.50, 1.0)
        bsdf.inputs["Roughness"].default_value = 0.88
    return mat

def generate_voronoi_shards(hero, preset="stone", count=10):
    """Slice a welded copy of hero into material-aware Voronoi shards with interior caps,
    true center-of-mass origins, and Angelo RIGID physics (OMI_physics + Godot -rigid)."""
    from mathutils import Vector
    interior_mat = make_interior_mat(preset)
    density = {"wood": 0.6, "crystal": 1.8, "stone": 2.4}.get(preset, 2.0)

    # Welded source bmesh
    base_bm = bmesh.new()
    base_bm.from_mesh(hero.data)
    bmesh.ops.remove_doubles(base_bm, verts=base_bm.verts, dist=0.005)
    bmesh.ops.recalc_face_normals(base_bm, faces=base_bm.faces)

    coords = [v.co.copy() for v in base_bm.verts]
    if not coords:
        base_bm.free()
        return []
    min_v = Vector((min(c.x for c in coords), min(c.y for c in coords), min(c.z for c in coords)))
    max_v = Vector((max(c.x for c in coords), max(c.y for c in coords), max(c.z for c in coords)))
    size = max_v - min_v
    center = (min_v + max_v) * 0.5

    rng = random.Random(101 if preset == "stone" else (202 if preset == "wood" else 303))
    seeds = []
    if preset == "wood":
        # Elongated grain splinters: spread seeds across X & Z, clustered along Y
        for i in range(count):
            sx = min_v.x + size.x * ((i + 0.5) / count) + rng.uniform(-0.08, 0.08) * size.x
            sy = center.y + rng.uniform(-0.22, 0.22) * size.y
            sz = min_v.z + size.z * rng.uniform(0.25, 0.78)
            seeds.append(Vector((sx, sy, sz)))
    elif preset == "crystal":
        # Radial shards around center impact point
        seeds.append(center.copy())
        for i in range(count - 1):
            ang = (i / (count - 1)) * math.pi * 2.0 + rng.uniform(-0.12, 0.12)
            rad = rng.uniform(0.28, 0.48)
            seeds.append(Vector((
                center.x + math.cos(ang) * size.x * rad,
                center.y + rng.uniform(-0.25, 0.25) * size.y,
                center.z + math.sin(ang) * size.z * rad,
            )))
    else:
        # Chunky 3D stone rubble
        for i in range(count):
            seeds.append(Vector((
                min_v.x + size.x * rng.uniform(0.12, 0.88),
                min_v.y + size.y * rng.uniform(0.18, 0.82),
                min_v.z + size.z * rng.uniform(0.12, 0.88),
            )))

    # Metric stretch for wood grain planes
    scale_metric = Vector((1.0, 0.25, 0.35)) if preset == "wood" else Vector((1.0, 1.0, 1.0))

    shards = []
    for idx, s in enumerate(seeds):
        bm = base_bm.copy()
        # Sort neighbors by distance and clip against closest 7 Voronoi bisector planes
        others = sorted(
            [o for j, o in enumerate(seeds) if j != idx],
            key=lambda o: ((o - s) * scale_metric).length_squared,
        )[:7]
        for o in others:
            mid = (s + o) * 0.5
            normal = (o - s)
            normal = Vector((normal.x * scale_metric.x, normal.y * scale_metric.y, normal.z * scale_metric.z))
            if normal.length < 1e-6:
                continue
            normal.normalize()
            geom = list(bm.verts) + list(bm.edges) + list(bm.faces)
            if not bm.faces:
                break
            ret = bmesh.ops.bisect_plane(
                bm, geom=geom, plane_co=mid, plane_no=normal,
                clear_outer=True, clear_inner=False,
            )
            cut_edges = [e for e in ret.get("geom_cut", []) if isinstance(e, bmesh.types.BMEdge)]
            if len(cut_edges) >= 3:
                filled = bmesh.ops.triangle_fill(bm, use_beauty=True, edges=cut_edges)
                for elem in filled.get("geom", []):
                    if isinstance(elem, bmesh.types.BMFace):
                        elem.material_index = len(hero.data.materials)

        if len(bm.faces) < 4 or len(bm.verts) < 4:
            bm.free()
            continue

        # Compute center of mass and recenter vertices so shard tumbles naturally!
        vcos = [v.co for v in bm.verts]
        com = sum(vcos, Vector((0, 0, 0))) / len(vcos)
        for v in bm.verts:
            v.co -= com

        s_min = Vector((min(v.co.x for v in bm.verts), min(v.co.y for v in bm.verts), min(v.co.z for v in bm.verts)))
        s_max = Vector((max(v.co.x for v in bm.verts), max(v.co.y for v in bm.verts), max(v.co.z for v in bm.verts)))
        s_dim = s_max - s_min
        approx_vol = max(0.02, s_dim.x * s_dim.y * s_dim.z * 0.5)
        mass = round(max(0.5, approx_vol * density), 2)

        mesh = bpy.data.meshes.new(f"SHARD_{idx+1:02d}_Mesh")
        bm.to_mesh(mesh)
        bm.free()
        for m in hero.data.materials:
            mesh.materials.append(m)
        mesh.materials.append(interior_mat)

        obj = bpy.data.objects.new(f"SHARD_{idx+1:02d}", mesh)
        obj.location = com
        bpy.context.collection.objects.link(obj)
        # Tag with real Angelo Game Physics (RIGID + mass)!
        if hasattr(obj, "angelo_physics"):
            obj.angelo_physics.body = "RIGID"
            obj.angelo_physics.mass = mass
        shards.append((obj, mass))

    base_bm.free()
    bpy.context.view_layer.update()
    return shards

def run_preflight_all():
    win = bpy.context.window_manager.windows[0]
    out = {}
    for tgt in ("WEB", "GODOT", "UNITY", "UNREAL"):
        res = engine_preflight.run(win, tgt)
        report = res[0] if isinstance(res, tuple) else res
        counts = report.get("counts") or {}
        findings = [
            {"severity": f.get("severity"), "code": f.get("code"), "title": f.get("title") or f.get("summary") or f.get("code")}
            for f in (report.get("findings") or [])[:5]
        ]
        out[tgt] = {"counts": counts, "findings": findings}
    return out


if mode == "inspect" and blend_in and os.path.exists(blend_in):
    bpy.ops.wm.open_mainfile(filepath=blend_in)
    objs = []
    for o in bpy.data.objects:
        if o.name.startswith("COLLIDER_") or "_Hull_" in o.name:
            continue
        info = {"name": o.name, "type": o.type, "location": [round(x, 3) for x in o.location]}
        if o.type == "MESH":
            info["faces"] = len(o.data.polygons)
            mats_info = []
            for m in o.data.materials:
                if not m: continue
                linked = []
                if m.node_tree:
                    bsdf = next((n for n in m.node_tree.nodes if n.type == "BSDF_PRINCIPLED"), None)
                    if bsdf:
                        linked = [inp.name for inp in bsdf.inputs if inp.is_linked]
                mats_info.append({"name": m.name, "linked_inputs": linked})
            info["materials"] = mats_info
            coords = [o.matrix_world @ v.co for v in o.data.vertices]
            if coords:
                info["bounds_min"] = [round(min(c.x for c in coords), 2), round(min(c.y for c in coords), 2), round(min(c.z for c in coords), 2)]
                info["bounds_max"] = [round(max(c.x for c in coords), 2), round(max(c.y for c in coords), 2), round(max(c.z for c in coords), 2)]
        objs.append(info)
    print("ANGELO_RESULT:" + json.dumps({"ok": True, "objects": objs, "animations": [a.name for a in bpy.data.actions]}))
    sys.exit(0)

asset_title = req.get("title") or "Hero Asset"
asset_source = req.get("source") or "Angelo Library"

if mode == "edit" and blend_in and os.path.exists(blend_in):
    bpy.ops.wm.open_mainfile(filepath=blend_in)
    hero = bpy.data.objects.get("HeroProp") or [o for o in bpy.data.objects if o.type == "MESH"][0]
    clear_existing_hulls(hero)
else:
    bpy.ops.wm.read_factory_settings(use_empty=True)
    if input_glb and os.path.exists(input_glb):
        model_file = input_glb
        asset_title = req.get("uploadName") or "Uploaded .glb"
        asset_source = "User Upload"
    else:
        base_url, cat = load_catalog()
        chosen = None
        if asset_id:
            for it in cat.items:
                if it.get("id") == asset_id:
                    chosen = it
                    break
        if chosen is None:
            hits, _ = cat.search(prompt or "ancient ruined arch", kind="model", limit=12)
            if not hits:
                raise RuntimeError(f"No 3D models found in Angelo Library for '{prompt}'")
            chosen = hits[0]
        asset_title = chosen.get("title", chosen["id"])
        asset_source = library_catalog.source_name(chosen.get("source", "")) or chosen.get("source", "Angelo Library")
        model_file = download_library_item(chosen, base_url)

    bpy.ops.import_scene.gltf(filepath=model_file)
    meshes = [o for o in bpy.data.objects if o.type == "MESH"]
    if not meshes:
        raise RuntimeError(f"Imported model '{asset_title}' contained no meshes")
    bpy.ops.object.select_all(action="DESELECT")
    for m in meshes:
        m.select_set(True)
    bpy.context.view_layer.objects.active = meshes[0]
    if len(meshes) > 1:
        bpy.ops.object.join()

    hero = bpy.context.active_object
    hero.name = "HeroProp"
    mw = hero.matrix_world.copy()
    hero.parent = None
    hero.matrix_world = mw
    bpy.context.view_layer.update()
    bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)

    coords = [v.co for v in hero.data.vertices]
    xs = [c.x for c in coords]; ys = [c.y for c in coords]; zs = [c.z for c in coords]
    cx, cy, min_z = (min(xs) + max(xs)) / 2.0, (min(ys) + max(ys)) / 2.0, min(zs)
    span = max(max(xs) - min(xs), max(ys) - min(ys), max(zs) - min(zs), 0.001)
    scale_f = 3.4 / span
    for v in hero.data.vertices:
        v.co.x = (v.co.x - cx) * scale_f
        v.co.y = (v.co.y - cy) * scale_f
        v.co.z = (v.co.z - min_z) * scale_f
    hero.data.update()
    bpy.context.view_layer.update()

before_faces = len(hero.data.polygons)
edit_summary = "Imported from Angelo Library"
retopo_facts = None
hull_method = "DECOMPOSE"
hull_max = 6

if mode == "edit":
    bpy.ops.object.select_all(action="DESELECT")
    hero.select_set(True)
    bpy.context.view_layer.objects.active = hero

    if edit_kind == "retopology":
        target_faces = int(edit_arg or 1500)
        bm_w = bmesh.new()
        bm_w.from_mesh(hero.data)
        bmesh.ops.remove_doubles(bm_w, verts=bm_w.verts, dist=0.004)
        bm_w.to_mesh(hero.data)
        bm_w.free()
        hero.data.update()
        bpy.context.view_layer.update()

        bpy.ops.object.retopology(target_faces=target_faces)
        retopo = bpy.context.active_object
        if retopo and retopo != hero:
            raw_facts = dict(retopo.get("_angelo_retopology", {}))
            retopo_facts = {
                "faces": raw_facts.get("faces"),
                "quadRatio": round(float(raw_facts.get("quad_ratio", 1.0)) * 100, 1),
                "deviationPct": round(float(raw_facts.get("hausdorff_max_of_size", 0.0)) * 100, 2),
                "ms": round(float(raw_facts.get("milliseconds", 0.0)), 1),
            }
            retopo.data.materials.clear()
            for m in hero.data.materials:
                retopo.data.materials.append(m)
            for p in retopo.data.polygons:
                p.use_smooth = False
            bpy.data.objects.remove(hero, do_unlink=True)
            retopo.name = "HeroProp"
            hero = retopo
            bpy.context.view_layer.update()
            edit_summary = f"Angelo C++ Retopology ({before_faces} → {retopo_facts['faces']} quads, {retopo_facts['deviationPct']}% dev, {retopo_facts['ms']}ms)"

    elif edit_kind == "fit_decompose":
        hull_method, hull_max = "DECOMPOSE", int(edit_arg or 6)
        edit_summary = f"Angelo Fit Collision Hulls (Decompose, up to {hull_max} hulls)"

    elif edit_kind == "fit_convex":
        hull_method, hull_max = "CONVEX", 1
        edit_summary = "Angelo Fit Collision Hulls (Single Convex Hull)"

    elif edit_kind == "preflight":
        edit_summary = "Angelo Engine-Contract Preflight (Web, Godot, Unity, Unreal)"

    elif edit_kind == "fracture":
        edit_summary = f"Fractured into breakable {edit_arg or 'stone'} rigid shards"

    elif edit_kind == "ai_script":
        script_path = req.get("scriptPath")
        if not script_path or not os.path.exists(script_path):
            raise RuntimeError("Missing AI script file")
        code_str = open(script_path, "r", encoding="utf-8").read()
        ns = {"bpy": bpy, "bmesh": bmesh, "math": math, "random": random, "hero": hero}
        exec(compile(code_str, script_path, "exec"), ns)
        bpy.context.view_layer.update()
        # Convert any newly added CURVE objects to MESH so glTF exports them cleanly
        for o in list(bpy.data.objects):
            if o.type == "CURVE":
                bpy.ops.object.select_all(action="DESELECT")
                o.select_set(True)
                bpy.context.view_layer.objects.active = o
                bpy.ops.object.convert(target="MESH")
        # Apply non-Armature modifiers on meshes so bevels/booleans/subsurf export to glTF
        for o in list(bpy.data.objects):
            if o.type == "MESH" and o.modifiers:
                bpy.ops.object.select_all(action="DESELECT")
                o.select_set(True)
                bpy.context.view_layer.objects.active = o
                for mod in list(o.modifiers):
                    if mod.type not in ("ARMATURE", "TENSION"):
                        try:
                            bpy.ops.object.modifier_apply(modifier=mod.name)
                        except Exception:
                            pass
        bpy.context.view_layer.update()
        hero = bpy.data.objects.get("HeroProp") or [o for o in bpy.data.objects if o.type == "MESH"][0]
        edit_summary = f"AI Edit: {prompt[:72]}"

# Save clean .blend snapshot before export-only hull mutations
if blend_out:
    bpy.ops.wm.save_as_mainfile(filepath=blend_out)

after_faces = len(hero.data.polygons)
quad_pct = round(100.0 * sum(1 for p in hero.data.polygons if len(p.vertices) == 4) / max(1, after_faces), 1)

hulls, hull_report = fit_hulls_for(hero, hull_method, hull_max) if do_hulls else ([], {})
preflight = run_preflight_all()


shard_count = 0
fracture_preset = None
if mode == "edit" and edit_kind == "fracture" and out_shards:
    fracture_preset = edit_arg or "stone"
    shards = generate_voronoi_shards(hero, preset=fracture_preset, count=10)
    shard_count = len(shards)
    edit_summary = f"Breakable ({fracture_preset}): {shard_count} rigid shards with interior caps & Angelo RIGID physics"
    # Export shards GLB (selection = shards only)
    bpy.ops.object.select_all(action="DESELECT")
    for s_obj, _m in shards:
        s_obj.select_set(True)
    if out_godot and hasattr(bpy.context.scene, "angelo_physics_format"):
        bpy.context.scene.angelo_physics_format = "GODOT_SUFFIXES"
        bpy.ops.export_scene.gltf(filepath=out_godot, export_format="GLB", use_selection=True, export_apply=True)
    if out_omi and hasattr(bpy.context.scene, "angelo_physics_format"):
        bpy.context.scene.angelo_physics_format = "OMI"
        bpy.ops.export_scene.gltf(filepath=out_omi, export_format="GLB", use_selection=True, export_apply=True)
    # Also export clean live shards GLB for browser rigid-body shatter
    for s_obj, _m in shards:
        if hasattr(s_obj, "angelo_physics"):
            s_obj.angelo_physics.body = "NONE"
    bpy.ops.export_scene.gltf(filepath=out_shards, export_format="GLB", use_selection=True, export_apply=True)
    # Remove shards from intact scene before exporting intact live GLB
    for s_obj, _m in shards:
        bpy.data.objects.remove(s_obj, do_unlink=True)
    bpy.context.view_layer.update()

# Export Godot (-colonly) (skip if fracture already exported rigid shards)
if out_godot and not shard_count:
    if hasattr(bpy.context.scene, "angelo_physics_format"):
        bpy.context.scene.angelo_physics_format = "GODOT_SUFFIXES"
    bpy.ops.export_scene.gltf(filepath=out_godot, export_format="GLB", export_animations=True, export_skins=True)

# Export Standard glTF (OMI_physics)
if out_omi and not shard_count:
    if hasattr(bpy.context.scene, "angelo_physics_format"):
        bpy.context.scene.angelo_physics_format = "OMI"
    bpy.ops.export_scene.gltf(filepath=out_omi, export_format="GLB", export_animations=True, export_skins=True)

# Export Live Three.js GLB (with COLLIDER_* hull nodes)
for idx, h in enumerate(hulls):
    h.name = f"COLLIDER_HeroProp_{idx+1}"
    h.angelo_physics.body = "NONE"
    if hasattr(h.angelo_physics, "collision_only"):
        h.angelo_physics.collision_only = False
    h.hide_render = False
    h.hide_viewport = False

bpy.ops.export_scene.gltf(filepath=out_live, export_format="GLB", export_animations=True, export_skins=True)

result = {
    "ok": True,
    "title": asset_title,
    "source": asset_source,
    "editSummary": edit_summary,
    "target": target,
    "beforeFaces": before_faces,
    "afterFaces": after_faces,
    "quadPct": quad_pct,
    "hullCount": len(hulls),
    "hullMethod": hull_method,
    "retopoFacts": retopo_facts,
    "shardCount": shard_count,
    "fracturePreset": fracture_preset,
    "animationCount": len(bpy.data.actions),
    "preflight": preflight,
    "elapsedMs": round((time.time() - t0) * 1000),
}
print("ANGELO_RESULT:" + json.dumps(result))
