import json
import os
import re
import shutil
import threading
import time
import uuid
from collections import defaultdict
from pathlib import Path

from flask import Flask, render_template, request, jsonify, Response
import requests

BASE_DIR = Path(__file__).parent
NOVELS_DIR = BASE_DIR / "novels"
PROMPTS_DIR = BASE_DIR / "prompts"
CONFIG_PATH = BASE_DIR / "config.json"
FILE_REPO_DIR = None  # set from config on startup

# ── Mailbox ──
MAILBOX_DIR = BASE_DIR.parent / "mailbox"
MAILBOX_INBOX = MAILBOX_DIR / "inbox"
MAILBOX_OUTBOX = MAILBOX_DIR / "outbox"
MAILBOX_ARCHIVE = MAILBOX_DIR / "archive"

ASK_RE = re.compile(r'<<<ASK_AGENT:(.*?)>>>', re.DOTALL)


# ── 消息后处理：移植自 SillyTavern src/prompt-converters.js mergeMessages ──
# 8 种模式对应 7 种处理 + 1 种"原样不动"（none）。覆盖各家 API 的 role 排列约束：
#   merge / merge_tools         合并相同角色连续发言（system 可在任意位置）
#   semi  / semi_tools          merge + 非首条 system 强制变 user（DeepSeek 等）
#   strict / strict_tools       semi + 强制 user 先于 assistant（Perplexity 等）
#   single                      所有消息塞成一条 user（最严格的 API 兜底）
# _tools 后缀变体保留 tool_calls / tool_call_id / role:"tool"；非 _tools 删掉这些
PROMPT_PLACEHOLDER = "Let's get started."


def merge_messages(messages, *, strict=False, placeholders=False, single=False, tools=False):
    """忠实移植 SillyTavern mergeMessages。

    Args:
        strict      非首条 system → user
        placeholders strict 时若首条非 user，前面塞一条 user 占位
        single      所有 role → user，全部合并成一条
        tools       True 保留 tool_calls / tool_call_id / role:tool；False 删除并把 role:tool 转 user
    """
    if not messages:
        return messages

    # 第一阶段：每条消息预处理（content 扁平化、role 转换、字段清理）
    processed = []
    for src in messages:
        m = dict(src)
        content = m.get('content', '') or ''
        # 多模态 content 数组扁平化（NovelForge 当前无多模态，但保留兼容）
        if isinstance(content, list):
            content = '\n\n'.join(
                c.get('text', '') for c in content
                if isinstance(c, dict) and c.get('type') == 'text'
            )
        m['content'] = content
        if m.get('role') == 'tool' and not tools:
            m['role'] = 'user'
        if single:
            m['role'] = 'user'
        if not tools:
            m.pop('tool_calls', None)
            m.pop('tool_call_id', None)
        m.pop('name', None)
        processed.append(m)

    # 第二阶段：合并连续同角色
    merged = []
    for m in processed:
        role = m.get('role')
        content = m.get('content', '') or ''
        if merged and merged[-1].get('role') == role and content and role != 'tool':
            merged[-1]['content'] = merged[-1]['content'] + '\n\n' + content
        else:
            merged.append(m)

    if not merged:
        merged.append({'role': 'user', 'content': PROMPT_PLACEHOLDER})

    # 第三阶段：strict 模式——强制角色重排 + 占位插入 + 递归再合并一次
    if strict:
        for i in range(1, len(merged)):
            if merged[i].get('role') == 'system':
                merged[i]['role'] = 'user'
        if placeholders and merged:
            if merged[0].get('role') == 'system' and (len(merged) == 1 or merged[1].get('role') != 'user'):
                merged.insert(1, {'role': 'user', 'content': PROMPT_PLACEHOLDER})
            elif merged[0].get('role') != 'system' and merged[0].get('role') != 'user':
                merged.insert(0, {'role': 'user', 'content': PROMPT_PLACEHOLDER})
        # role 改完之后可能又有连续同角色，再合并一遍（递归 strict=False 走第二阶段）
        return merge_messages(merged, strict=False, placeholders=placeholders, single=False, tools=tools)

    return merged


