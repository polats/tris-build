extends SceneTree

# Ephemeral Godot 4.3+ screenshot + telemetry harness for `tris-shot`.
# Invoked via: godot --path <project> --script /path/to/tris-shot-harness.gd -- --tris-out=...

var _out_path: String = ""
var _metrics_path: String = ""
var _scene_path: String = ""
var _target_frames: int = 12
var _min_wait_sec: float = 0.0
var _strip_count: int = 1
var _strip_interval_frames: int = 8
var _inputs: Array = []

var _frame: int = 0
var _elapsed: float = 0.0
var _frame_ms: Array[float] = []
var _captured_images: Array[Image] = []
var _next_capture_frame: int = 0
var _capturing: bool = false
var _done: bool = false
var _start_error: String = ""
var _active_inputs: Dictionary = {}

func _initialize() -> void:
	_parse_args()
	if _out_path.is_empty():
		_fail("Missing --tris-out=<path>")
		return

	if _scene_path.is_empty():
		_scene_path = str(ProjectSettings.get_setting("application/run/main_scene", ""))
	if _scene_path.is_empty():
		_fail("No scene specified and application/run/main_scene is empty")
		return

	_load_autoloads()

	var packed := ResourceLoader.load(_scene_path)
	if packed == null:
		_fail("Failed to load scene: " + _scene_path)
		return

	var instance: Node = null
	if packed is PackedScene:
		instance = packed.instantiate()
	elif packed is Script:
		instance = packed.new()
	else:
		_fail("Unsupported scene resource type: " + _scene_path)
		return

	if instance == null:
		_fail("Failed to instantiate scene: " + _scene_path)
		return

	root.add_child(instance)
	current_scene = instance
	_next_capture_frame = max(2, _target_frames)

func _parse_args() -> void:
	for arg in OS.get_cmdline_user_args():
		if arg.begins_with("--tris-out="):
			_out_path = arg.substr("--tris-out=".length())
		elif arg.begins_with("--tris-metrics="):
			_metrics_path = arg.substr("--tris-metrics=".length())
		elif arg.begins_with("--tris-scene="):
			_scene_path = arg.substr("--tris-scene=".length())
		elif arg.begins_with("--tris-frames="):
			_target_frames = max(1, int(arg.substr("--tris-frames=".length())))
		elif arg.begins_with("--tris-wait="):
			_min_wait_sec = max(0.0, float(arg.substr("--tris-wait=".length())))
		elif arg.begins_with("--tris-strip="):
			_strip_count = max(1, int(arg.substr("--tris-strip=".length())))
		elif arg.begins_with("--tris-interval-frames="):
			_strip_interval_frames = max(1, int(arg.substr("--tris-interval-frames=".length())))
		elif arg.begins_with("--tris-input="):
			_parse_inputs(arg.substr("--tris-input=".length()))

func _parse_inputs(raw: String) -> void:
	# Format: action:start_sec:duration_sec,action2:start_sec:duration_sec
	for entry in raw.split(",", false):
		var parts := entry.split(":")
		if parts.size() >= 1 and not parts[0].is_empty():
			var action := parts[0].strip_edges()
			var start_t := float(parts[1]) if parts.size() >= 2 else 0.0
			var dur_t := float(parts[2]) if parts.size() >= 3 else 0.25
			_inputs.append({ "action": action, "start": start_t, "end": start_t + dur_t })

func _load_autoloads() -> void:
	for prop in ProjectSettings.get_property_list():
		var prop_name: String = prop["name"]
		if not prop_name.begins_with("autoload/"):
			continue
		var autoload_name := prop_name.substr("autoload/".length())
		var raw_val := str(ProjectSettings.get_setting(prop_name, ""))
		if not raw_val.begins_with("*"):
			continue
		var res_path := raw_val.substr(1)
		if root.has_node(autoload_name):
			continue
		var res := ResourceLoader.load(res_path)
		if res == null:
			push_warning("tris-shot: could not load autoload " + autoload_name + " (" + res_path + ")")
			continue
		var node: Node = null
		if res is PackedScene:
			node = res.instantiate()
		elif res is Script:
			var obj = res.new()
			if obj is Node:
				node = obj
		if node != null:
			node.name = autoload_name
			root.add_child(node)

