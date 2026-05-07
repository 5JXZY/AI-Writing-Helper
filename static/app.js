// ── State ──
let state = {
    novels: [],
    current: null,  // {novel, vol, chap}
    chatMessages: [],
    saveTimer: null,
    collapsed: {},  // track collapsed state: "novel:name" or "vol:name:idx"
    // Prompt sets
    promptSets: [],
    activePromptSet: null, // name of selected prompt set
    currentPrompt: null,   // {set, idx} when editing a prompt item
    editorMode: 'novel',   // 'novel' | 'prompt'
    promptPanelVisible: true,
    refSelectMode: false,
    itemChars: {},  // "psName:idx" -> char count
    editingTitle: null,    // {kind: 'novel'|'vol'|'chap', novel, vi?, ci?, oldValue}
    editingChatMsg: null,  // chatMessages 索引；非 null 时该条消息切到 inline 编辑模式
};

// ── API helpers ──
async function api(path, opts = {}) {
    const res = await fetch('/api' + path, {
        headers: { 'Content-Type': 'application/json' },
        ...opts,
        body: opts.body ? JSON.stringify(opts.body) : undefined,
    });
    return res.json();
}

// 给 ps.items 每条标记当前位置作为 _src_idx（建议在改顺序前调用）。
// 后端的 build-and-swap 用这个精确匹配老 idx，避免拖拽/重命名导致内容错位。
function tagSrcIdx(ps) {
    if (ps && Array.isArray(ps.items)) {
        ps.items.forEach((it, i) => { it._src_idx = i; });
    }
    return ps;
}

// 按小说顺序（state.novels 的 order）+ 卷序号 + 章序号排序参考章节
// 取代旧的"按勾选顺序"，让用户从小说树里勾出来后看到的就是正常阅读顺序
function sortRefChapters(chapters) {
    if (!Array.isArray(chapters) || chapters.length <= 1) return chapters || [];
    const novelOrder = new Map((state.novels || []).map((n, i) => [n.name, i]));
    return [...chapters].sort((a, b) => {
        const an = novelOrder.get(a.novel) ?? 9999;
        const bn = novelOrder.get(b.novel) ?? 9999;
        if (an !== bn) return an - bn;
        if ((a.vol || 0) !== (b.vol || 0)) return (a.vol || 0) - (b.vol || 0);
        return (a.chap || 0) - (b.chap || 0);
    });
}

// 给章节内容前加"【小说名 / 卷 / 章】"标题头，让 AI 知道现在在读哪一章
function _chapterHeader(novelName, vol, chap, prefix = '') {
    const novel = (state.novels || []).find(n => n.name === novelName);
    const volTitle = novel?.volumes?.[vol]?.title || `第${vol + 1}卷`;
    const chapTitle = novel?.volumes?.[vol]?.chapters?.[chap]?.title || `第${chap + 1}章`;
    return `【${prefix}${novelName} / ${volTitle} / ${chapTitle}】`;
}

// ── Novel tree ──
async function loadNovels() {
    state.novels = await api('/novels');
    renderTree();
}

function renderTree() {
    const tree = document.getElementById('novel-tree');
    if (!state.novels.length) {
        tree.innerHTML = '<div style="padding:20px;color:var(--text2);text-align:center;font-size:13px;">点击下方按钮创建第一部小说</div>';
        return;
    }
    tree.innerHTML = state.novels.map(novel => {
        const isActive = state.current?.novel === novel.name;
        const novelKey = `novel:${novel.name}`;
        const novelCollapsed = state.collapsed[novelKey];
        const volumes = novelCollapsed ? '' : (novel.volumes || []).map((vol, vi) => {
            const volKey = `vol:${novel.name}:${vi}`;
            const volCollapsed = state.collapsed[volKey];
            const chapters = volCollapsed ? '' : (vol.chapters || []).map((ch, ci) => {
                const active = isActive && state.current.vol === vi && state.current.chap === ci && state.editorMode === 'novel';
                // Reference checkbox
                let refCheck = '';
                if (state.refSelectMode && state.activePromptSet) {
                    const ref = getRefItem(state.activePromptSet);
                    const isRef = ref?.chapters?.some(c => c.novel === novel.name && c.vol === vi && c.chap === ci);
                    refCheck = `<input type="checkbox" class="tree-chap-check" ${isRef ? 'checked' : ''} onclick="event.stopPropagation();toggleRefChapter('${esc(novel.name)}',${vi},${ci},'${esc(ch.title)}',this.checked)" title="添加为参考章节">`;
                }
                // 章节标题：编辑态用 input，否则 span
                const isEditingChap = state.editingTitle?.kind === 'chap'
                    && state.editingTitle?.novel === novel.name
                    && state.editingTitle?.vi === vi
                    && state.editingTitle?.ci === ci;
                const chapTitleHtml = isEditingChap
                    ? `<input class="inline-rename-input" value="${escHtml(ch.title)}"
                        onclick="event.stopPropagation();"
                        onblur="finishEditTitle(this.value)"
                        onkeydown="if(event.key==='Enter'){this.blur();}else if(event.key==='Escape'){cancelEditTitle();}">`
                    : `<span>${escHtml(ch.title)}</span>`;
                return `<div class="tree-chap ${active ? 'active' : ''}" onclick="selectChapter('${esc(novel.name)}',${vi},${ci})">
                    ${refCheck}
                    ${chapTitleHtml}
                    <button class="tree-btn chap-rename" onclick="event.stopPropagation();startEditChap('${esc(novel.name)}',${vi},${ci})" title="重命名">✏</button>
                </div>`;
            }).join('');
            const volArrow = volCollapsed ? '▸' : '▾';
            const isEditingVol = state.editingTitle?.kind === 'vol'
                && state.editingTitle?.novel === novel.name
                && state.editingTitle?.vi === vi;
            const volTitleHtml = isEditingVol
                ? `<input class="inline-rename-input" value="${escHtml(vol.title)}"
                    onclick="event.stopPropagation();"
                    onblur="finishEditTitle(this.value)"
                    onkeydown="if(event.key==='Enter'){this.blur();}else if(event.key==='Escape'){cancelEditTitle();}">`
                : `<span>${volArrow} ${escHtml(vol.title)}</span>`;
            return `<div class="tree-vol">
                <div class="tree-vol-title" onclick="toggleVol('${esc(novel.name)}',${vi})">
                    ${volTitleHtml}
                    <span class="tree-actions">
                        <button class="tree-btn" onclick="event.stopPropagation();startEditVol('${esc(novel.name)}',${vi})" title="重命名">✏</button>
                        <button class="tree-btn" onclick="event.stopPropagation();addChapter('${esc(novel.name)}',${vi})" title="添加章节">+</button>
                    </span>
                </div>
                ${chapters}
            </div>`;
        }).join('');
        const novelArrow = novelCollapsed ? '▸' : '▾';
        const isEditingNovel = state.editingTitle?.kind === 'novel' && state.editingTitle?.novel === novel.name;
        const novelTitleHtml = isEditingNovel
            ? `<input class="inline-rename-input" value="${escHtml(novel.name)}"
                onclick="event.stopPropagation();"
                onblur="finishEditTitle(this.value)"
                onkeydown="if(event.key==='Enter'){this.blur();}else if(event.key==='Escape'){cancelEditTitle();}">`
            : `<span>${novelArrow} ${escHtml(novel.name)}</span>`;
        return `<div class="tree-novel" draggable="true" data-novel="${escHtml(novel.name)}" ondragstart="dragNovelStart(event)" ondragover="dragNovelOver(event)" ondrop="dragNovelDrop(event)">
            <div class="tree-novel-title ${isActive ? 'active' : ''}" onclick="toggleNovel('${esc(novel.name)}')">
                ${novelTitleHtml}
                <span class="tree-actions">
                    <button class="tree-btn" onclick="event.stopPropagation();startEditNovel('${esc(novel.name)}')" title="重命名">✏</button>
                    <button class="tree-btn" onclick="event.stopPropagation();addVolume('${esc(novel.name)}')" title="添加卷">+卷</button>
                    <button class="tree-btn" onclick="event.stopPropagation();deleteNovel('${esc(novel.name)}')" title="删除">×</button>
                </span>
            </div>
            ${volumes}
        </div>`;
    }).join('');
}

function esc(s) { return s.replace(/'/g, "\\'").replace(/"/g, '&quot;'); }

// ── Novel CRUD ──
async function createNovel() {
    // 直接用递增默认名创建，避免弹窗打断流程；后期点 ✏ inline 改名
    let baseName = '新小说';
    let name = baseName;
    let n = 1;
    while ((state.novels || []).some(x => x.name === name)) {
        n++;
        name = `${baseName}${n}`;
    }
    const res = await api('/novels', { method: 'POST', body: { name } });
    if (res.error) { alert(res.error); return; }
    await loadNovels();
    await selectChapter(name, 0, 0);
    // 创建后自动进入 inline 改名状态，方便用户立即取名
    startEditNovel(name);
}

async function deleteNovel(name) {
    if (!confirm(`确定删除「${name}」？此操作不可撤销。`)) return;
    await api(`/novels/${encodeURIComponent(name)}`, { method: 'DELETE' });
    if (state.current?.novel === name) {
        state.current = null;
        document.getElementById('editor').value = '';
        document.getElementById('current-label').textContent = '选择一个章节开始写作';
    }
    await loadNovels();
}

