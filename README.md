# NovelForge

基于 Flask + JavaScript 的 B/S 架构 AI 辅助内容创作平台，前端采用 HTML/CSS/JS 实现，后端 Python + Flask 提供 RESTful API，数据以 JSON 结构化存储。支持在线编辑、AI 对话辅助、可配置提示词模板与实时流式响应（SSE）。

## 技术栈

| 层级 | 技术 |
|------|------|
| 后端框架 | Python + Flask |
| 前端 | HTML5 / CSS3 / JavaScript (ES6+) |
| 通信协议 | RESTful API + SSE (Server-Sent Events) |
| 数据存储 | JSON 结构化存储 + Markdown 文件 |
| AI 接口 | OpenAI 兼容协议，Bearer Token 鉴权 |

## 功能特性

- **内容管理** — 小说按卷/章组织，支持新建、重命名、拖拽排序，章节内容自动保存
- **AI 对话辅助** — 集成大语言模型 API，支持实时流式响应（SSE），对话上下文可配置
- **多轮智能代理交互** — AI 可通过指令自主获取章节内容与外部文件，实现多轮 Agent 循环（最多 5 轮）
- **可配置提示词模板系统** — 支持固定文本、动态章节引用、对话历史、AI 可编辑等多种模块类型，可拖拽组合排序
- **外部文件仓库** — 支持挂载外部文件目录，AI 可按需读取参考资料
- **设置中心** — 可视化配置 API 地址、模型、密钥与系统提示词，支持多模型切换

## 项目结构

```
NovelForge/
├── app.py                 # Flask 后端，21 个 RESTful API 接口
├── config.json            # 平台配置（端口、API、模型等）
├── start.bat              # Windows 启动脚本
├── templates/
│   └── index.html         # 单页应用主页面
├── static/
│   ├── app.js             # 前端交互逻辑与状态管理
│   └── style.css          # 界面样式
├── novels/                # 小说数据存储目录
├── prompts/               # 提示词模板集
└── 仓库文件/              # 外部参考文件目录
```

> ⚠️ 本项目需自备 OpenAI 兼容协议的 AI 服务 API 密钥。

## 快速启动

1. 安装依赖：
   ```bash
   pip install flask requests
   ```

2. 编辑 `config.json`，填入你的 AI 服务 API 地址与密钥

3. 启动服务：
   ```bash
   python app.py
   ```

4. 浏览器访问 `http://localhost:5000`

## 架构说明

- **前后端分离**：前端通过 RESTful API 与后端通信，AI 响应通过 SSE 实时推送至浏览器
- **Agent 循环机制**：AI 可在对话中发出 `<<<READ:>>>` / `<<<FILE:>>>` 指令，后端自动解析并注入对应内容，实现多轮自主交互
- **无数据库设计**：所有数据以 JSON + Markdown 文件形式存储，便于备份与迁移
- **提示词模板系统**：支持多种模块类型的灵活组合与拖拽排序，可针对不同写作场景快速切换配置

<!-- ## 截图 -->
<!-- 待补充 -->