func _update_inputs() -> void:
	for item in _inputs:
		var action: String = item["action"]
		var should_press: bool = _elapsed >= item["start"] and _elapsed < item["end"]
		var is_pressed: bool = _active_inputs.get(action, false)
		if should_press and not is_pressed:
			if InputMap.has_action(action):
				Input.action_press(action)
			_active_inputs[action] = true
		elif not should_press and is_pressed:
			if InputMap.has_action(action):
				Input.action_release(action)
			_active_inputs[action] = false

func _process(delta: float) -> bool:
	if _done:
		return true

	_frame += 1
	_elapsed += delta
	if _frame > 1:
		_frame_ms.append(delta * 1000.0)

	_update_inputs()

	if _capturing:
		return false

	if _frame >= _next_capture_frame and _elapsed >= _min_wait_sec:
		_capturing = true
		_capture_frame()

	return false

func _capture_frame() -> void:
	await RenderingServer.frame_post_draw
	var tex := root.get_texture()
	if tex == null:
		_fail("Viewport texture is null (is Godot running with a real rendering driver?)")
		return
	var img := tex.get_image()
	if img == null or img.is_empty():
		_fail("Captured image is empty")
		return

	_captured_images.append(img)

	if _captured_images.size() < _strip_count:
		_next_capture_frame = _frame + _strip_interval_frames
		_capturing = false
		return

	var final_img: Image = _captured_images[0]
	if _captured_images.size() > 1:
		var fw := final_img.get_width()
		var fh := final_img.get_height()
		var strip := Image.create_empty(fw * _captured_images.size(), fh, false, Image.FORMAT_RGBA8)
		for i in range(_captured_images.size()):
			var sub := _captured_images[i]
			if sub.get_format() != Image.FORMAT_RGBA8:
				sub.convert(Image.FORMAT_RGBA8)
			strip.blit_rect(sub, Rect2i(0, 0, fw, fh), Vector2i(i * fw, 0))
		final_img = strip

	var err := final_img.save_png(_out_path)
	if err != OK:
		_fail("Failed to save PNG to " + _out_path + " (code " + str(err) + ")")
		return

	_write_metrics(true, final_img.get_width(), final_img.get_height(), "")
	_done = true
	quit(0)

func _write_metrics(ok: bool, width: int, height: int, error_msg: String) -> void:
	if _metrics_path.is_empty():
		return
	var avg_ms := 0.0
	var min_ms := 0.0
	var max_ms := 0.0
	if _frame_ms.size() > 0:
		var total := 0.0
		min_ms = _frame_ms[0]
		max_ms = _frame_ms[0]
		for v in _frame_ms:
			total += v
			if v < min_ms:
				min_ms = v
			if v > max_ms:
				max_ms = v
		avg_ms = total / float(_frame_ms.size())

	var payload := {
		"ok": ok,
		"scene": _scene_path,
		"width": width,
		"height": height,
		"frames_rendered": _frame,
		"strip_frames": _captured_images.size(),
		"elapsed_sec": snappedf(_elapsed, 0.001),
		"avg_frame_ms": snappedf(avg_ms, 0.01),
		"min_frame_ms": snappedf(min_ms, 0.01),
		"max_frame_ms": snappedf(max_ms, 0.01),
		"image_path": _out_path,
		"error": error_msg,
	}
	var f := FileAccess.open(_metrics_path, FileAccess.WRITE)
	if f != null:
		f.store_string(JSON.stringify(payload, "  ") + "\n")
		f.close()

func _fail(msg: String) -> void:
	_start_error = msg
	printerr("TRIS_SHOT_ERROR: " + msg)
	_write_metrics(false, 0, 0, msg)
	_done = true
	quit(1)