async function addVolume(novelName) {
    // 直接用默认名创建，后续用 ✏ inline 改名
    const novel = getNovel(novelName);
    if (!novel) return;
    const title = `第${novel.volumes.length + 1}卷`;
    novel.volumes.push({ title, chapters: [{ title: '第一章' }] });
    await api(`/novels/${encodeURIComponent(novelName)}/structure`, { method: 'PUT', body: novel });
    await loadNovels();
    // 自动进入 inline 改名，新建的卷下标就是末尾那个
    startEditVol(novelName, novel.volumes.length - 1);
}

async function addChapter(novelName, volIdx) {
    const novel = getNovel(novelName);
    if (!novel) return;
    const vol = novel.volumes[volIdx];
    const title = `第${vol.chapters.length + 1}章`;
    novel.volumes[volIdx].chapters.push({ title });
    await api(`/novels/${encodeURIComponent(novelName)}/structure`, { method: 'PUT', body: novel });
    await loadNovels();
    startEditChap(novelName, volIdx, vol.chapters.length - 1);
}

function getNovel(name) { return state.novels.find(n => n.name === name); }

// ── Chapter selection ──
async function selectChapter(novelName, vol, chap) {
    await saveEditor();
    setFirmToolbarVisible(false);
    setItemConfigRowVisible(false);
    state.current = { novel: novelName, vol, chap };
    state.editorMode = 'novel';
    const novel = getNovel(novelName);
    const volTitle = novel.volumes[vol].title;
    const chapTitle = novel.volumes[vol].chapters[chap].title;
    document.getElementById('current-label').textContent = `${novelName} / ${volTitle} / ${chapTitle}`;
    document.getElementById('current-label').className = 'chapter-title';

    const data = await api(`/novels/${encodeURIComponent(novelName)}/chapter/${vol}/${chap}`);
    document.getElementById('editor').value = data.content || '';
    renderTree();
    renderPromptSetsTree();
    setStatus('已加载');
}

// ── Inline 改名 ── 取代弹窗式 prompt/showInputModal
// 状态 state.editingTitle 标记当前正在编辑的节点；renderTree 会把对应 span 渲染成 input
// 失焦或回车 → finishEditTitle 提交；Esc → cancelEditTitle 还原
function _focusInlineRenameInput() {
    setTimeout(() => {
        const input = document.querySelector('.inline-rename-input');
        if (input) { input.focus(); input.select(); }
    }, 10);
}

function startEditNovel(novelName) {
    state.editingTitle = { kind: 'novel', novel: novelName, oldValue: novelName };
    renderTree();
    _focusInlineRenameInput();
}

function startEditVol(novelName, vi) {
    const novel = getNovel(novelName);
    if (!novel?.volumes?.[vi]) return;
    state.editingTitle = { kind: 'vol', novel: novelName, vi, oldValue: novel.volumes[vi].title };
    // 确保该卷处于展开状态，否则 input 渲染不出来
    state.collapsed[`novel:${novelName}`] = false;
    renderTree();
    _focusInlineRenameInput();
}

function startEditChap(novelName, vi, ci) {
    const novel = getNovel(novelName);
    if (!novel?.volumes?.[vi]?.chapters?.[ci]) return;
    state.editingTitle = { kind: 'chap', novel: novelName, vi, ci, oldValue: novel.volumes[vi].chapters[ci].title };
    state.collapsed[`novel:${novelName}`] = false;
    state.collapsed[`vol:${novelName}:${vi}`] = false;
    renderTree();
    _focusInlineRenameInput();
}

async function finishEditTitle(newValue) {
    if (!state.editingTitle) return;
    const e = state.editingTitle;
    state.editingTitle = null;
    const cleaned = (newValue || '').trim();
    if (!cleaned || cleaned === e.oldValue) {
        renderTree();
        return;
    }
    if (e.kind === 'novel') {
        const res = await fetch(`/api/novels/${encodeURIComponent(e.oldValue)}/rename`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ new_name: cleaned }),
        });
        const data = await res.json();
        if (data.error) { alert(data.error); await loadNovels(); return; }
        if (state.current?.novel === e.oldValue) state.current.novel = cleaned;
    } else if (e.kind === 'vol') {
        const novel = getNovel(e.novel);
        if (novel) {
            novel.volumes[e.vi].title = cleaned;
            await api(`/novels/${encodeURIComponent(e.novel)}/structure`, { method: 'PUT', body: novel });
        }
    } else if (e.kind === 'chap') {
        const novel = getNovel(e.novel);
        if (novel) {
            novel.volumes[e.vi].chapters[e.ci].title = cleaned;
            await api(`/novels/${encodeURIComponent(e.novel)}/structure`, { method: 'PUT', body: novel });
        }
    }
    await loadNovels();
}

function cancelEditTitle() {
    state.editingTitle = null;
    renderTree();
}

// ── Drag to reorder novels ──
let draggedNovel = null;

function dragNovelStart(e) {
    draggedNovel = e.currentTarget.dataset.novel;
    e.currentTarget.style.opacity = '0.4';
}

function dragNovelOver(e) {
    e.preventDefault();
}

async function dragNovelDrop(e) {
    e.preventDefault();
    const target = e.currentTarget.dataset.novel;
    if (!draggedNovel || draggedNovel === target) return;
    const names = state.novels.map(n => n.name);
    const fromIdx = names.indexOf(draggedNovel);
    const toIdx = names.indexOf(target);
    names.splice(fromIdx, 1);
    names.splice(toIdx, 0, draggedNovel);
    await fetch('/api/novels/reorder', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ names }),
    });
    draggedNovel = null;
    await loadNovels();
}

function toggleNovel(name) {
    const key = `novel:${name}`;
    state.collapsed[key] = !state.collapsed[key];
    renderTree();
}

function toggleVol(novelName, vi) {
    const key = `vol:${novelName}:${vi}`;
    state.collapsed[key] = !state.collapsed[key];
    renderTree();
}

// ── Prompt Panel show/hide ──
function togglePromptPanel() {
    state.promptPanelVisible = !state.promptPanelVisible;
    document.getElementById('prompt-sets-panel').classList.toggle('hidden', !state.promptPanelVisible);
}

// ── Prompt Sets Tree (flat items) ──
async function loadPromptSets() {
    state.promptSets = await api('/prompt-sets');
    // 没有活动条目集时默认激活第一个——切换下拉框只在 active 行显示，
    // 没有 active 就没下拉框、用户没入口；自动 fallback 解决死锁
    // 也处理被激活的 set 已被删除的场景（state.activePromptSet 不在 promptSets 列表里）
    const names = state.promptSets.map(s => s.name);
    if (state.promptSets.length > 0 &&
        (!state.activePromptSet || !names.includes(state.activePromptSet))) {
        state.activePromptSet = state.promptSets[0].name;
    }
    if (state.promptSets.length === 0) {
        state.activePromptSet = null;
    }
    // Fetch char stats for active prompt set
    if (state.activePromptSet) {
        try {
            const data = await api(`/prompt-sets/${encodeURIComponent(state.activePromptSet)}/all-items`);
            for (const it of (data.items || [])) {
                state.itemChars[`${state.activePromptSet}:${it.idx}`] = it.chars || 0;
            }
        } catch {}
    }
    renderPromptSetsTree();
}

function toggleRefSelectMode(psName) {
    state.refSelectMode = !state.refSelectMode;
    if (state.refSelectMode && psName) {
        state.activePromptSet = psName;
    }
    renderPromptSetsTree();
    renderTree();
}

