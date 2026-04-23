import json
import os
import shutil
import time
from pathlib import Path

from flask import Flask, render_template, request, jsonify, Response
import requests

BASE_DIR = Path(__file__).parent
NOVELS_DIR = BASE_DIR / "novels"
PROMPTS_DIR = BASE_DIR / "prompts"
CONFIG_PATH = BASE_DIR / "config.json"
FILE_REPO_DIR = None  # set from config on startup

app = Flask(__name__)
app.config["SEND_FILE_MAX_AGE_DEFAULT"] = 0


def load_config():
    with open(CONFIG_PATH, "r", encoding="utf-8") as f:
        return json.load(f)


def save_config(cfg):
    with open(CONFIG_PATH, "w", encoding="utf-8") as f:
        json.dump(cfg, f, ensure_ascii=False, indent=4)


def novel_dir(name):
    return NOVELS_DIR / name


# ── Pages ──

@app.route("/")
def index():
    return render_template("index.html", cache_bust=int(time.time()))


# ── Config ──

@app.route("/api/config", methods=["GET", "PUT"])
def api_config():
    if request.method == "GET":
        return jsonify(load_config())
    cfg = load_config()
    cfg.update(request.json)
    save_config(cfg)
    return jsonify(cfg)


# ── Novels CRUD ──

@app.route("/api/novels", methods=["GET"])
def list_novels():
    NOVELS_DIR.mkdir(exist_ok=True)
    novels = []
    for d in NOVELS_DIR.iterdir():
        if d.is_dir():
            meta_path = d / "meta.json"
            if meta_path.exists():
                with open(meta_path, "r", encoding="utf-8") as f:
                    meta = json.load(f)
                    if "order" not in meta:
                        meta["order"] = 999
                    novels.append(meta)
    novels.sort(key=lambda n: n["order"])
    return jsonify(novels)


@app.route("/api/novels", methods=["POST"])
def create_novel():
    data = request.json
    name = data["name"].strip()
    nd = novel_dir(name)
    if nd.exists():
        return jsonify({"error": "小说已存在"}), 400
    nd.mkdir(parents=True)
    (nd / "chapters").mkdir()
    # Assign next order number
    max_order = 0
    for d in NOVELS_DIR.iterdir():
        if d.is_dir():
            mp = d / "meta.json"
            if mp.exists():
                with open(mp, "r", encoding="utf-8") as f2:
                    m = json.load(f2)
                    max_order = max(max_order, m.get("order", 0))
    meta = {"name": name, "order": max_order + 1, "volumes": [{"title": "第一卷", "chapters": [{"title": "第一章"}]}]}
    with open(nd / "meta.json", "w", encoding="utf-8") as f:
        json.dump(meta, f, ensure_ascii=False, indent=2)
    prompts = {"system_prompt": ""}
    with open(nd / "prompts.json", "w", encoding="utf-8") as f:
        json.dump(prompts, f, ensure_ascii=False, indent=2)
    # Create first chapter file
    (nd / "chapters" / "0_0.md").write_text("", encoding="utf-8")
    return jsonify(meta), 201


@app.route("/api/novels/reorder", methods=["POST"])
def reorder_novels():
    """Receive ordered list of novel names, update their order field."""
    names = request.json.get("names", [])
    for i, name in enumerate(names):
        nd = novel_dir(name)
        meta_path = nd / "meta.json"
        if meta_path.exists():
            with open(meta_path, "r", encoding="utf-8") as f:
                meta = json.load(f)
            meta["order"] = i
            with open(meta_path, "w", encoding="utf-8") as f:
                json.dump(meta, f, ensure_ascii=False, indent=2)
    return jsonify({"ok": True})


@app.route("/api/novels/<name>/rename", methods=["POST"])
def rename_novel(name):
    new_name = request.json.get("new_name", "").strip()
    print(f"[DEBUG] rename: '{name}' -> '{new_name}', old_dir exists: {novel_dir(name).exists()}")
    if not new_name:
        return jsonify({"error": "名称不能为空"}), 400
    old_dir = novel_dir(name)
    new_dir = novel_dir(new_name)
    if new_dir.exists():
        return jsonify({"error": "该名称已存在"}), 400
    if not old_dir.exists():
        return jsonify({"error": "小说不存在"}), 404
    shutil.move(str(old_dir), str(new_dir))
    # Update meta.json
    meta_path = new_dir / "meta.json"
    with open(meta_path, "r", encoding="utf-8") as f:
        meta = json.load(f)
    meta["name"] = new_name
    with open(meta_path, "w", encoding="utf-8") as f:
        json.dump(meta, f, ensure_ascii=False, indent=2)
    return jsonify({"ok": True})


