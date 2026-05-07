# NovelForge

一个**本地优先**的小说写作工作台。把你的提示词集变成"发给 LLM 的真实清单"——左边面板里看到啥顺序，AI 收到的就是啥顺序。

[English version →](./README.md)

---

## 这玩意儿解决什么问题

绝大多数小说写作工具不是把你绑死在某个厂商的 prompt 模板上，就是把"实际发给 LLM 的字节"藏起来。NovelForge 走相反的路子——**每条提示词都是可拖动、可重排的独立消息**，左边面板从上到下的顺序，**一字不差地**就是发给 API 的顺序。所见即所发，没有黑箱。

它**默认离线**（单机 Flask 跑在 `localhost`），用纯 `.md` 文件存内容（Git 友好、能手动改），兼容任何 OpenAI 协议的 chat 端点（DeepSeek、走代理的 Anthropic、OpenAI、本地 LLM 都行）。

## 特性一览

- **可视化提示词编辑器** —— 每条 system / user / assistant 消息可拖、可关、可改名、可预览，看清楚每个字节再送出门。
- **输入框实时镜像** —— 你正在敲还没发的字，会实时映射到提示词面板里成为一个条目，所以"发送预览"是真预览。
- **原子化结构更新** —— 拖拽用 build-and-swap 模式 + 每个集合一把线程锁，半途崩了下次启动自动恢复，不会再出现"拖完发现内容跟标题对不上"的恶性 bug。
- **内置 agent 循环** —— 模型输出 `<<<READ:小说/卷/章>>>`、`<<<FILE:文件名>>>` 或 `<<<ASK_AGENT:问题>>>`，服务端自动取数据喂回去，最多 5 轮。模型只是举例复述时检测自动跳过，不会死循环。
- **AI 可改条目** —— 让 AI 重写指定字段，在回复末尾加 `<<<UPDATE:标题>>>新内容<<<END>>>` 即可。
- **停止按钮 + 顺手快捷键** —— `Enter` 发送、`Shift+Enter` 换行、中文输入法选字时不误发、流式生成可中断。
- **合理的默认值** —— 新建的提示词集自带"当前章节、章节目录、文件仓库、上下文、用户最新发言"等占位条目，每个独立开关。

## 快速开始

### 1. 环境
- Python 3.9+
- 现代浏览器（Chrome / Edge / Firefox 等）

### 2. 安装
```bash
git clone https://github.com/<你的用户名>/NovelForge.git
cd NovelForge
pip install flask requests
```

### 3. 配置
打开 `config.json`，把所有 `YOUR_API_KEY_HERE` 替换成你真实的 API key。可以挑一个预设（修改 `active_preset`），也可以直接改顶层的 `api_url` / `model`。

### 4. 启动
```bash
python app.py
# Windows 用户也可以双击：
start.bat
```
浏览器访问 `http://localhost:5000`。

## 架构概览

```
NovelForge/
├── app.py                # Flask 后端（~1000 行）
├── config.json           # 运行配置（API 地址、端口等）
├── static/
│   ├── app.js            # 前端逻辑（~1100 行）
│   └── style.css
├── templates/
│   └── index.html        # 单页 UI
├── prompts/              # 提示词集（用户数据，已 .gitignore）
│   └── _builtin/         # 只读内置资源（项目自带）
│       ├── read_hint.md
│       └── file_repo_intro.md
└── novels/               # 小说章节（用户数据，已 .gitignore）
```

### 后端核心设计

- **Dispatch table（`MODE_HANDLERS`）** —— 每个条目模式都对应一个独立的 `_handle_*` 函数，加新模式只要往 dict 里塞一行，不再有又长又乱的 if/elif 链。
- **Build-and-swap 原子写入** —— `_build_and_swap_items` 先构建 `items_new/`，然后原子 `rename` 切换；用 `_src_idx` 做精确匹配（拖拽后准），title 作为兜底（应付异常情况）。
- **每个集合一把线程锁** —— Flask debug 模式默认多线程，`_ps_lock(name)` 让同一个提示词集的 structure / item / ai-update 写操作串行，彻底消除"保存撞拖拽"的数据竞争 bug。
- **启动时残留恢复** —— `_cleanup_prompt_set_residuals` 扫描 `items_new/` / `items_old/` 半残文件夹，自动整理回正常状态。
- **统一 messages 数组** —— `/api/chat` 接收单一有序的 `messages` 列表；前端 `buildMessages` 输出带 role 标签的条目，跟左侧面板的位置 1:1 对应。

### 提示词条目类型

| Mode | 有 `.md` 文件 | 内容来源 |
|------|--------------|---------|
| `fixed` | ✓ | 用户手写的 markdown |
| `ai_editable` | ✓ | 同 `fixed`，但 AI 可用 `<<<UPDATE:>>>` 改写 |
| `chapter` | — | 实时取自编辑器内容 |
| `reference` | — | 你勾选的小说章节 |
| `catalog` | — | 自动生成的章节目录 |
| `read_hint` | — | `prompts/_builtin/read_hint.md` |
| `file_repo` | — | `prompts/_builtin/file_repo_intro.md` + 仓库扫描 |
| `context` | — | 聊天历史（按 role 展开） |
| `latest_input` | — | 实时镜像 chat-input 输入框 |

### AI 能发的指令

| 指令 | 服务端动作 |
|------|----------|
| `<<<READ:小说名/卷号/章号>>>` | 读 `novels/<小说>/chapters/<卷>_<章>.md` 喂回 AI |
| `<<<FILE:文件名>>>` | 在文件仓库里查找（支持递归 + 同名消歧） |
| `<<<ASK_AGENT:问题>>>` | 把消息写到 `mailbox/inbox/`，轮询 `mailbox/outbox/` 等回复 |
| `<<<UPDATE:标题>>>...<<<END>>>` | 覆写对应 `ai_editable` 条目 |

## 配置说明

`config.json` 字段：

| 字段 | 含义 |
|------|------|
| `port` | HTTP 端口（默认 5000） |
| `api_url` | LLM 接口地址（必须 OpenAI chat 协议兼容） |
| `api_key` | 放进 `Authorization: Bearer ...` 头里 |
| `model` | 模型名称（如 `deepseek-chat`、`gpt-4o`、`claude-sonnet-4-20250514`） |
| `default_system_prompt` | 可选兜底——只有在 messages 里完全没 system 时才前置注入 |
| `file_repo_dir` | 你的资料仓库文件夹路径（绝对或相对项目根） |
| `active_preset` | 启动时启用 `presets` 里哪个预设 |
| `presets` | 命名好的 `{api_url, api_key, model}` 套餐，便于一键切换 |

## 项目状态

仍在持续演进。后续路线图：
- 阶段 3：FIRM 模式（带"基线快照"的提示词条目，需显式锁定才生效）
- 阶段 4：每条目的齿轮抽屉 UI（精细配置）
- 阶段 5：浅绿"新增提示词"按钮 + showModal 替换原生弹窗

但**当前版本足够日常写作使用**，欢迎提 issue 和 PR。

## 许可

MIT —— 随便用，没保修。