function renderPromptSetsTree() {
    const tree = document.getElementById('prompt-sets-tree');
    if (!state.promptSets.length) {
        tree.innerHTML = '<div style="padding:20px;color:var(--text2);text-align:center;font-size:13px;">点击下方按钮创建提示词集</div>';
        return;
    }
    tree.innerHTML = state.promptSets.map(ps => {
        const isActive = state.activePromptSet === ps.name;
        const psKey = `ps:${ps.name}`;
        const psCollapsed = state.collapsed[psKey];
        const items = psCollapsed ? '' : (ps.items || []).map((it, idx) => {
            const isBuiltin = ['context', 'chapter', 'reference', 'catalog', 'read_hint', 'latest_input', 'file_repo'].includes(it.mode);
            const isEditing = state.currentPrompt?.set === ps.name && state.currentPrompt?.idx === idx && state.editorMode === 'prompt';
            const modeIcons = { context: '💬', chapter: '📄', reference: '📚', catalog: '📑', read_hint: '💡', ai_editable: '✏️', fixed: '🔒', firm: '🛡️', latest_input: '⌨️', file_repo: '📂' };
            const modeIcon = modeIcons[it.mode] || '🔒';
            const modeTitles = { context: '上下文', chapter: '当前章节', reference: '参考章节', catalog: '章节目录', read_hint: '读取指令说明', latest_input: '用户最新发言（实时镜像输入框）', file_repo: '文件仓库（外部文件清单）' };
            const toggleHints = { fixed: '固定→AI可改', ai_editable: 'AI可改→FIRM（带基线快照）', firm: 'FIRM→固定' };
            const modeBtn = isBuiltin
                ? `<span class="ps-mode-icon" title="${modeTitles[it.mode] || it.mode}">${modeIcon}</span>`
                : `<button class="ps-mode-btn" onclick="event.stopPropagation();toggleItemMode('${esc(ps.name)}',${idx})" title="${toggleHints[it.mode] || '切换模式'}">${modeIcon}</button>`;
            const enabledCheck = `<input type="checkbox" ${it.enabled ? 'checked' : ''} onclick="event.stopPropagation();toggleItemEnabled('${esc(ps.name)}',${idx},this.checked)">`;
            const clickHandler = it.mode === 'reference'
                ? `onclick="toggleRefCollapse('${esc(ps.name)}')"`
                : `onclick="selectPromptItem('${esc(ps.name)}',${idx})"`;
            const deleteBtn = isBuiltin ? '' : `<button class="tree-btn ps-del" onclick="event.stopPropagation();deletePromptItem('${esc(ps.name)}',${idx})" title="删除">×</button>`;

            // Char count badge
            let charsBadge = '';
            const statsKey = `${ps.name}:${idx}`;
            if (it.mode === 'context') {
                const msgCount = state.chatMessages.filter(m => !m._preview).length;
                charsBadge = `<span class="ps-item-chars">${msgCount}条</span>`;
            } else if (it.mode === 'chapter') {
                const editorLen = (state.editorMode === 'novel' && state.current) ? document.getElementById('editor').value.length : 0;
                charsBadge = `<span class="ps-item-chars">${editorLen}字</span>`;
            } else if (it.mode === 'reference') {
                charsBadge = `<span class="ps-item-chars">${(it.chapters || []).length}章</span>`;
            } else if (it.mode === 'latest_input') {
                const liveLen = (document.getElementById('chat-input')?.value || '').length;
                charsBadge = `<span class="ps-item-chars latest-input-badge">${liveLen}字</span>`;
            } else {
                const chars = state.itemChars[statsKey];
                if (chars !== undefined) charsBadge = `<span class="ps-item-chars">${chars}字</span>`;
            }

            // Reference item: collapsible with chapter list + "选" button
            let refList = '';
            if (it.mode === 'reference') {
                const refKey = `ref:${ps.name}`;
                const refCollapsed = state.collapsed[refKey];
                const refArrow = refCollapsed ? '▸' : '▾';
                const chapters = sortRefChapters(it.chapters || []);
                const selectBtn = `<button class="tree-btn ps-ref-select ${state.refSelectMode ? 'active' : ''}" onclick="event.stopPropagation();toggleRefSelectMode('${esc(ps.name)}')" title="${state.refSelectMode ? '关闭选择' : '选择章节'}">选</button>`;
                if (!refCollapsed && chapters.length > 0) {
                    refList = `<div class="ps-ref-list">${chapters.map((ch, ci) =>
                        `<div class="ps-ref-item">
                            <span class="ps-ref-item-title">${escHtml(ch.title)} <small style="color:var(--text2)">(${escHtml(ch.novel)})</small></span>
                            <button class="tree-btn" onclick="event.stopPropagation();removeRefChapter('${esc(ps.name)}','${esc(ch.novel)}',${ch.vol},${ch.chap})" title="移除">×</button>
                        </div>`
                    ).join('')}</div>`;
                }
                return `<div class="ps-item ${!it.enabled ? 'disabled' : ''}" draggable="true" data-ps="${escHtml(ps.name)}" data-idx="${idx}"
                            ondragstart="dragItemStart(event)" ondragover="dragItemOver(event)" ondrop="dragItemDrop(event)" ondragend="dragItemEnd(event)"
                            ${clickHandler}>
                    ${enabledCheck}
                    ${modeBtn}
                    <span class="ps-item-title">${refArrow} ${escHtml(it.title)}</span>
                    ${charsBadge}
                    ${selectBtn}
                </div>${refList}`;
            }

            return `<div class="ps-item ${isEditing ? 'active' : ''} ${!it.enabled ? 'disabled' : ''} ${it.mode === 'firm' ? 'firm' : ''}" draggable="true" data-ps="${escHtml(ps.name)}" data-idx="${idx}"
                        ondragstart="dragItemStart(event)" ondragover="dragItemOver(event)" ondrop="dragItemDrop(event)" ondragend="dragItemEnd(event)"
                        ${clickHandler}>
                ${enabledCheck}
                ${modeBtn}
                <span class="ps-item-title">${escHtml(it.title)}</span>
                ${charsBadge}
                <span class="ps-item-actions">${deleteBtn}</span>
            </div>`;
        }).join('');
        const psArrow = psCollapsed ? '▸' : '▾';
        // 活动条目集旁的切换下拉框：取代原 ☑ 按钮，列出所有条目集快速切换
        // 只在 active 时显示，inactive 的条目集没有这个下拉框（视觉上只有它一个有，明确"它就是活动那个"）
        const switchSelect = isActive ? `
            <select class="ps-switcher"
                    onclick="event.stopPropagation();"
                    onchange="setActivePromptSet(this.value)"
                    title="切换活动条目集">
                ${state.promptSets.map(s =>
                    `<option value="${escHtml(s.name)}" ${s.name === ps.name ? 'selected' : ''}>${escHtml(s.name)}</option>`
                ).join('')}
            </select>` : '';
        return `<div class="ps-group" draggable="true" data-promptset="${escHtml(ps.name)}" ondragstart="dragPsStart(event)" ondragover="dragNovelOver(event)" ondrop="dragPsDrop(event)">
            <div class="ps-group-title ${isActive ? 'active' : ''}" onclick="togglePromptSetCollapse('${esc(ps.name)}')">
                <span class="ps-group-name">${psArrow} ${ps.name}</span>
                ${switchSelect}
                <span class="tree-actions">
                    <button class="tree-btn" onclick="event.stopPropagation();addPromptItem('${esc(ps.name)}')" title="添加条目">+</button>
                    <button class="tree-btn" onclick="event.stopPropagation();renamePromptSet('${esc(ps.name)}')" title="重命名">✏</button>
                    <button class="tree-btn" onclick="event.stopPropagation();deletePromptSet('${esc(ps.name)}')" title="删除">×</button>
                </span>
            </div>
            ${items}
        </div>`;
    }).join('');
}

function togglePromptSetCollapse(name) {
    const key = `ps:${name}`;
    state.collapsed[key] = !state.collapsed[key];
    renderPromptSetsTree();
}

// 旧 ☑ 按钮的处理函数：toggle 行为（点同一个 → 取消激活）
// 阶段 5 后 ☑ 已被切换下拉框取代，本函数已无 UI 入口，保留作为程序化 fallback
function selectActivePromptSet(name) {
    state.activePromptSet = state.activePromptSet === name ? null : name;
    renderPromptSetsTree();
}

// 切换下拉框的 onchange 处理：纯 SET 行为（不 toggle）
// 由活动条目集旁的 <select class="ps-switcher"> 调用
function setActivePromptSet(name) {
    if (!name) return;
    state.activePromptSet = name;
    renderPromptSetsTree();
}

// ── Prompt Set CRUD ──
function createPromptSet() {
    showInputModal('新建提示词集', '名称', '', async (name) => {
        const res = await api('/prompt-sets', { method: 'POST', body: { name } });
        if (res.error) { alert(res.error); return; }
        state.activePromptSet = name;
        await loadPromptSets();
    });
}

async function deletePromptSet(name) {
    if (!confirm(`确定删除提示词集「${name}」？`)) return;
    await api(`/prompt-sets/${encodeURIComponent(name)}`, { method: 'DELETE' });
    if (state.activePromptSet === name) state.activePromptSet = null;
    if (state.currentPrompt?.set === name) {
        state.currentPrompt = null;
        setFirmToolbarVisible(false);
        setItemConfigRowVisible(false);
        if (state.editorMode === 'prompt') {
            state.editorMode = 'novel';
            if (state.current) {
                const data = await api(`/novels/${encodeURIComponent(state.current.novel)}/chapter/${state.current.vol}/${state.current.chap}`);
                document.getElementById('editor').value = data.content || '';
                const novel = getNovel(state.current.novel);
                document.getElementById('current-label').textContent = `${state.current.novel} / ${novel.volumes[state.current.vol].title} / ${novel.volumes[state.current.vol].chapters[state.current.chap].title}`;
                document.getElementById('current-label').className = 'chapter-title';
            } else {
                document.getElementById('editor').value = '';
                document.getElementById('current-label').textContent = '选择一个章节开始写作';
                document.getElementById('current-label').className = 'chapter-title';
            }
        }
    }
    await loadPromptSets();
}

function renamePromptSet(oldName) {
    showInputModal('重命名提示词集', '新名称', oldName, async (newName) => {
        if (newName === oldName) return;
        const res = await api(`/prompt-sets/${encodeURIComponent(oldName)}/rename`, {
            method: 'POST', body: { new_name: newName }
        });
        if (res.error) { alert(res.error); return; }
        if (state.activePromptSet === oldName) state.activePromptSet = newName;
        if (state.currentPrompt?.set === oldName) state.currentPrompt.set = newName;
        await loadPromptSets();
    });
}

// 新建条目：直接插到 items 顶端（idx 0），默认标题"新提示词"，可指定模式
// "自用项目不需要死板"——不弹 modal 不让用户挑选，创建后想改名/改角色/改启用走 ⚙ 抽屉
async function addPromptItem(psName, mode = 'fixed') {
    const ps = getPromptSet(psName);
    if (!ps) return;
    tagSrcIdx(ps);                         // 现有 item 标记 _src_idx；新加的没标记 → 后端识别为新建
    ps.items.unshift({ title: '新提示词', mode, role: 'system', enabled: true });
    await api(`/prompt-sets/${encodeURIComponent(psName)}/structure`,
        { method: 'PUT', body: ps });
    // firm 模式立即拍空基线，避免首次点 ↺ 时"基线不存在 → 清空"
    if (mode === 'firm') {
        await api(`/prompt-sets/${encodeURIComponent(psName)}/item/0/lock`,
            { method: 'POST' });
    }
    await loadPromptSets();
}