@app.route("/api/novels/<name>", methods=["DELETE"])
def delete_novel(name):
    nd = novel_dir(name)
    if nd.exists():
        shutil.rmtree(nd)
    return jsonify({"ok": True})


# ── Structure ──

@app.route("/api/novels/<name>/structure", methods=["GET", "PUT"])
def novel_structure(name):
    nd = novel_dir(name)
    meta_path = nd / "meta.json"
    if request.method == "GET":
        with open(meta_path, "r", encoding="utf-8") as f:
            return jsonify(json.load(f))
    data = request.json
    with open(meta_path, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
    return jsonify(data)


# ── Chapters ──

@app.route("/api/novels/<name>/chapter/<int:vol>/<int:chap>", methods=["GET", "PUT"])
def chapter(name, vol, chap):
    nd = novel_dir(name)
    path = nd / "chapters" / f"{vol}_{chap}.md"
    if request.method == "GET":
        content = path.read_text(encoding="utf-8") if path.exists() else ""
        return jsonify({"content": content})
    content = request.json.get("content", "")
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content, encoding="utf-8")
    return jsonify({"ok": True})


# ── Prompts ──

@app.route("/api/novels/<name>/prompts", methods=["GET", "PUT"])
def prompts(name):
    nd = novel_dir(name)
    path = nd / "prompts.json"
    if request.method == "GET":
        if path.exists():
            with open(path, "r", encoding="utf-8") as f:
                return jsonify(json.load(f))
        return jsonify({"system_prompt": ""})
    data = request.json
    with open(path, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
    return jsonify(data)


# ── Prompt Sets CRUD ──

def prompt_set_dir(name):
    return PROMPTS_DIR / name


def migrate_prompt_set(d, meta):
    """Migrate old formats and ensure built-in items exist."""
    changed = False
    # Migrate old categories-based format to flat items
    if "categories" in meta and "items" not in meta:
        new_items = []
        items_dir = d / "items"
        items_dir.mkdir(exist_ok=True)
        idx = 0
        for ci, cat in enumerate(meta.get("categories", [])):
            for ii, it in enumerate(cat.get("items", [])):
                old_path = items_dir / f"{ci}_{ii}.md"
                new_path = items_dir / f"{idx}.md"
                if old_path.exists() and not new_path.exists():
                    shutil.copy2(str(old_path), str(new_path))
                new_items.append({"title": it["title"], "mode": "fixed", "enabled": True})
                idx += 1
        meta["items"] = new_items
        del meta["categories"]
        changed = True

    # Ensure built-in items exist
    items = meta.get("items", [])
    has_chapter = any(it.get("mode") == "chapter" for it in items)
    has_reference = any(it.get("mode") == "reference" for it in items)
    has_context = any(it.get("mode") == "context" for it in items)
    if not has_chapter:
        ctx_idx = next((i for i, it in enumerate(items) if it.get("mode") == "context"), len(items))
        items.insert(ctx_idx, {"title": "当前章节", "mode": "chapter", "enabled": True})
        changed = True
    if not has_reference:
        # Insert after chapter, before context
        chap_idx = next((i for i, it in enumerate(items) if it.get("mode") == "chapter"), -1)
        insert_at = chap_idx + 1 if chap_idx >= 0 else len(items)
        items.insert(insert_at, {"title": "参考章节", "mode": "reference", "enabled": True, "chapters": []})
        changed = True
    has_catalog = any(it.get("mode") == "catalog" for it in items)
    if not has_catalog:
        ctx_idx = next((i for i, it in enumerate(items) if it.get("mode") == "context"), len(items))
        items.insert(ctx_idx, {"title": "章节目录", "mode": "catalog", "enabled": True})
        changed = True
    has_read_hint = any(it.get("mode") == "read_hint" for it in items)
    if not has_read_hint:
        cat_idx = next((i for i, it in enumerate(items) if it.get("mode") == "catalog"), len(items))
        items.insert(cat_idx, {"title": "读取指令说明", "mode": "read_hint", "enabled": True})
        changed = True
    if not has_context:
        items.append({"title": "上下文", "mode": "context", "enabled": True})
        changed = True
    meta["items"] = items

    if changed:
        with open(d / "meta.json", "w", encoding="utf-8") as f:
            json.dump(meta, f, ensure_ascii=False, indent=2)
    return meta


@app.route("/api/prompt-sets", methods=["GET"])
def list_prompt_sets():
    PROMPTS_DIR.mkdir(exist_ok=True)
    sets = []
    for d in PROMPTS_DIR.iterdir():
        if d.is_dir():
            meta_path = d / "meta.json"
            if meta_path.exists():
                with open(meta_path, "r", encoding="utf-8") as f:
                    meta = json.load(f)
                meta = migrate_prompt_set(d, meta)
                if "order" not in meta:
                    meta["order"] = 999
                sets.append(meta)
    sets.sort(key=lambda s: s["order"])
    return jsonify(sets)


@app.route("/api/prompt-sets", methods=["POST"])
def create_prompt_set():
    data = request.json
    name = data["name"].strip()
    d = prompt_set_dir(name)
    if d.exists():
        return jsonify({"error": "提示词集已存在"}), 400
    d.mkdir(parents=True)
    (d / "items").mkdir()
    max_order = 0
    for sd in PROMPTS_DIR.iterdir():
        if sd.is_dir():
            mp = sd / "meta.json"
            if mp.exists():
                with open(mp, "r", encoding="utf-8") as f2:
                    m = json.load(f2)
                    max_order = max(max_order, m.get("order", 0))
    meta = {
        "name": name,
        "order": max_order + 1,
        "items": [
            {"title": "系统提示词", "mode": "fixed", "enabled": True},
            {"title": "当前章节", "mode": "chapter", "enabled": True},
            {"title": "参考章节", "mode": "reference", "enabled": True, "chapters": []},
            {"title": "读取指令说明", "mode": "read_hint", "enabled": True},
            {"title": "章节目录", "mode": "catalog", "enabled": True},
            {"title": "上下文", "mode": "context", "enabled": True},
        ],
    }
    with open(d / "meta.json", "w", encoding="utf-8") as f:
        json.dump(meta, f, ensure_ascii=False, indent=2)
    (d / "items" / "0.md").write_text("", encoding="utf-8")
    return jsonify(meta), 201


@app.route("/api/prompt-sets/<name>", methods=["DELETE"])
def delete_prompt_set(name):
    d = prompt_set_dir(name)
    if d.exists():
        shutil.rmtree(d)
    return jsonify({"ok": True})


@app.route("/api/prompt-sets/<name>/rename", methods=["POST"])
def rename_prompt_set(name):
    new_name = request.json.get("new_name", "").strip()
    if not new_name:
        return jsonify({"error": "名称不能为空"}), 400
    old_dir = prompt_set_dir(name)
    new_dir = prompt_set_dir(new_name)
    if new_dir.exists():
        return jsonify({"error": "该名称已存在"}), 400
    if not old_dir.exists():
        return jsonify({"error": "提示词集不存在"}), 404
    shutil.move(str(old_dir), str(new_dir))
    meta_path = new_dir / "meta.json"
    with open(meta_path, "r", encoding="utf-8") as f:
        meta = json.load(f)
    meta["name"] = new_name
    with open(meta_path, "w", encoding="utf-8") as f:
        json.dump(meta, f, ensure_ascii=False, indent=2)
    return jsonify({"ok": True})


@app.route("/api/prompt-sets/reorder", methods=["POST"])
def reorder_prompt_sets():
    names = request.json.get("names", [])
    for i, name in enumerate(names):
        d = prompt_set_dir(name)
        meta_path = d / "meta.json"
        if meta_path.exists():
            with open(meta_path, "r", encoding="utf-8") as f:
                meta = json.load(f)
            meta["order"] = i
            with open(meta_path, "w", encoding="utf-8") as f:
                json.dump(meta, f, ensure_ascii=False, indent=2)
    return jsonify({"ok": True})


@app.route("/api/prompt-sets/<name>/structure", methods=["GET", "PUT"])
def prompt_set_structure(name):
    d = prompt_set_dir(name)
    meta_path = d / "meta.json"
    if request.method == "GET":
        with open(meta_path, "r", encoding="utf-8") as f:
            return jsonify(json.load(f))
    data = request.json
    with open(meta_path, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
    return jsonify(data)


@app.route("/api/prompt-sets/<name>/item/<int:idx>", methods=["GET", "PUT"])
def prompt_set_item(name, idx):
    d = prompt_set_dir(name)
    path = d / "items" / f"{idx}.md"
    if request.method == "GET":
        content = path.read_text(encoding="utf-8") if path.exists() else ""
        return jsonify({"content": content})
    content = request.json.get("content", "")
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content, encoding="utf-8")
    return jsonify({"ok": True})


@app.route("/api/prompt-sets/<name>/all-items", methods=["GET"])
def prompt_set_all_items(name):
    """Return all enabled items in order for injection into AI."""
    d = prompt_set_dir(name)
    meta_path = d / "meta.json"
    if not meta_path.exists():
        return jsonify({"items": []})
    with open(meta_path, "r", encoding="utf-8") as f:
        meta = json.load(f)
    items = []
    for i, it in enumerate(meta.get("items", [])):
        if not it.get("enabled", True):
            continue
        mode = it.get("mode", "fixed")
        if mode in ("context", "chapter", "catalog", "read_hint"):
            items.append({"idx": i, "title": it["title"], "mode": mode, "content": "", "chars": 0})
        elif mode == "reference":
            chapters = it.get("chapters", [])
            items.append({"idx": i, "title": it["title"], "mode": mode, "content": "", "chapters": chapters, "chars": len(chapters)})
        else:
            path = d / "items" / f"{i}.md"
            content = path.read_text(encoding="utf-8") if path.exists() else ""
            items.append({"idx": i, "title": it["title"], "mode": mode, "content": content, "chars": len(content)})
    return jsonify({"items": items})


@app.route("/api/prompt-sets/<name>/ai-update", methods=["POST"])
def prompt_set_ai_update(name):
    """AI auto-update: write content to specific items by title."""
    d = prompt_set_dir(name)
    meta_path = d / "meta.json"
    if not meta_path.exists():
        return jsonify({"error": "提示词集不存在"}), 404
    with open(meta_path, "r", encoding="utf-8") as f:
        meta = json.load(f)
    updates = request.json.get("updates", [])  # [{title, content}]
    updated = []
    for upd in updates:
        title = upd.get("title", "")
        content = upd.get("content", "")
        for i, it in enumerate(meta.get("items", [])):
            if it["title"] == title and it.get("mode") == "ai_editable":
                path = d / "items" / f"{i}.md"
                path.write_text(content, encoding="utf-8")
                updated.append(title)
                break
    return jsonify({"updated": updated})


# ── Read chapter for AI directive ──

def read_chapter_content(novel_name, vol, chap):
    """Read a chapter's content by novel name, vol index, chap index."""
    nd = novel_dir(novel_name)
    path = nd / "chapters" / f"{vol}_{chap}.md"
    if path.exists():
        content = path.read_text(encoding="utf-8")
        return content if content else "(章节内容为空)"
    return f"(未找到章节: {novel_name} 卷{vol} 章{chap})"


# ── File Repo ──

def get_file_repo_dir():
    cfg = load_config()
    repo = cfg.get("file_repo_dir", "")
    if not repo:
        return None
    p = Path(repo)
    if not p.is_absolute():
        p = BASE_DIR / p
    return p if p.exists() else None


@app.route("/api/file-repo/tree", methods=["GET"])
def file_repo_tree():
    repo_dir = get_file_repo_dir()
    if not repo_dir:
        return jsonify({"tree": "", "root": ""})
    lines = []
    for f in sorted(repo_dir.rglob("*")):
        if f.is_file():
            rel = f.relative_to(repo_dir)
            lines.append(str(rel))
    return jsonify({"tree": "\n".join(lines), "root": str(repo_dir)})


def read_repo_file(rel_path):
    repo_dir = get_file_repo_dir()
    if not repo_dir:
        return "(文件仓库未配置)"
    target = (repo_dir / rel_path).resolve()
    # Security: must be under repo_dir
    if not str(target).startswith(str(repo_dir.resolve())):
        return "(路径不合法)"
    if not target.exists():
        return f"(未找到文件: {rel_path})"
    try:
        content = target.read_text(encoding="utf-8")
        if len(content) > 10000:
            content = content[:10000] + f"\n...(文件过长，已截断，共{len(content)}字)"
        return content
    except Exception as e:
        return f"(读取失败: {e})"


# ── AI Chat (streaming, with <<<READ:>>> agent loop) ──

@app.route("/api/chat", methods=["POST"])
def chat():
    cfg = load_config()
    data = request.json
    messages = data.get("messages", [])

    system_content = data.get("system_content", "")
    if system_content:
        system_msg = system_content
    else:
        system_msg = cfg.get("default_system_prompt", "")

    all_messages = [{"role": "system", "content": system_msg}] + messages if system_msg else list(messages)

    model = cfg.get("model", "claude-sonnet-4-20250514")
    api_headers = {"Content-Type": "application/json"}
    api_key = cfg.get("api_key", "")
    if api_key:
        api_headers["Authorization"] = f"Bearer {api_key}"

    import re
    READ_RE = re.compile(r'<<<READ:([^/]+)/(\d+)/(\d+)>>>')
    FILE_RE = re.compile(r'<<<FILE:(.*?)>>>')

    print(f"[DEBUG] system_len: {len(system_msg)}, messages: {len(messages)}")

    def do_stream(msgs):
        """Stream a single request, return full content text and yield SSE chunks."""
        payload = {"model": model, "messages": msgs, "stream": True}
        resp = requests.post(cfg["api_url"], json=payload, headers=api_headers, stream=True, timeout=120)
        resp.raise_for_status()
        resp.encoding = "utf-8"
        buf = b""
        full_content = []
        for chunk in resp.iter_content(chunk_size=None):
            buf += chunk
            while b"\n" in buf:
                line_bytes, buf = buf.split(b"\n", 1)
                line = line_bytes.decode("utf-8", errors="replace").strip()
                if line.startswith("data: ") and line != "data: [DONE]":
                    try:
                        obj = json.loads(line[6:])
                        delta = obj.get("choices", [{}])[0].get("delta", {}).get("content", "")
                        if delta:
                            full_content.append(delta)
                    except json.JSONDecodeError:
                        pass
                    yield ("sse", line + "\n\n")
        if buf.strip():
            line = buf.decode("utf-8", errors="replace").strip()
            if line.startswith("data: ") and line != "data: [DONE]":
                try:
                    obj = json.loads(line[6:])
                    delta = obj.get("choices", [{}])[0].get("delta", {}).get("content", "")
                    if delta:
                        full_content.append(delta)
                except json.JSONDecodeError:
                    pass
                yield ("sse", line + "\n\n")
        yield ("done", "".join(full_content))

    def generate():
        nonlocal all_messages
        max_read_rounds = 5

        for round_i in range(max_read_rounds + 1):
            full_text = ""
            try:
                for tag, data in do_stream(all_messages):
                    if tag == "sse":
                        yield data
                    elif tag == "done":
                        full_text = data
            except Exception as e:
                err = json.dumps({"error": str(e)}, ensure_ascii=False)
                yield f"data: {err}\n\n"
                return

            # Check for <<<READ:novel/vol/chap>>> and <<<FILE:path>>> directives
            reads = READ_RE.findall(full_text)
            file_reads = FILE_RE.findall(full_text)
            if (not reads and not file_reads) or round_i >= max_read_rounds:
                yield "data: [DONE]\n\n"
                return

            # AI wants to read — fetch and continue
            all_messages.append({"role": "assistant", "content": full_text})

            read_results = []
            for novel_name, vol_s, chap_s in reads:
                content = read_chapter_content(novel_name.strip(), int(vol_s), int(chap_s))
                read_results.append(f"[{novel_name} 卷{vol_s} 章{chap_s}]:\n{content}")

            for rel_path in file_reads:
                content = read_repo_file(rel_path.strip())
                read_results.append(f"[文件: {rel_path.strip()}]:\n{content}")

            total = len(reads) + len(file_reads)
            all_messages.append({
                "role": "user",
                "content": "以下是你请求阅读的内容：\n\n" + "\n\n---\n\n".join(read_results) + "\n\n请继续。"
            })

            # Notify frontend
            info = json.dumps({"choices": [{"delta": {"content": f"\n\n[📖 已读取 {total} 项内容，继续生成...]\n\n"}}]}, ensure_ascii=False)
            yield f"data: {info}\n\n"

    return Response(generate(), mimetype="text/event-stream; charset=utf-8")


if __name__ == "__main__":
    NOVELS_DIR.mkdir(exist_ok=True)
    PROMPTS_DIR.mkdir(exist_ok=True)
    cfg = load_config()
    print(f"NovelForge 启动: http://localhost:{cfg.get('port', 5000)}")
    extra_files = []
    for ext in ("*.html", "*.js", "*.css"):
        extra_files.extend(str(p) for p in BASE_DIR.rglob(ext))
    app.run(host="0.0.0.0", port=cfg.get("port", 5000), debug=True,
            extra_files=extra_files)