def post_process_messages(messages, mode):
    """根据 mode 字符串分发到对应的 merge_messages 配置。"""
    # 历史别名兼容（早期版本用过 'merge_semi'）
    if mode == 'merge_semi':
        mode = 'semi_tools'
    table = {
        'merge':        dict(strict=False, placeholders=False, single=False, tools=False),
        'merge_tools':  dict(strict=False, placeholders=False, single=False, tools=True),
        'semi':         dict(strict=True,  placeholders=False, single=False, tools=False),
        'semi_tools':   dict(strict=True,  placeholders=False, single=False, tools=True),
        'strict':       dict(strict=True,  placeholders=True,  single=False, tools=False),
        'strict_tools': dict(strict=True,  placeholders=True,  single=False, tools=True),
        'single':       dict(strict=True,  placeholders=False, single=True,  tools=False),
    }
    opts = table.get(mode)
    if not opts:
        return messages  # 'none' 或未知 → 原样返回
    return merge_messages(messages, **opts)


def mailbox_send(action, payload):
    """Write a message to mailbox inbox, return msg_id."""
    msg_id = f"msg_{int(time.time()*1000)}_{uuid.uuid4().hex[:8]}"
    msg = {
        "id": msg_id,
        "type": "request",
        "action": action,
        "payload": payload,
        "created_at": time.strftime("%Y-%m-%dT%H:%M:%S"),
        "status": "pending"
    }
    MAILBOX_INBOX.mkdir(parents=True, exist_ok=True)
    (MAILBOX_INBOX / f"{msg_id}.json").write_text(
        json.dumps(msg, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    return msg_id


def poll_mailbox_reply(msg_id, timeout=120):
    """Poll outbox for a reply to msg_id. Returns reply content or timeout message."""
    deadline = time.time() + timeout
    while time.time() < deadline:
        if MAILBOX_OUTBOX.exists():
            for f in MAILBOX_OUTBOX.iterdir():
                if f.suffix == ".json":
                    try:
                        data = json.loads(f.read_text(encoding="utf-8"))
                        if data.get("reply_to") == msg_id:
                            content = data.get("payload", {}).get("content", "")
                            MAILBOX_ARCHIVE.mkdir(parents=True, exist_ok=True)
                            shutil.move(str(f), str(MAILBOX_ARCHIVE / f.name))
                            return content
                    except (json.JSONDecodeError, OSError):
                        continue
        time.sleep(2)
    return "(Agent未在规定时间内回复)"

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
    has_latest_input = any(it.get("mode") == "latest_input" for it in items)
    if not has_latest_input:
        items.append({"title": "用户最新发言", "mode": "latest_input", "enabled": True})
        changed = True
    has_file_repo = any(it.get("mode") == "file_repo" for it in items)
    if not has_file_repo:
        # 默认禁用，让用户自己决定要不要发给 AI
        cat_idx = next((i for i, it in enumerate(items) if it.get("mode") == "catalog"), len(items))
        items.insert(cat_idx + 1, {"title": "文件仓库", "mode": "file_repo", "enabled": False})
        changed = True
    # 用户内容条目（fixed / ai_editable / firm）自动补 role 字段，默认 system
    for it in items:
        if it.get("mode") in ("fixed", "ai_editable", "firm") and "role" not in it:
            it["role"] = "system"
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
            {"title": "系统提示词", "mode": "fixed", "role": "system", "enabled": True},
            {"title": "当前章节", "mode": "chapter", "enabled": True},
            {"title": "参考章节", "mode": "reference", "enabled": True, "chapters": []},
            {"title": "读取指令说明", "mode": "read_hint", "enabled": True},
            {"title": "章节目录", "mode": "catalog", "enabled": True},
            {"title": "文件仓库", "mode": "file_repo", "enabled": False},
            {"title": "上下文", "mode": "context", "enabled": True},
            {"title": "用户最新发言", "mode": "latest_input", "enabled": True},
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


# ── Build-and-swap：原子化的 prompt set 结构更新 ──
# 防止拖拽/增删时 meta.json 与 items/*.md 不同步导致内容错位

USER_CONTENT_MODES = {"fixed", "ai_editable", "firm"}

# 每个 prompt set 一把锁，防止 build-and-swap 进行中被并发的 item 写入破坏
# Flask debug 模式默认多线程处理请求，没锁会出现：
#   - 线程 A 正在 rename items/ → items_old/
#   - 线程 B 同时 PUT /item/<idx>，path.parent.mkdir 创建空 items/
#   - 线程 A 后续 rename items_new/ → items/ 失败或覆盖 → 文件丢失
_prompt_set_locks = defaultdict(threading.Lock)


def _ps_lock(name):
    """获取指定 prompt set 的锁（按名字索引）"""
    return _prompt_set_locks[name]


def _cleanup_prompt_set_residuals(d):
    """清理上次 build-and-swap 操作可能留下的残留（启动时 + PUT 前都会调）"""
    items_dir = d / "items"
    items_new_dir = d / "items_new"
    items_old_dir = d / "items_old"

    if not items_dir.exists() and items_new_dir.exists():
        # 崩溃位置：rename1 完成、rename2 之前 → items_new/ 是预期的新状态
        items_new_dir.rename(items_dir)
        if items_old_dir.exists():
            shutil.rmtree(items_old_dir, ignore_errors=True)
    elif items_dir.exists() and items_old_dir.exists():
        # 崩溃位置：rename2 完成、rmtree 之前 → items/ 已经是新的，删 backup 即可
        shutil.rmtree(items_old_dir, ignore_errors=True)
        if items_new_dir.exists():
            shutil.rmtree(items_new_dir, ignore_errors=True)
    elif items_dir.exists() and items_new_dir.exists():
        # 崩溃位置：构建 items_new/ 中途 → items/ 完好，丢弃半成品
        shutil.rmtree(items_new_dir, ignore_errors=True)


def _build_and_swap_items(d, old_items, new_items):
    """构建 items_new/，把 old items/ 里需要保留的 .md 复制过去，再原子切换。

    匹配老 idx 的策略（优先级从高到低）：
    1. 前端附加的 `_src_idx` 字段（精确，重命名/拖拽都准）
    2. 按 title + mode 匹配（fallback，应对前端没附 _src_idx 的场景）

    new_items 里 mode 不是 user_content 的不需要 .md 文件，跳过。
    匹配不到的（新建条目）也跳过——文件由 PUT /item/<idx> 创建。
    """
    items_dir = d / "items"
    items_new_dir = d / "items_new"
    items_old_dir = d / "items_old"

    # 1. 清理可能存在的残留
    _cleanup_prompt_set_residuals(d)

    # 2. 建 items_new/
    items_new_dir.mkdir(exist_ok=True)

    # 3. 准备 title → 老 idx 列表（用于 fallback 匹配）
    title_to_old_indices = {}
    for i, it in enumerate(old_items):
        title_to_old_indices.setdefault(it["title"], []).append(i)
    used_old_indices = set()

    def _resolve_old_idx(item):
        """返回这个 new_item 对应的老 idx，找不到返回 None。

        BUG-FIX 历史：早期 title fallback 在 _src_idx 缺失时仍会运行，
        导致"新增条目用默认名 → 与已存在同名条目撞 → 老内容被吸到新位置"
        的灾难性数据错位。现在的契约：所有合法的修改路径前端都会调 tagSrcIdx，
        所以 _src_idx 缺失 = 真新增条目，直接返回 None，绝不走 title 兜底。
        title fallback 仅用于 _src_idx 存在但 stale（mode 切换/并发竞态等）。
        """
        src = item.get("_src_idx")
        if src is None:
            # 前端未标记 → 真新增条目，不能继承任何老内容
            return None
        if isinstance(src, int) and 0 <= src < len(old_items):
            if src not in used_old_indices and old_items[src].get("mode") in USER_CONTENT_MODES:
                used_old_indices.add(src)
                return src
        # _src_idx 存在但 stale 时，title 兜底
        for c in title_to_old_indices.get(item.get("title"), []):
            if c in used_old_indices:
                continue
            if old_items[c].get("mode") not in USER_CONTENT_MODES:
                continue
            used_old_indices.add(c)
            return c
        return None

    for new_idx, item in enumerate(new_items):
        if item.get("mode") not in USER_CONTENT_MODES:
            continue
        old_idx = _resolve_old_idx(item)
        if old_idx is not None:
            old_path = items_dir / f"{old_idx}.md"
            new_path = items_new_dir / f"{new_idx}.md"
            if old_path.exists():
                shutil.copy2(old_path, new_path)
            # FIRM 条目同时迁移基线快照 .firm.md（如果存在）
            # 注意：用 new_item 的 mode 判断，因为模式可能从其它态切到 firm；
            # 只要旧文件存在就跟着搬，不存在则跳过（lock 端点会按需重新创建）
            if item.get("mode") == "firm":
                old_firm = items_dir / f"{old_idx}.firm.md"
                new_firm = items_new_dir / f"{new_idx}.firm.md"
                if old_firm.exists():
                    shutil.copy2(old_firm, new_firm)

    # 4. 原子切换
    if items_dir.exists():
        items_dir.rename(items_old_dir)
    items_new_dir.rename(items_dir)

    # 5. 删除备份
    if items_old_dir.exists():
        shutil.rmtree(items_old_dir, ignore_errors=True)


@app.route("/api/prompt-sets/<name>/structure", methods=["GET", "PUT"])
def prompt_set_structure(name):
    d = prompt_set_dir(name)
    meta_path = d / "meta.json"
    if request.method == "GET":
        with open(meta_path, "r", encoding="utf-8") as f:
            return jsonify(json.load(f))

    # PUT：原子化结构更新（加锁防止与并发的 item 写入冲突）
    with _ps_lock(name):
        new_data = request.json or {}
        new_items = new_data.get("items", [])

        # 读旧 meta 拿到原始 items（用于 title 匹配）
        old_items = []
        if meta_path.exists():
            try:
                with open(meta_path, "r", encoding="utf-8") as f:
                    old_meta = json.load(f)
                old_items = old_meta.get("items", [])
            except Exception:
                old_items = []

        # 执行 build-and-swap
        _build_and_swap_items(d, old_items, new_items)

        # 写 meta.json 前清理临时字段 _src_idx（仅在传输中使用）
        for it in new_items:
            it.pop("_src_idx", None)

        with open(meta_path, "w", encoding="utf-8") as f:
            json.dump(new_data, f, ensure_ascii=False, indent=2)
    return jsonify(new_data)


@app.route("/api/prompt-sets/<name>/item/<int:idx>", methods=["GET", "PUT"])
def prompt_set_item(name, idx):
    d = prompt_set_dir(name)
    path = d / "items" / f"{idx}.md"
    if request.method == "GET":
        content = path.read_text(encoding="utf-8") if path.exists() else ""
        return jsonify({"content": content})
    # PUT：加锁防止与 build-and-swap 并发执行
    with _ps_lock(name):
        content = request.json.get("content", "")
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content, encoding="utf-8")
    return jsonify({"ok": True})


# ── FIRM mode：基线快照管理 ──
# FIRM 条目存两个文件：
#   <idx>.md       工作版（用户编辑、运行时实际生效）
#   <idx>.firm.md  基线快照（用户显式"锁定"创建，作为可还原的安全点）

@app.route("/api/prompt-sets/<name>/item/<int:idx>/lock", methods=["POST"])
def prompt_set_item_lock(name, idx):
    """锁定当前工作版为新基线：cp <idx>.md → <idx>.firm.md
    若 .md 不存在则先创建空文件再复制，确保基线一定存在。"""
    d = prompt_set_dir(name)
    md_path = d / "items" / f"{idx}.md"
    firm_path = d / "items" / f"{idx}.firm.md"
    with _ps_lock(name):
        md_path.parent.mkdir(parents=True, exist_ok=True)
        if not md_path.exists():
            md_path.write_text("", encoding="utf-8")
        shutil.copy2(md_path, firm_path)
    return jsonify({"ok": True})


@app.route("/api/prompt-sets/<name>/item/<int:idx>/reset", methods=["POST"])
def prompt_set_item_reset(name, idx):
    """还原工作版到基线：cp <idx>.firm.md → <idx>.md
    若基线不存在则清空工作版。返回最新工作版内容供前端刷新编辑器。"""
    d = prompt_set_dir(name)
    md_path = d / "items" / f"{idx}.md"
    firm_path = d / "items" / f"{idx}.firm.md"
    with _ps_lock(name):
        md_path.parent.mkdir(parents=True, exist_ok=True)
        if firm_path.exists():
            shutil.copy2(firm_path, md_path)
            content = md_path.read_text(encoding="utf-8")
        else:
            md_path.write_text("", encoding="utf-8")
            content = ""
    return jsonify({"ok": True, "content": content})


# ── 内置资源 ──
BUILTIN_DIR = BASE_DIR / "prompts" / "_builtin"


def _read_builtin(name):
    """Read a built-in resource file. Returns empty string if not found."""
    path = BUILTIN_DIR / f"{name}.md"
    if path.exists():
        return path.read_text(encoding="utf-8").rstrip("\n")
    return ""


# ── Mode handlers (dispatch table) ──
# Each handler takes (prompt_set_dir, item_index, item_meta) and returns the dict for the API response.

def _handle_empty(d, idx, item):
    """For modes whose content is filled at runtime by the frontend (chapter, catalog, latest_input, context)."""
    return {"idx": idx, "title": item["title"], "mode": item["mode"],
            "role": item.get("role", "system"), "content": "", "chars": 0}


def _handle_read_hint(d, idx, item):
    """Built-in static guidance text (loaded from prompts/_builtin/read_hint.md)."""
    content = _read_builtin("read_hint")
    return {"idx": idx, "title": item["title"], "mode": item["mode"],
            "role": item.get("role", "system"), "content": content, "chars": len(content)}


def _handle_file_repo(d, idx, item):
    """Built-in intro text + frontend appends file list at send time."""
    content = _read_builtin("file_repo_intro")
    return {"idx": idx, "title": item["title"], "mode": item["mode"],
            "role": item.get("role", "system"), "content": content, "chars": len(content)}


def _handle_reference(d, idx, item):
    """Reference chapters: chapter list stored in meta, content fetched at send time."""
    chapters = item.get("chapters", [])
    return {"idx": idx, "title": item["title"], "mode": item["mode"],
            "role": item.get("role", "system"), "content": "",
            "chapters": chapters, "chars": len(chapters)}


def _handle_user_content(d, idx, item):
    """User-editable content stored in items/{idx}.md (fixed / ai_editable)."""
    path = d / "items" / f"{idx}.md"
    content = path.read_text(encoding="utf-8") if path.exists() else ""
    return {"idx": idx, "title": item["title"], "mode": item["mode"],
            "role": item.get("role", "system"), "content": content, "chars": len(content)}


MODE_HANDLERS = {
    "context":      _handle_empty,
    "chapter":      _handle_empty,
    "catalog":      _handle_empty,
    "latest_input": _handle_empty,
    "read_hint":    _handle_read_hint,
    "file_repo":    _handle_file_repo,
    "reference":    _handle_reference,
    "fixed":        _handle_user_content,
    "ai_editable":  _handle_user_content,
    "firm":         _handle_user_content,
}


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
        handler = MODE_HANDLERS.get(mode, _handle_user_content)
        items.append(handler(d, i, it))
    return jsonify({"items": items})


@app.route("/api/prompt-sets/<name>/ai-update", methods=["POST"])
def prompt_set_ai_update(name):
    """AI auto-update: write content to specific items by title."""
    d = prompt_set_dir(name)
    meta_path = d / "meta.json"
    if not meta_path.exists():
        return jsonify({"error": "提示词集不存在"}), 404
    # 加锁防止与 build-and-swap / item 写入并发
    with _ps_lock(name):
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
    # 收集所有文件
    rels = []
    for f in sorted(repo_dir.rglob("*")):
        if f.is_file():
            rels.append(f.relative_to(repo_dir))
    # 三级消歧：stem 唯一 → "stem."；全名唯一 → "name.ext"；都重复 → 完整相对路径
    stem_counts = {}
    name_counts = {}
    for rel in rels:
        stem_counts[rel.stem] = stem_counts.get(rel.stem, 0) + 1
        name_counts[rel.name] = name_counts.get(rel.name, 0) + 1
    lines = []
    for rel in rels:
        if stem_counts[rel.stem] == 1:
            lines.append(rel.stem + ".")            # 装饰用点，提示这是文件
        elif name_counts[rel.name] == 1:
            lines.append(rel.name)                  # 用完整文件名（带扩展名）消歧
        else:
            lines.append(str(rel).replace("\\", "/"))   # 用完整相对路径消歧
    return jsonify({"tree": "\n".join(lines), "root": str(repo_dir)})


def read_repo_file(rel_path):
    repo_dir = get_file_repo_dir()
    if not repo_dir:
        return "(文件仓库未配置)"

    # 标准化：统一斜杠、去末尾装饰用的小数点
    rel_path = rel_path.strip().replace("\\", "/").rstrip(".")

    def _read(target):
        try:
            content = target.read_text(encoding="utf-8")
            if len(content) > 10000:
                content = content[:10000] + f"\n...(文件过长，已截断，共{len(content)}字)"
            return content
        except Exception as e:
            return f"(读取失败: {e})"

    def _under_repo(p):
        return str(p.resolve()).startswith(str(repo_dir.resolve()))

    # 1. 先试完整相对路径（AI 给了 .txt 或完整路径时直接命中）
    target = (repo_dir / rel_path).resolve()
    if _under_repo(target) and target.is_file():
        return _read(target)

    # 2. 没有 "/" 时，按 stem 或 name 递归搜索
    if "/" not in rel_path:
        # 2a. 同 stem 的所有文件（覆盖 AI 输入的 "1" 匹配 "1.txt"、"1.md" 等）
        stem_matches = [p for p in repo_dir.rglob("*") if p.is_file() and p.stem == rel_path]
        # 2b. 同全名的文件（覆盖 AI 输入 "AI理解.txt" 但文件不在根目录的情况）
        name_matches = [p for p in repo_dir.rglob(rel_path) if p.is_file()]
        # 合并去重
        all_matches = list({p.resolve(): p for p in (stem_matches + name_matches)}.values())
        if len(all_matches) == 1:
            return _read(all_matches[0])
        if len(all_matches) > 1:
            paths = "\n".join(f"  - {m.relative_to(repo_dir)}" for m in all_matches)
            return f"('{rel_path}' 不唯一，找到 {len(all_matches)} 个，请使用完整相对路径以消歧:\n{paths})"

    return f"(未找到文件: {rel_path})"


# ── AI Chat (streaming, with <<<READ:>>> agent loop) ──

@app.route("/api/chat", methods=["POST"])
def chat():
    cfg = load_config()
    data = request.json
    messages = list(data.get("messages", []))

    # 消息后处理：根据 cfg.merge_mode 应用合并/强制角色（DeepSeek 等 API 兼容）
    merge_mode = cfg.get("merge_mode", "none")
    if merge_mode and merge_mode != "none":
        before = len(messages)
        messages = post_process_messages(messages, merge_mode)
        print(f"[POST-PROCESS] {merge_mode}: {before} → {len(messages)} messages")

    if not messages:
        err = json.dumps({"error": "messages 数组为空"}, ensure_ascii=False)
        return Response(f"data: {err}\n\n", mimetype="text/event-stream; charset=utf-8")

    all_messages = messages

    model = cfg.get("model", "claude-sonnet-4-20250514")
    api_headers = {"Content-Type": "application/json"}
    api_key = cfg.get("api_key", "")
    if api_key:
        api_headers["Authorization"] = f"Bearer {api_key}"

    READ_RE = re.compile(r'<<<READ:([^/]+)/(\d+)/(\d+)>>>')
    FILE_RE = re.compile(r'<<<FILE:(.*?)>>>')

    sys_len = sum(len(m.get("content", "")) for m in messages if m.get("role") == "system")
    print(f"[DEBUG] system_len: {sys_len}, total_messages: {len(messages)}")

    def do_stream(msgs):
        """Stream a single request, return full content text and yield SSE chunks."""
        payload = {"model": model, "messages": msgs, "stream": True}
        # 思考模式开关（DeepSeek V4 Pro / Claude 4 / OpenAI o-系列等支持的扩展字段）
        # 'auto' = 不发字段，让模型用默认行为；显式 enabled/disabled 才发
        thinking_mode = cfg.get("thinking_mode", "auto")
        if thinking_mode in ("enabled", "disabled"):
            payload["thinking"] = {"type": thinking_mode}
        # 思考深度：reasoning_effort 仅在思考未被显式关闭时才发，避免参数冲突
        reasoning_effort = cfg.get("reasoning_effort", "auto")
        if thinking_mode != "disabled" and reasoning_effort in ("low", "medium", "high"):
            payload["reasoning_effort"] = reasoning_effort
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

            # Check for <<<READ:novel/vol/chap>>>, <<<FILE:path>>>, <<<ASK_AGENT:>>> directives
            reads = READ_RE.findall(full_text)
            file_reads = FILE_RE.findall(full_text)
            agent_asks = ASK_RE.findall(full_text)
            if (not reads and not file_reads and not agent_asks) or round_i >= max_read_rounds:
                yield "data: [DONE]\n\n"
                return

            # 判定一段 fetch 结果是不是"未命中"——这是 AI 复述示例时的典型征兆
            def _is_failed(content):
                if not content:
                    return True
                head = content[:80]
                fail_markers = (
                    "(未找到章节",
                    "(未找到文件",
                    "(路径不合法",
                    "(文件仓库未配置",
                    "(读取失败",
                )
                if head.startswith(fail_markers):
                    return True
                if "不唯一" in head and "找到" in head:
                    return True
                return False

            # AI wants to read or ask agent — fetch results
            read_results = []
            real_fetches = 0  # 真正命中（非"未找到"）的次数

            for novel_name, vol_s, chap_s in reads:
                content = read_chapter_content(novel_name.strip(), int(vol_s), int(chap_s))
                if not _is_failed(content):
                    real_fetches += 1
                read_results.append(f"[{novel_name} 卷{vol_s} 章{chap_s}]:\n{content}")

            for rel_path in file_reads:
                content = read_repo_file(rel_path.strip())
                if not _is_failed(content):
                    real_fetches += 1
                read_results.append(f"[文件: {rel_path.strip()}]:\n{content}")

            for question in agent_asks:
                q = question.strip()
                info_wait = json.dumps({"choices": [{"delta": {"content": f"\n\n[📬 已发送请求给Agent，等待回复...]\n\n"}}]}, ensure_ascii=False)
                yield f"data: {info_wait}\n\n"
                msg_id = mailbox_send("ask_agent", {"question": q})
                reply = poll_mailbox_reply(msg_id, timeout=120)
                real_fetches += 1  # agent 总是当作真请求
                read_results.append(f"[Agent回答]:\n{reply}")

            total = len(reads) + len(file_reads) + len(agent_asks)

            # 安全网：所有读取指令都失败 → AI 大概率只是在举例复述，不是真请求
            # 直接终止，不把"未找到"塞回去触发死循环
            if real_fetches == 0:
                warn = json.dumps({"choices": [{"delta": {
                    "content": f"\n\n[⚠ 检测到 {total} 个读取指令但全部未命中（小说/文件不存在）。判定为 AI 在举例复述，已跳过自动获取以避免循环。]\n\n"
                }}]}, ensure_ascii=False)
                yield f"data: {warn}\n\n"
                yield "data: [DONE]\n\n"
                return

            # 至少有一个真命中：正常喂回去让 AI 继续
            all_messages.append({"role": "assistant", "content": full_text})
            all_messages.append({
                "role": "user",
                "content": "以下是你请求的内容：\n\n" + "\n\n---\n\n".join(read_results) + "\n\n请继续。"
            })

            # Notify frontend
            info = json.dumps({"choices": [{"delta": {"content": f"\n\n[📖 已获取 {real_fetches}/{total} 项内容，继续生成...]\n\n"}}]}, ensure_ascii=False)
            yield f"data: {info}\n\n"

    return Response(generate(), mimetype="text/event-stream; charset=utf-8")


# ── Mailbox API ──

@app.route("/api/mailbox/status", methods=["GET"])
def mailbox_status():
    """Check mailbox message counts."""
    def count_json(d):
        if not d.exists():
            return 0
        return sum(1 for f in d.iterdir() if f.suffix == ".json")
    return jsonify({
        "inbox": count_json(MAILBOX_INBOX),
        "outbox": count_json(MAILBOX_OUTBOX),
        "archive": count_json(MAILBOX_ARCHIVE)
    })


@app.route("/api/mailbox/send", methods=["POST"])
def mailbox_send_api():
    """Send a message to the mailbox inbox."""
    data = request.json
    action = data.get("action", "ask_agent")
    payload = data.get("payload", {})
    msg_id = mailbox_send(action, payload)
    return jsonify({"msg_id": msg_id, "status": "sent"})


@app.route("/api/mailbox/smart-feed", methods=["POST"])
def mailbox_smart_feed():
    """Request smart chapter feeding. Blocks until agent replies."""
    data = request.json
    novel = data.get("novel", "")
    target_chapter = data.get("target_chapter", 0)
    characters = data.get("characters", [])
    msg_id = mailbox_send("smart_feed", {
        "novel": novel,
        "target_chapter": target_chapter,
        "characters": characters
    })
    reply = poll_mailbox_reply(msg_id, timeout=120)
    return jsonify({"content": reply})


if __name__ == "__main__":
    NOVELS_DIR.mkdir(exist_ok=True)
    PROMPTS_DIR.mkdir(exist_ok=True)
    for d in [MAILBOX_INBOX, MAILBOX_OUTBOX, MAILBOX_ARCHIVE]:
        d.mkdir(parents=True, exist_ok=True)
    # 启动时扫描所有提示词集，清理上次崩溃留下的 build-and-swap 残留
    recovered = 0
    for psd in PROMPTS_DIR.iterdir():
        if psd.is_dir() and psd.name != "_builtin":
            before = (psd / "items_new").exists() or (psd / "items_old").exists()
            _cleanup_prompt_set_residuals(psd)
            if before:
                recovered += 1
    if recovered:
        print(f"[启动恢复] 清理了 {recovered} 个提示词集的残留状态")
    # 清理迁移残留：老格式 <ci>_<ii>.md 文件——migrate_prompt_set 把它们复制为新的
    # <idx>.md 但没删原件，此处批量清掉。re 模块已在文件头部导入。
    migration_purged = 0
    legacy_pattern = re.compile(r"^\d+_\d+\.md$")
    for psd in PROMPTS_DIR.iterdir():
        if psd.is_dir() and psd.name != "_builtin":
            items_dir = psd / "items"
            if items_dir.exists():
                for f in items_dir.iterdir():
                    if f.is_file() and legacy_pattern.match(f.name):
                        try:
                            f.unlink()
                            migration_purged += 1
                        except OSError:
                            pass
    if migration_purged:
        print(f"[启动恢复] 清理了 {migration_purged} 个旧格式迁移残留文件（<i>_<j>.md）")
    cfg = load_config()
    print(f"NovelForge 启动: http://localhost:{cfg.get('port', 5000)}")
    extra_files = []
    for ext in ("*.html", "*.js", "*.css"):
        extra_files.extend(str(p) for p in BASE_DIR.rglob(ext))
    app.run(host="0.0.0.0", port=cfg.get("port", 5000), debug=True,
            extra_files=extra_files)