// 全局"+新增"按钮（footer 三个图标按钮）：直接以当前活动提示词集为目标
function addPromptItemQuick(mode) {
    if (!state.activePromptSet) {
        alert('请先选择一个活动提示词集（点提示词集右侧的 ☑ 按钮切换）');
        return;
    }
    addPromptItem(state.activePromptSet, mode);
}

async function deletePromptItem(psName, idx) {
    const ps = getPromptSet(psName);
    if (!confirm(`删除「${ps.items[idx].title}」？`)) return;
    tagSrcIdx(ps);                         // 标记后再 splice，剩余项的 _src_idx 仍指向原文件
    ps.items.splice(idx, 1);
    await api(`/prompt-sets/${encodeURIComponent(psName)}/structure`, { method: 'PUT', body: ps });
    if (state.currentPrompt?.set === psName && state.currentPrompt?.idx === idx) {
        state.currentPrompt = null;
        state.editorMode = 'novel';
        setFirmToolbarVisible(false);
        setItemConfigRowVisible(false);
    }
    await loadPromptSets();
}

// 注：阶段 4 之后此函数已没有 UI 入口（✏ 按钮被 ⚙ 抽屉取代，后又被 inline 配置行取代），保留作为 fallback
function renamePromptItem(psName, idx) {
    const ps = getPromptSet(psName);
    const oldTitle = ps.items[idx].title;
    showInputModal('重命名条目', '新名称', oldTitle, async (newTitle) => {
        if (newTitle === oldTitle) return;
        tagSrcIdx(ps);                         // 必须！否则 title 改后后端按 title 找不到老文件
        ps.items[idx].title = newTitle;
        await api(`/prompt-sets/${encodeURIComponent(psName)}/structure`, { method: 'PUT', body: ps });
        await loadPromptSets();
    });
}

async function toggleItemMode(psName, idx) {
    const ps = getPromptSet(psName);
    tagSrcIdx(ps);
    const it = ps.items[idx];
    const oldMode = it.mode;
    // 三态循环：fixed → ai_editable → firm → fixed
    const cycle = { fixed: 'ai_editable', ai_editable: 'firm', firm: 'fixed' };
    it.mode = cycle[it.mode] || 'fixed';
    // 切到 firm 时确保有 role 字段（后端 migrate 也会兜底）
    if (it.mode === 'firm' && !it.role) it.role = 'system';
    await api(`/prompt-sets/${encodeURIComponent(psName)}/structure`, { method: 'PUT', body: ps });
    // 转入 firm 时自动用当前 .md 内容创建基线快照——
    // 否则用户首次点 ↺ 还原基线会意外清空（基线不存在 → 清空 .md）
    if (it.mode === 'firm' && oldMode !== 'firm') {
        await api(`/prompt-sets/${encodeURIComponent(psName)}/item/${idx}/lock`,
            { method: 'POST' });
    }
    await loadPromptSets();
    // 若当前正在编辑这个条目，做轻量视图同步（不调 selectPromptItem 避免二次树渲染闪烁）
    if (state.currentPrompt?.set === psName && state.currentPrompt?.idx === idx) {
        _syncEditorViewToCurrentItem();
    }
}

async function toggleItemEnabled(psName, idx, checked) {
    const ps = getPromptSet(psName);
    tagSrcIdx(ps);
    ps.items[idx].enabled = checked;
    await api(`/prompt-sets/${encodeURIComponent(psName)}/structure`, { method: 'PUT', body: ps });
    await loadPromptSets();
}

function getPromptSet(name) { return state.promptSets.find(ps => ps.name === name); }

// ── Reference chapters ──
function toggleRefCollapse(psName) {
    const key = `ref:${psName}`;
    state.collapsed[key] = !state.collapsed[key];
    renderPromptSetsTree();
}

function getRefItem(psName) {
    const ps = getPromptSet(psName);
    return ps?.items?.find(it => it.mode === 'reference');
}

async function toggleRefChapter(novel, vol, chap, title, checked) {
    if (!state.activePromptSet) return;
    const ps = getPromptSet(state.activePromptSet);
    tagSrcIdx(ps);
    const ref = ps?.items?.find(it => it.mode === 'reference');
    if (!ref) return;
    if (!ref.chapters) ref.chapters = [];
    if (checked) {
        if (!ref.chapters.some(c => c.novel === novel && c.vol === vol && c.chap === chap)) {
            ref.chapters.push({ novel, vol, chap, title });
        }
    } else {
        ref.chapters = ref.chapters.filter(c => !(c.novel === novel && c.vol === vol && c.chap === chap));
    }
    // 按小说+卷+章顺序重排，避免按勾选顺序乱序
    ref.chapters = sortRefChapters(ref.chapters);
    await api(`/prompt-sets/${encodeURIComponent(state.activePromptSet)}/structure`, { method: 'PUT', body: ps });
    await loadPromptSets();
    renderTree();
}

async function removeRefChapter(psName, novel, vol, chap) {
    const ps = getPromptSet(psName);
    tagSrcIdx(ps);
    const ref = ps?.items?.find(it => it.mode === 'reference');
    if (!ref) return;
    ref.chapters = (ref.chapters || []).filter(c => !(c.novel === novel && c.vol === vol && c.chap === chap));
    await api(`/prompt-sets/${encodeURIComponent(psName)}/structure`, { method: 'PUT', body: ps });
    await loadPromptSets();
    renderTree();
}

// 控制 FIRM 工具栏显隐（FIRM 模式编辑器顶部三按钮）
function setFirmToolbarVisible(show) {
    const tb = document.getElementById('firm-toolbar');
    if (tb) tb.style.display = show ? 'flex' : 'none';
}

// ── Prompt Item selection (switches editor to prompt mode) ──
async function selectPromptItem(psName, idx) {
    await saveEditor();
    const ps = getPromptSet(psName);
    const item = ps.items[idx];
    state.activePromptSet = psName;

    // 默认先收起 FIRM 工具栏 + 条目配置行；只有 user-content 分支再打开
    setFirmToolbarVisible(false);
    setItemConfigRowVisible(false);

    if (item.mode === 'context') {
        // Show chat context as read-only preview
        state.currentPrompt = { set: psName, idx };
        state.editorMode = 'prompt';
        const msgs = state.chatMessages.filter(m => !m._preview);
        const preview = msgs.length
            ? msgs.map(m => `[${m.role === 'user' ? '用户' : 'AI'}] ${m.content}`).join('\n\n---\n\n')
            : '(暂无对话上下文)';
        document.getElementById('editor').value = preview;
        document.getElementById('current-label').textContent = `[只读] ${psName} / 上下文预览`;
        document.getElementById('current-label').className = 'chapter-title prompt-mode';
        renderTree();
        renderPromptSetsTree();
        setStatus('只读预览');
        return;
    }

    if (item.mode === 'read_hint') {
        // 内容从后端 _builtin/read_hint.md 拉取
        state.currentPrompt = { set: psName, idx };
        state.editorMode = 'prompt';
        try {
            const all = await api(`/prompt-sets/${encodeURIComponent(psName)}/all-items`);
            const found = (all.items || []).find(x => x.idx === idx);
            document.getElementById('editor').value = found?.content || '(读取指令说明 — 内置文本)';
        } catch {
            document.getElementById('editor').value = '(无法加载内置文本)';
        }
        document.getElementById('current-label').textContent = `[只读] ${psName} / 读取指令说明`;
        document.getElementById('current-label').className = 'chapter-title prompt-mode';
        renderTree();
        renderPromptSetsTree();
        setStatus('只读预览');
        return;
    }

    if (item.mode === 'latest_input') {
        // 实时镜像 chat-input 内容，只读预览
        state.currentPrompt = { set: psName, idx };
        state.editorMode = 'prompt';
        const liveText = document.getElementById('chat-input')?.value || '';
        document.getElementById('editor').value = liveText;
        document.getElementById('current-label').textContent = `[只读] ${psName} / 用户最新发言（实时镜像）`;
        document.getElementById('current-label').className = 'chapter-title prompt-mode';
        renderTree();
        renderPromptSetsTree();
        setStatus('实时镜像');
        return;
    }

    if (item.mode === 'file_repo') {
        state.currentPrompt = { set: psName, idx };
        state.editorMode = 'prompt';
        try {
            const repo = await api('/file-repo/tree');
            document.getElementById('editor').value = repo.tree || '(文件仓库为空或未配置)';
        } catch {
            document.getElementById('editor').value = '(读取文件仓库失败)';
        }
        document.getElementById('current-label').textContent = `[只读] ${psName} / 文件仓库`;
        document.getElementById('current-label').className = 'chapter-title prompt-mode';
        renderTree();
        renderPromptSetsTree();
        setStatus('只读预览');
        return;
    }

    if (item.mode === 'chapter') {
        // Jump to current chapter in novel mode
        if (state.current) {
            state.currentPrompt = null;
            state.editorMode = 'novel';
            const novel = getNovel(state.current.novel);
            const data = await api(`/novels/${encodeURIComponent(state.current.novel)}/chapter/${state.current.vol}/${state.current.chap}`);
            document.getElementById('editor').value = data.content || '';
            document.getElementById('current-label').textContent = `${state.current.novel} / ${novel.volumes[state.current.vol].title} / ${novel.volumes[state.current.vol].chapters[state.current.chap].title}`;
            document.getElementById('current-label').className = 'chapter-title';
            renderTree();
            renderPromptSetsTree();
            setStatus('已加载');
        } else {
            alert('请先在右��选择一个小说章节');
        }
        return;
    }

    if (item.mode === 'firm') {
        // FIRM 模式：加载工作版（.md）到编辑器，但不自动保存——
        // 用户必须显式点 [锁定基线 / 保存工作版 / 还原基线] 之一才生效
        state.currentPrompt = { set: psName, idx };
        state.editorMode = 'prompt';
        document.getElementById('current-label').textContent = `[FIRM] ${psName} / ${item.title}`;
        document.getElementById('current-label').className = 'chapter-title prompt-mode';
        const data = await api(`/prompt-sets/${encodeURIComponent(psName)}/item/${idx}`);
        document.getElementById('editor').value = data.content || '';
        setFirmToolbarVisible(true);
        fillItemConfigRow(item);
        setItemConfigRowVisible(true);
        renderTree();
        renderPromptSetsTree();
        setStatus('FIRM 模式 — 不自动保存，请用工具栏按钮显式提交');
        return;
    }

    // Normal prompt item — edit in prompt mode (fixed / ai_editable)
    state.currentPrompt = { set: psName, idx };
    state.editorMode = 'prompt';

    document.getElementById('current-label').textContent = `[提示词] ${psName} / ${item.title}`;
    document.getElementById('current-label').className = 'chapter-title prompt-mode';

    const data = await api(`/prompt-sets/${encodeURIComponent(psName)}/item/${idx}`);
    document.getElementById('editor').value = data.content || '';
    fillItemConfigRow(item);
    setItemConfigRowVisible(true);
    renderTree();
    renderPromptSetsTree();
    setStatus('已加载');
}

// ── FIRM 模式三按钮 ──
// FIRM 条目存两个文件：items/<idx>.md（工作版）+ items/<idx>.firm.md（基线快照）
// 用户必须显式点击其中一个按钮才能改变文件状态——这是 FIRM 的核心契约。

function _firmCurrentItem() {
    if (!state.currentPrompt) return null;
    const ps = getPromptSet(state.currentPrompt.set);
    const item = ps?.items?.[state.currentPrompt.idx];
    if (item?.mode !== 'firm') return null;
    return { set: state.currentPrompt.set, idx: state.currentPrompt.idx, item };
}

// 按钮 a：把当前 textarea 内容存为新基线
//   先 PUT /item（写 .md），再 POST /lock（cp .md → .firm.md）
//   语义：当前编辑的内容就是新的"安全点"。完成后自动关抽屉，回到第 2 栏小说树。
async function firmLockBaseline() {
    const cur = _firmCurrentItem();
    if (!cur) return;
    const content = document.getElementById('editor').value;
    setStatus('锁定中...');
    await api(`/prompt-sets/${encodeURIComponent(cur.set)}/item/${cur.idx}`,
        { method: 'PUT', body: { content } });
    const res = await api(`/prompt-sets/${encodeURIComponent(cur.set)}/item/${cur.idx}/lock`,
        { method: 'POST' });
    if (res?.ok) {
        setStatus('已锁定为新基线');
        await loadPromptSets();
    } else {
        setStatus('锁定失败');
    }
}

// 按钮 b：保存工作版（基线不动）
//   PUT /item（写 .md）；用于"测试性修改"——先看看效果，留着随时还原
async function firmSaveWorking() {
    const cur = _firmCurrentItem();
    if (!cur) return;
    const content = document.getElementById('editor').value;
    setStatus('保存工作版...');
    const res = await api(`/prompt-sets/${encodeURIComponent(cur.set)}/item/${cur.idx}`,
        { method: 'PUT', body: { content } });
    if (res?.ok) {
        setStatus('工作版已保存（基线未变）');
        await loadPromptSets();
    } else {
        setStatus('保存失败');
    }
}

// 按钮 c：从基线还原
//   POST /reset（cp .firm.md → .md），然后用返回的 content 刷新编辑器
//   若基线不存在则清空工作版
async function firmResetBaseline() {
    const cur = _firmCurrentItem();
    if (!cur) return;
    if (!confirm('确定还原到基线？当前编辑器中未提交的内容会丢失。')) return;
    setStatus('还原中...');
    const res = await api(`/prompt-sets/${encodeURIComponent(cur.set)}/item/${cur.idx}/reset`,
        { method: 'POST' });
    if (res?.ok) {
        document.getElementById('editor').value = res.content || '';
        setStatus(res.content ? '已还原到基线' : '已还原（基线不存在 → 清空）');
        await loadPromptSets();
    } else {
        setStatus('还原失败');
    }
}

// ── 编辑器顶部条目配置行 ──
// 编辑用户内容条目（fixed/ai_editable/firm）时显示三个控件：模式 / 角色 / 标题
// 比抽屉式 UI 更直接：永远可见、不挡其它栏目、所见即所得

function setItemConfigRowVisible(show) {
    const row = document.getElementById('item-config-row');
    if (row) row.style.display = show ? 'flex' : 'none';
}

function fillItemConfigRow(item) {
    document.getElementById('item-mode-select').value = item.mode;
    document.getElementById('item-role-select').value = item.role || 'system';
    document.getElementById('item-title-input').value = item.title;
}

// 模式切换后的轻量视图同步：只更新 FIRM toolbar 显隐 / 配置行 dropdown / label 前缀
// 不重渲染树（树已由 loadPromptSets 渲染过一次）。避免 selectPromptItem 触发二次 render 导致的闪烁。
function _syncEditorViewToCurrentItem() {
    if (!state.currentPrompt) return;
    const ps = getPromptSet(state.currentPrompt.set);
    const item = ps?.items?.[state.currentPrompt.idx];
    if (!item) return;
    if (!['fixed', 'ai_editable', 'firm'].includes(item.mode)) return;
    setFirmToolbarVisible(item.mode === 'firm');
    fillItemConfigRow(item);
    const prefix = item.mode === 'firm' ? '[FIRM]' : '[提示词]';
    document.getElementById('current-label').textContent = `${prefix} ${state.currentPrompt.set} / ${item.title}`;
}

// 当前编辑的提示词条目（仅 user-content modes 才返回非 null）的 helper
function _editingItem() {
    if (!state.currentPrompt || state.currentPrompt.set === '_preview') return null;
    const ps = getPromptSet(state.currentPrompt.set);
    const item = ps?.items?.[state.currentPrompt.idx];
    if (!item) return null;
    if (!['fixed', 'ai_editable', 'firm'].includes(item.mode)) return null;
    return { ps, item, set: state.currentPrompt.set, idx: state.currentPrompt.idx };
}

async function updateItemMode(newMode) {
    const cur = _editingItem();
    if (!cur) return;
    const oldMode = cur.item.mode;
    if (oldMode === newMode) return;
    tagSrcIdx(cur.ps);
    cur.item.mode = newMode;
    if (newMode === 'firm' && !cur.item.role) cur.item.role = 'system';
    await api(`/prompt-sets/${encodeURIComponent(cur.set)}/structure`,
        { method: 'PUT', body: cur.ps });
    // 转入 firm 时自动用当前 .md 作基线
    if (newMode === 'firm' && oldMode !== 'firm') {
        await api(`/prompt-sets/${encodeURIComponent(cur.set)}/item/${cur.idx}/lock`,
            { method: 'POST' });
    }
    await loadPromptSets();                // 树渲染一次（图标/边框反映新模式）
    _syncEditorViewToCurrentItem();        // 顶部状态栏轻量同步，不再触发二次树渲染 → 不闪烁
    setStatus(`模式已切到 ${newMode}`);
}

async function updateItemRole(newRole) {
    const cur = _editingItem();
    if (!cur) return;
    if (cur.item.role === newRole) return;
    tagSrcIdx(cur.ps);
    cur.item.role = newRole;
    await api(`/prompt-sets/${encodeURIComponent(cur.set)}/structure`,
        { method: 'PUT', body: cur.ps });
    await loadPromptSets();
    setStatus(`角色已切到 ${newRole}`);
}

async function updateItemTitle() {
    const cur = _editingItem();
    if (!cur) return;
    const newTitle = document.getElementById('item-title-input').value.trim();
    if (!newTitle) {
        // 空标题 → 还原到旧值，标题不允许空
        document.getElementById('item-title-input').value = cur.item.title;
        return;
    }
    if (cur.item.title === newTitle) return;
    tagSrcIdx(cur.ps);
    cur.item.title = newTitle;
    await api(`/prompt-sets/${encodeURIComponent(cur.set)}/structure`,
        { method: 'PUT', body: cur.ps });
    await loadPromptSets();
    // 同步刷新编辑器顶部 current-label
    const prefix = cur.item.mode === 'firm' ? '[FIRM]' : '[提示词]';
    document.getElementById('current-label').textContent = `${prefix} ${cur.set} / ${newTitle}`;
}

// ── Drag reorder prompt sets ──
let draggedPs = null;
function dragPsStart(e) {
    draggedPs = e.currentTarget.dataset.promptset;
    e.currentTarget.style.opacity = '0.4';
    e.dataTransfer.effectAllowed = 'move';
}
async function dragPsDrop(e) {
    e.preventDefault();
    const target = e.currentTarget.dataset.promptset;
    if (!draggedPs || draggedPs === target) return;
    const names = state.promptSets.map(ps => ps.name);
    const fromIdx = names.indexOf(draggedPs);
    const toIdx = names.indexOf(target);
    names.splice(fromIdx, 1);
    names.splice(toIdx, 0, draggedPs);
    await api('/prompt-sets/reorder', { method: 'POST', body: { names } });
    draggedPs = null;
    await loadPromptSets();
}

// ── Drag reorder items within a prompt set ──
let dragItemInfo = null; // {psName, idx}

function dragItemStart(e) {
    const psName = e.currentTarget.dataset.ps;
    const idx = parseInt(e.currentTarget.dataset.idx);
    dragItemInfo = { psName, idx };
    e.currentTarget.style.opacity = '0.4';
    e.dataTransfer.effectAllowed = 'move';
    e.stopPropagation(); // Don't trigger parent ps drag
}

function dragItemOver(e) {
    e.preventDefault();
    e.stopPropagation();
    document.querySelectorAll('.ps-item.drag-over').forEach(el => el.classList.remove('drag-over'));
    e.currentTarget.classList.add('drag-over');
}

function dragItemEnd(e) {
    e.currentTarget.style.opacity = '1';
    document.querySelectorAll('.ps-item.drag-over').forEach(el => el.classList.remove('drag-over'));
}

async function dragItemDrop(e) {
    e.preventDefault();
    e.stopPropagation();
    const targetPs = e.currentTarget.dataset.ps;
    const targetIdx = parseInt(e.currentTarget.dataset.idx);
    if (!dragItemInfo || dragItemInfo.psName !== targetPs || dragItemInfo.idx === targetIdx) {
        dragItemInfo = null;
        return;
    }
    const ps = getPromptSet(targetPs);
    tagSrcIdx(ps);                         // 在 splice 前标记，每个 item 带着自己的 _src_idx 跟着移动
    const [moved] = ps.items.splice(dragItemInfo.idx, 1);
    ps.items.splice(targetIdx, 0, moved);
    dragItemInfo = null;
    await api(`/prompt-sets/${encodeURIComponent(targetPs)}/structure`, { method: 'PUT', body: ps });
    // Fix currentPrompt index if needed
    if (state.currentPrompt?.set === targetPs) {
        const newIdx = ps.items.indexOf(moved);
        if (newIdx >= 0) state.currentPrompt.idx = newIdx;
    }
    await loadPromptSets();
}

// ── Editor auto-save (handles both modes) ──
document.getElementById('editor').addEventListener('input', () => {
    clearTimeout(state.saveTimer);
    if (state.editorMode === 'novel' && !state.current) return;
    if (state.editorMode === 'prompt' && !state.currentPrompt) return;
    setStatus('未保存...');
    state.saveTimer = setTimeout(() => saveEditor(), 1500);
});

async function saveEditor() {
    const content = document.getElementById('editor').value;
    if (state.editorMode === 'prompt' && state.currentPrompt) {
        // Don't save read-only views (context, chapter, preview)
        if (state.currentPrompt.set === '_preview') return;
        const ps = getPromptSet(state.currentPrompt.set);
        const item = ps?.items?.[state.currentPrompt.idx];
        if (item && ['context', 'chapter', 'reference', 'catalog', 'read_hint', 'latest_input', 'file_repo', 'firm'].includes(item.mode)) return;
        const { set, idx } = state.currentPrompt;
        await api(`/prompt-sets/${encodeURIComponent(set)}/item/${idx}`, {
            method: 'PUT', body: { content }
        });
        setStatus('已保存');
    } else if (state.editorMode === 'novel' && state.current) {
        const { novel, vol, chap } = state.current;
        await api(`/novels/${encodeURIComponent(novel)}/chapter/${vol}/${chap}`, {
            method: 'PUT', body: { content }
        });
        setStatus('已保存');
    }
}

async function saveCurrentChapter() { await saveEditor(); }

function setStatus(text) {
    document.getElementById('editor-status').textContent = text;
}

// ── Chat ──
function clearChat() {
    state.chatMessages = [];
    document.getElementById('chat-messages').innerHTML = '';
}

function splitThink(content) {
    // 优先匹配完整的 <think>...</think>（推理模型流式结束后的标准形态）
    const reFull = /<think>([\s\S]*?)<\/think>/i;
    const mFull = reFull.exec(content);
    if (mFull) {
        const think = mFull[1].trim();
        const visible = content.slice(mFull.index + mFull[0].length).trim();
        return { think, visible };
    }
    // 流式中：<think> 已开但 </think> 还没到 → 整段都是思维链，正文区先空着
    const reOpen = /<think>([\s\S]*)$/i;
    const mOpen = reOpen.exec(content);
    if (mOpen) {
        const before = content.slice(0, mOpen.index).trim();
        return { think: mOpen[1].trim(), visible: before };
    }
    return { think: '', visible: content };
}

function renderChatMessages() {
    const container = document.getElementById('chat-messages');
    container.innerHTML = state.chatMessages.map((m, i) => {
        // 编辑态：替换为 textarea + 保存/取消按钮
        if (state.editingChatMsg === i) {
            return `<div class="msg ${m.role} editing">
                <textarea id="chat-edit-${i}" class="chat-edit-textarea">${escHtml(m.content)}</textarea>
                <div class="msg-actions">
                    <button onclick="finishEditChatMsg(${i})">保存</button>
                    <button onclick="cancelEditChatMsg()">取消</button>
                </div>
            </div>`;
        }
        // 编辑/删除按钮：所有消息（user 和 assistant）都有
        const editDelBtns = `<button onclick="startEditChatMsg(${i})">编辑</button><button onclick="deleteChatMsg(${i})">删除</button>`;
        if (m.role !== 'assistant') {
            return `<div class="msg ${m.role}">${escHtml(m.content)}<div class="msg-actions">${editDelBtns}</div></div>`;
        }
        const { think, visible } = splitThink(m.content);
        // 流式中（visible 还为空）→ 思维链默认展开，用户实时看到推理
        // 正文出现后 → 默认收起，用户点按钮再展开
        const thinkOpen = think && !visible;
        const thinkBtn = think
            ? `<button onclick="toggleThink(this,${i})">${thinkOpen ? '隐藏思考' : '思考'}</button>`
            : '';
        const thinkBlock = think
            ? `<div class="msg-think" id="think-${i}" style="display:${thinkOpen ? 'block' : 'none'};">${escHtml(think)}</div>`
            : '';
        const actions = `<div class="msg-actions">
                <button onclick="insertToEditor(${i})">插入到编辑器</button>
                <button onclick="replaceEditor(${i})">替换编辑器</button>
                <button onclick="copyMsg(${i})">复制</button>
                ${thinkBtn}
                ${editDelBtns}
               </div>`;
        return `<div class="msg ${m.role}">${thinkBlock}${escHtml(visible)}${actions}</div>`;
    }).join('');
    container.scrollTop = container.scrollHeight;
}

// ── 单条聊天消息编辑/删除 ──
function startEditChatMsg(idx) {
    if (idx < 0 || idx >= state.chatMessages.length) return;
    state.editingChatMsg = idx;
    renderChatMessages();
    setTimeout(() => {
        const ta = document.getElementById(`chat-edit-${idx}`);
        if (ta) { ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); }
    }, 10);
}

function finishEditChatMsg(idx) {
    if (state.editingChatMsg !== idx) return;
    const ta = document.getElementById(`chat-edit-${idx}`);
    if (ta) {
        const newContent = ta.value;
        if (state.chatMessages[idx]) {
            state.chatMessages[idx].content = newContent;
        }
    }
    state.editingChatMsg = null;
    renderChatMessages();
}

function cancelEditChatMsg() {
    state.editingChatMsg = null;
    renderChatMessages();
}

function deleteChatMsg(idx) {
    if (idx < 0 || idx >= state.chatMessages.length) return;
    if (!confirm('删除这条消息？此操作不可撤销。')) return;
    state.chatMessages.splice(idx, 1);
    if (state.editingChatMsg === idx) state.editingChatMsg = null;
    renderChatMessages();
}

function toggleThink(btn, idx) {
    const el = document.getElementById('think-' + idx);
    if (!el) return;
    const hidden = el.style.display === 'none';
    el.style.display = hidden ? 'block' : 'none';
    btn.textContent = hidden ? '隐藏思考' : '思考';
}

function escHtml(s) {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function getVisibleContent(idx) {
    return splitThink(state.chatMessages[idx].content).visible;
}

function insertToEditor(idx) {
    const editor = document.getElementById('editor');
    const text = getVisibleContent(idx);
    const pos = editor.selectionStart;
    const before = editor.value.slice(0, pos);
    const after = editor.value.slice(pos);
    editor.value = before + text + after;
    editor.dispatchEvent(new Event('input'));
}

function replaceEditor(idx) {
    if (!confirm('确定替换编辑器中的全部内容？')) return;
    document.getElementById('editor').value = getVisibleContent(idx);
    document.getElementById('editor').dispatchEvent(new Event('input'));
}

function copyMsg(idx) {
    navigator.clipboard.writeText(getVisibleContent(idx));
}

// ── Build messages from prompt set items in order (Phase 2: unified messages array) ──
// Each enabled item emits one or more {role, content} entries.
// The output order EXACTLY matches the order in the left panel.
//
// opts.treatLastAsCurrentMessage: when true (sendChat 调用时), 表示 state.chatMessages 末尾的那条
//   就是用户刚发的当前消息——若同时存在 latest_input 和 context 两个条目，context 展开时会跳过末尾以避免重复。
async function buildMessages(overrideLatestInput, opts = {}) {
    if (!state.activePromptSet) return { messages: [], consumedLatestInput: false, hasContext: false };

    const data = await api(`/prompt-sets/${encodeURIComponent(state.activePromptSet)}/all-items`);
    const items = data.items || [];
    const messages = [];
    let consumedLatestInput = false;

    // 预扫描：判断是否需要在 context 展开时排除末尾消息（去重）
    const hasLatestInputItem = items.some(it => it.mode === 'latest_input');
    const hasContextItem = items.some(it => it.mode === 'context');
    const excludeLastFromContext = !!opts.treatLastAsCurrentMessage && hasLatestInputItem && hasContextItem;

    // Current chapter content (used by chapter mode)
    let chapterContent = '';
    if (state.current) {
        if (state.editorMode === 'novel') {
            chapterContent = document.getElementById('editor').value || '';
        } else {
            const ch = await api(`/novels/${encodeURIComponent(state.current.novel)}/chapter/${state.current.vol}/${state.current.chap}`);
            chapterContent = ch.content || '';
        }
    }

    const push = (role, content) => {
        if (content && String(content).trim()) {
            messages.push({ role, content: String(content) });
        }
    };

    for (const it of items) {
        const role = it.role || 'system';

        if (it.mode === 'context') {
            // 把对话历史按真实 role 在此位置展开
            let history = state.chatMessages.filter(m => !m._preview);
            if (excludeLastFromContext) history = history.slice(0, -1);
            for (const m of history) {
                push(m.role, splitThink(m.content).visible);
            }
            continue;
        }
        if (it.mode === 'latest_input') {
            consumedLatestInput = true;
            const liveText = (overrideLatestInput !== undefined)
                ? overrideLatestInput
                : (document.getElementById('chat-input')?.value || '');
            // 用户最新发言固定按 user 角色发出
            push('user', liveText);
            continue;
        }
        if (it.mode === 'chapter') {
            // 给当前章节加"【当前章节: 小说 / 卷 / 章】"标题头，让 AI 知道在读哪一章
            if (chapterContent && state.current) {
                const header = _chapterHeader(state.current.novel, state.current.vol, state.current.chap, '当前章节: ');
                push(role, `${header}\n${chapterContent}`);
            } else {
                push(role, chapterContent);
            }
            continue;
        }
        if (it.mode === 'reference') {
            // 按小说+卷+章顺序排序，并给每个参考章节加标题头
            for (const rc of sortRefChapters(it.chapters || [])) {
                try {
                    const ch = await api(`/novels/${encodeURIComponent(rc.novel)}/chapter/${rc.vol}/${rc.chap}`);
                    if (ch.content) {
                        const header = _chapterHeader(rc.novel, rc.vol, rc.chap, '参考章节: ');
                        push(role, `${header}\n${ch.content}`);
                    }
                } catch {}
            }
            continue;
        }
        if (it.mode === 'read_hint') {
            push(role, it.content || '');
            continue;
        }
        if (it.mode === 'catalog') {
            if (state.novels.length > 0) {
                const index = state.novels.map(n => {
                    const vols = (n.volumes || []).map((v, vi) => {
                        const chs = (v.chapters || []).map((c, ci) => `    [${vi},${ci}] ${c.title}`).join('\n');
                        return `  ${v.title}:\n${chs}`;
                    }).join('\n');
                    return `${n.name}:\n${vols}`;
                }).join('\n');
                push(role, `[可用章节目录]\n${index}`);
            }
            continue;
        }
        if (it.mode === 'file_repo') {
            try {
                const repo = await api('/file-repo/tree');
                if (repo.tree) {
                    const intro = it.content || '';
                    push(role, `${intro}\n文件列表:\n${repo.tree}`);
                }
            } catch {}
            continue;
        }
        // 普通用户内容（fixed / ai_editable）
        let content = (it.content || '').trim();
        if (!content) continue;
        if (it.mode === 'ai_editable') {
            content += `\n[可修改：若需更新此条目，在回复末尾加 <<<UPDATE:${it.title}>>>新内容<<<END>>>]`;
        }
        push(role, content);
    }

    return { messages, consumedLatestInput, hasContext: hasContextItem };
}

// ── Send chat ──
let currentChatAbortController = null;

function stopChat() {
    if (currentChatAbortController) {
        currentChatAbortController.abort();
        currentChatAbortController = null;
    }
}

function setChatBusy(busy) {
    const sendBtn = document.getElementById('chat-send');
    const stopBtn = document.getElementById('chat-stop');
    sendBtn.style.display = busy ? 'none' : '';
    stopBtn.style.display = busy ? '' : 'none';
    sendBtn.disabled = busy;
}

async function sendChat() {
    const input = document.getElementById('chat-input');
    const text = input.value.trim();
    if (!text) return;
    if (currentChatAbortController) return;  // 防重入：流中再点不发新消息
    input.value = '';
    // 重置输入框高度（清空后视觉残留）
    input.style.height = 'auto';
    document.querySelectorAll('.latest-input-badge').forEach(el => el.textContent = '0字');

    await saveEditor();

    state.chatMessages.push({ role: 'user', content: text });
    renderChatMessages();

    setChatBusy(true);

    // 阶段 2：用统一 messages 数组发送
    const { messages: built, consumedLatestInput, hasContext } = await buildMessages(text, { treatLastAsCurrentMessage: true });

    let finalMessages = built;
    // 若既没有 latest_input 也没有 context 条目，当前消息没有任何路径进入 messages → 末尾追加
    if (!consumedLatestInput && !hasContext) {
        finalMessages = [...finalMessages, { role: 'user', content: text }];
    }
    // 兜底：messages 完全为空（用户 prompt set 极简）则补一条
    if (finalMessages.length === 0) {
        finalMessages = [{ role: 'user', content: text || '(空)' }];
    }

    const body = { messages: finalMessages };

    // 注：以前这里会调 showSentContent(finalMessages) 自动展示发送内容到编辑器，
    // 但那会污染当前章节/提示词文件。现在仅在用户手动点"预览发送"时才显示，sendChat 不再自动展示。

    currentChatAbortController = new AbortController();
    let assistantMsg = { role: 'assistant', content: '' };
    let aborted = false;

    try {
        const res = await fetch('/api/chat', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
            signal: currentChatAbortController.signal,
        });

        const reader = res.body.getReader();
        const decoder = new TextDecoder('utf-8');
        state.chatMessages.push(assistantMsg);

        let buffer = '';
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop();
            for (const line of lines) {
                if (!line.startsWith('data: ')) continue;
                const data = line.slice(6);
                if (data === '[DONE]') continue;
                try {
                    const obj = JSON.parse(data);
                    if (obj.error) {
                        assistantMsg.content += `\n[错误: ${obj.error}]`;
                    } else {
                        // DeepSeek-R1 / 推理模型流式：reasoning_content 是思维链，content 是正文
                        // 把 reasoning 用 <think>...</think> 包起来，前端 splitThink 会自动识别
                        const reasoning = obj.choices?.[0]?.delta?.reasoning_content || '';
                        const delta = obj.choices?.[0]?.delta?.content || '';
                        if (reasoning) {
                            if (!assistantMsg._thinkOpen) {
                                assistantMsg.content += '<think>';
                                assistantMsg._thinkOpen = true;
                            }
                            assistantMsg.content += reasoning;
                        }
                        if (delta) {
                            // 正文出现时关闭 <think>（如果还开着）
                            if (assistantMsg._thinkOpen) {
                                assistantMsg.content += '</think>';
                                assistantMsg._thinkOpen = false;
                            }
                            assistantMsg.content += delta;
                        }
                    }
                } catch {}
            }
            renderChatMessages();
        }

        // 流结束兜底：思维链未关闭（无后续正文）→ 补一个 </think>
        if (assistantMsg._thinkOpen) {
            assistantMsg.content += '</think>';
            assistantMsg._thinkOpen = false;
        }

        // After streaming complete, check for AI updates
        await processAiUpdates(assistantMsg);

    } catch (e) {
        if (e.name === 'AbortError') {
            aborted = true;
            assistantMsg.content += '\n\n[⏹ 用户已停止生成]';
        } else {
            state.chatMessages.push({ role: 'assistant', content: `[连接错误: ${e.message}]` });
        }
    }
    currentChatAbortController = null;
    renderChatMessages();
    setChatBusy(false);
}

// ── Process AI auto-updates from response ──
async function processAiUpdates(assistantMsg) {
    if (!state.activePromptSet) return;
    const regex = /<<<UPDATE:(.*?)>>>([\s\S]*?)<<<END>>>/g;
    const updates = [];
    let match;
    while ((match = regex.exec(assistantMsg.content)) !== null) {
        updates.push({ title: match[1].trim(), content: match[2].trim() });
    }
    if (updates.length > 0) {
        // Send updates to backend
        await api(`/prompt-sets/${encodeURIComponent(state.activePromptSet)}/ai-update`, {
            method: 'POST', body: { updates }
        });
        // Remove update directives from displayed message
        assistantMsg.content = assistantMsg.content.replace(regex, '').trim();
        // Reload prompt sets to reflect changes
        await loadPromptSets();
        // If currently editing an updated item, reload editor
        if (state.editorMode === 'prompt' && state.currentPrompt) {
            const data = await api(`/prompt-sets/${encodeURIComponent(state.currentPrompt.set)}/item/${state.currentPrompt.idx}`);
            document.getElementById('editor').value = data.content || '';
        }
    }
}

// Enter 发送 / Shift+Enter 换行（保留 Ctrl+Enter 兼容旧习惯）
document.getElementById('chat-input').addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        sendChat();
    }
    // Shift+Enter 走 textarea 默认行为（插入换行），不拦截
});

// Auto-resize chat input + 实时镜像到 latest_input 条目字数 badge
document.getElementById('chat-input').addEventListener('input', function() {
    this.style.height = 'auto';
    this.style.height = Math.min(this.scrollHeight, 120) + 'px';
    // 镜像到左侧"用户最新发言"条目（targeted update，不重渲染整棵树）
    const len = this.value.length;
    document.querySelectorAll('.latest-input-badge').forEach(el => {
        el.textContent = `${len}字`;
    });
    // 如果编辑器正显示 latest_input 预览，同步内容
    if (state.currentPrompt && state.editorMode === 'prompt') {
        const ps = getPromptSet(state.currentPrompt.set);
        const item = ps?.items?.[state.currentPrompt.idx];
        if (item?.mode === 'latest_input') {
            document.getElementById('editor').value = this.value;
        }
    }
});

// ── 发送内容预览 ──
// 修复历史 BUG：之前直接写入 #editor textarea，会污染当前章节/提示词文件（saveEditor 把预览
// 当真实内容存盘）。现在用独立 modal，完全不碰 #editor。Toggle 行为：再点同一按钮则关闭。

let _previewOverlay = null;

function _formatMessagesForPreview(messages) {
    if (!messages || messages.length === 0) return '(messages 数组为空)';
    return messages.map(m => `[${(m.role || '').toUpperCase()}]\n${m.content}`).join('\n\n');
}

function showPreviewModal(text) {
    // 已开就先关掉旧的
    if (_previewOverlay) {
        _previewOverlay.remove();
        _previewOverlay = null;
    }
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay preview-overlay';
    const pre = document.createElement('pre');
    pre.className = 'preview-content';
    pre.textContent = text;  // 用 textContent 自动转义，不会被 HTML 解析
    overlay.innerHTML = `<div class="modal preview-modal">
        <div class="preview-header">
            <h3>实际发送内容预览</h3>
            <button class="tree-btn" id="preview-close-btn" title="关闭">✕</button>
        </div>
        <div class="preview-body"></div>
    </div>`;
    overlay.querySelector('.preview-body').appendChild(pre);
    document.body.appendChild(overlay);
    overlay.querySelector('#preview-close-btn').onclick = hidePreviewModal;
    overlay.addEventListener('click', e => { if (e.target === overlay) hidePreviewModal(); });
    _previewOverlay = overlay;
}

function hidePreviewModal() {
    if (_previewOverlay) {
        _previewOverlay.remove();
        _previewOverlay = null;
    }
}

async function previewPrompt() {
    // Toggle：已开就关
    if (_previewOverlay) {
        hidePreviewModal();
        setStatus('已关闭预览');
        return;
    }
    await saveEditor();
    const { messages } = await buildMessages(undefined, { treatLastAsCurrentMessage: false });
    showPreviewModal(_formatMessagesForPreview(messages));
    setStatus('发送预览');
}

// ── Settings modal ──
async function openSettings() {
    const cfg = await api('/config');
    const presets = cfg.presets || {};
    const presetNames = Object.keys(presets);
    const activePreset = cfg.active_preset || '';
    const presetOptions = presetNames.map(name =>
        `<option value="${escHtml(name)}" ${name === activePreset ? 'selected' : ''}>${escHtml(name)}</option>`
    ).join('');

    // merge_semi 是早期内部别名，统一映射到 semi_tools
    const mergeModeRaw = cfg.merge_mode || 'none';
    const mergeMode = mergeModeRaw === 'merge_semi' ? 'semi_tools' : mergeModeRaw;
    const sel = (v) => mergeMode === v ? 'selected' : '';
    const thinkingMode = cfg.thinking_mode || 'auto';
    const reasoningEffort = cfg.reasoning_effort || 'auto';
    const tsel = (v) => thinkingMode === v ? 'selected' : '';
    const rsel = (v) => reasoningEffort === v ? 'selected' : '';
    showModal('设置', `
        ${presetNames.length > 0 ? `
        <label>API 预设</label>
        <div style="display:flex;gap:6px;margin-bottom:8px;">
            <select id="cfg-preset" style="flex:1;padding:6px;border-radius:4px;border:1px solid #ccc;">
                <option value="">自定义</option>
                ${presetOptions}
            </select>
        </div>
        ` : ''}
        <label>服务端口</label>
        <input id="cfg-port" type="number" value="${cfg.port}">
        <label>API 地址</label>
        <input id="cfg-url" value="${escHtml(cfg.api_url)}">
        <label>API Key（可选）</label>
        <input id="cfg-key" value="${escHtml(cfg.api_key || '')}">
        <label>模型</label>
        <input id="cfg-model" value="${escHtml(cfg.model)}">
        <label>思考模式（DeepSeek V4 Pro / Claude 4 / OpenAI o-系列支持）</label>
        <select id="cfg-thinking-mode">
            <option value="auto" ${tsel('auto')}>自动 — 用模型默认（不发 thinking 字段）</option>
            <option value="enabled" ${tsel('enabled')}>开启 — 显式启用思考链</option>
            <option value="disabled" ${tsel('disabled')}>关闭 — 跳过思考省 token、加快响应</option>
        </select>
        <label>思考深度（思考关闭时本字段不发送）</label>
        <select id="cfg-reasoning-effort">
            <option value="auto" ${rsel('auto')}>自动 — 用模型默认</option>
            <option value="low" ${rsel('low')}>低 — 快速，简单任务</option>
            <option value="medium" ${rsel('medium')}>中 — 平衡</option>
            <option value="high" ${rsel('high')}>高 — 深度推理，关键剧情</option>
        </select>
        <label>消息后处理（API 角色兼容）</label>
        <select id="cfg-merge-mode">
            <option value="none" ${sel('none')}>无 — 原样发送（OpenAI / Claude / 多数 API）</option>
            <optgroup label="无工具调用（删除 tool_calls 字段）">
                <option value="merge" ${sel('merge')}>合并相同角色连续发言</option>
                <option value="semi" ${sel('semi')}>半严格 — 合并 + 非首条 system 变 user</option>
                <option value="strict" ${sel('strict')}>严格 — 半严格 + 强制 user 先于 assistant</option>
                <option value="single" ${sel('single')}>单一消息 — 全部塞成一条 user</option>
            </optgroup>
            <optgroup label="保留工具调用（tool_calls / role:tool）">
                <option value="merge_tools" ${sel('merge_tools')}>合并相同角色连续发言（含工具）</option>
                <option value="semi_tools" ${sel('semi_tools')}>半严格（含工具）— DeepSeek 推荐</option>
                <option value="strict_tools" ${sel('strict_tools')}>严格（含工具）— Perplexity 推荐</option>
            </optgroup>
        </select>
    `, async () => {
        const selectedPreset = document.getElementById('cfg-preset')?.value || '';
        await api('/config', { method: 'PUT', body: {
            port: parseInt(document.getElementById('cfg-port').value),
            api_url: document.getElementById('cfg-url').value,
            api_key: document.getElementById('cfg-key').value,
            model: document.getElementById('cfg-model').value,
            thinking_mode: document.getElementById('cfg-thinking-mode').value,
            reasoning_effort: document.getElementById('cfg-reasoning-effort').value,
            merge_mode: document.getElementById('cfg-merge-mode').value,
            active_preset: selectedPreset,
        }});
    });

    // Wire up preset switcher 和 "思考关闭时禁用深度下拉"
    setTimeout(() => {
        const presetSel = document.getElementById('cfg-preset');
        if (presetSel) {
            presetSel.addEventListener('change', () => {
                const name = presetSel.value;
                const p = presets[name];
                if (p) {
                    document.getElementById('cfg-url').value = p.api_url || '';
                    document.getElementById('cfg-key').value = p.api_key || '';
                    document.getElementById('cfg-model').value = p.model || '';
                }
            });
        }
        const thinkSel = document.getElementById('cfg-thinking-mode');
        const effortSel = document.getElementById('cfg-reasoning-effort');
        const syncEffortDisabled = () => {
            const disabled = thinkSel?.value === 'disabled';
            if (effortSel) {
                effortSel.disabled = disabled;
                effortSel.style.opacity = disabled ? '0.4' : '1';
            }
        };
        thinkSel?.addEventListener('change', syncEffortDisabled);
        syncEffortDisabled();  // 初始化时先同步一次
    }, 50);
}

// ── Modal helpers ──
// 替代原生 prompt()：单文本输入弹窗，回调收到 trimmed 字符串（空则不调）。
// 统一 UI 风格 + 解决 prompt() 的样式丑陋、阻塞主线程问题。
function showInputModal(title, label, defaultValue, onSubmit) {
    showModal(title, `
        <label>${escHtml(label)}</label>
        <input id="show-input-modal-input" type="text" value="${escHtml(defaultValue || '')}">
    `, async () => {
        const v = (document.getElementById('show-input-modal-input')?.value || '').trim();
        if (!v) return;
        await onSubmit(v);
    });
    // 自动聚焦 + 选中默认文本（方便 rename 场景一键替换）
    setTimeout(() => {
        const el = document.getElementById('show-input-modal-input');
        if (el) { el.focus(); el.select(); }
    }, 50);
}

function showModal(title, html, onSave) {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.innerHTML = `<div class="modal">
        <h3>${title}</h3>
        ${html}
        <div class="modal-btns">
            <button class="btn-secondary" id="modal-cancel">取消</button>
            <button class="btn-primary" id="modal-save">保存</button>
        </div>
    </div>`;
    document.body.appendChild(overlay);
    overlay.querySelector('#modal-cancel').onclick = () => overlay.remove();
    overlay.querySelector('#modal-save').onclick = async () => {
        await onSave();
        overlay.remove();
    };
    overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });
}

// ── Init ──
loadNovels();
loadPromptSets();
