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
                return `<div class="tree-chap ${active ? 'active' : ''}" onclick="selectChapter('${esc(novel.name)}',${vi},${ci})">
                    ${refCheck}
                    <span>${ch.title}</span>
                    <button class="tree-btn chap-rename" onclick="event.stopPropagation();renameChap('${esc(novel.name)}',${vi},${ci})" title="重命名">✏</button>
                </div>`;
            }).join('');
            const volArrow = volCollapsed ? '▸' : '▾';
            return `<div class="tree-vol">
                <div class="tree-vol-title" onclick="toggleVol('${esc(novel.name)}',${vi})">
                    <span>${volArrow} ${vol.title}</span>
                    <span class="tree-actions">
                        <button class="tree-btn" onclick="event.stopPropagation();renameVol('${esc(novel.name)}',${vi})" title="重命名">✏</button>
                        <button class="tree-btn" onclick="event.stopPropagation();addChapter('${esc(novel.name)}',${vi})" title="添加章节">+</button>
                    </span>
                </div>
                ${chapters}
            </div>`;
        }).join('');
        const novelArrow = novelCollapsed ? '▸' : '▾';
        return `<div class="tree-novel" draggable="true" data-novel="${escHtml(novel.name)}" ondragstart="dragNovelStart(event)" ondragover="dragNovelOver(event)" ondrop="dragNovelDrop(event)">
            <div class="tree-novel-title ${isActive ? 'active' : ''}" onclick="toggleNovel('${esc(novel.name)}')">
                <span>${novelArrow} ${novel.name}</span>
                <span class="tree-actions">
                    <button class="tree-btn" onclick="event.stopPropagation();renameNovel('${esc(novel.name)}')" title="重命名">✏</button>
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
    const name = prompt('小说名称：');
    if (!name?.trim()) return;
    const res = await api('/novels', { method: 'POST', body: { name: name.trim() } });
    if (res.error) { alert(res.error); return; }
    await loadNovels();
    selectChapter(name.trim(), 0, 0);
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
    const title = prompt('卷名称：', `第${getNovel(novelName).volumes.length + 1}卷`);
    if (!title?.trim()) return;
    const novel = getNovel(novelName);
    novel.volumes.push({ title: title.trim(), chapters: [{ title: '第一章' }] });
    await api(`/novels/${encodeURIComponent(novelName)}/structure`, { method: 'PUT', body: novel });
    await loadNovels();
}

async function addChapter(novelName, volIdx) {
    const vol = getNovel(novelName).volumes[volIdx];
    const title = prompt('章节名称：', `第${vol.chapters.length + 1}章`);
    if (!title?.trim()) return;
    const novel = getNovel(novelName);
    novel.volumes[volIdx].chapters.push({ title: title.trim() });
    await api(`/novels/${encodeURIComponent(novelName)}/structure`, { method: 'PUT', body: novel });
    await loadNovels();
}

function getNovel(name) { return state.novels.find(n => n.name === name); }

// ── Chapter selection ──
async function selectChapter(novelName, vol, chap) {
    await saveEditor();
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

async function renameNovel(oldName) {
    const newName = prompt('重命名小说：', oldName);
    if (!newName?.trim() || newName.trim() === oldName) return;
    const res = await fetch(`/api/novels/${encodeURIComponent(oldName)}/rename`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ new_name: newName.trim() }),
    });
    const data = await res.json();
    if (data.error) { alert(data.error); return; }
    if (state.current?.novel === oldName) state.current.novel = newName.trim();
    await loadNovels();
}

async function renameVol(novelName, vi) {
    const novel = getNovel(novelName);
    const oldTitle = novel.volumes[vi].title;
    const newTitle = prompt('重命名卷：', oldTitle);
    if (!newTitle?.trim() || newTitle.trim() === oldTitle) return;
    novel.volumes[vi].title = newTitle.trim();
    await api(`/novels/${encodeURIComponent(novelName)}/structure`, { method: 'PUT', body: novel });
    await loadNovels();
}

async function renameChap(novelName, vi, ci) {
    const novel = getNovel(novelName);
    const oldTitle = novel.volumes[vi].chapters[ci].title;
    const newTitle = prompt('重命名章节：', oldTitle);
    if (!newTitle?.trim() || newTitle.trim() === oldTitle) return;
    novel.volumes[vi].chapters[ci].title = newTitle.trim();
    await api(`/novels/${encodeURIComponent(novelName)}/structure`, { method: 'PUT', body: novel });
    await loadNovels();
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
            const isBuiltin = ['context', 'chapter', 'reference', 'catalog', 'read_hint'].includes(it.mode);
            const isEditing = state.currentPrompt?.set === ps.name && state.currentPrompt?.idx === idx && state.editorMode === 'prompt';
            const modeIcons = { context: '💬', chapter: '📄', reference: '📚', catalog: '📑', read_hint: '💡', ai_editable: '✏️', fixed: '🔒' };
            const modeIcon = modeIcons[it.mode] || '🔒';
            const modeTitles = { context: '上下文', chapter: '当前章节', reference: '参考章节', catalog: '章节目录', read_hint: '读取指令说明' };
            const modeBtn = isBuiltin
                ? `<span class="ps-mode-icon" title="${modeTitles[it.mode] || it.mode}">${modeIcon}</span>`
                : `<button class="ps-mode-btn" onclick="event.stopPropagation();toggleItemMode('${esc(ps.name)}',${idx})" title="${it.mode === 'ai_editable' ? 'AI可改→固定' : '固定→AI可改'}">${modeIcon}</button>`;
            const enabledCheck = `<input type="checkbox" ${it.enabled ? 'checked' : ''} onclick="event.stopPropagation();toggleItemEnabled('${esc(ps.name)}',${idx},this.checked)">`;
            const clickHandler = it.mode === 'reference'
                ? `onclick="toggleRefCollapse('${esc(ps.name)}')"`
                : `onclick="selectPromptItem('${esc(ps.name)}',${idx})"`;
            const deleteBtn = isBuiltin ? '' : `<button class="tree-btn ps-del" onclick="event.stopPropagation();deletePromptItem('${esc(ps.name)}',${idx})" title="删除">×</button>`;
            const renameBtn = isBuiltin ? '' : `<button class="tree-btn ps-ren" onclick="event.stopPropagation();renamePromptItem('${esc(ps.name)}',${idx})" title="重命名">✏</button>`;

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
                const chapters = it.chapters || [];
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

            return `<div class="ps-item ${isEditing ? 'active' : ''} ${!it.enabled ? 'disabled' : ''}" draggable="true" data-ps="${escHtml(ps.name)}" data-idx="${idx}"
                        ondragstart="dragItemStart(event)" ondragover="dragItemOver(event)" ondrop="dragItemDrop(event)" ondragend="dragItemEnd(event)"
                        ${clickHandler}>
                ${enabledCheck}
                ${modeBtn}
                <span class="ps-item-title">${escHtml(it.title)}</span>
                ${charsBadge}
                <span class="ps-item-actions">${renameBtn}${deleteBtn}</span>
            </div>`;
        }).join('');
        const psArrow = psCollapsed ? '▸' : '▾';
        const selectedMark = isActive ? ' ✓' : '';
        return `<div class="ps-group" draggable="true" data-promptset="${escHtml(ps.name)}" ondragstart="dragPsStart(event)" ondragover="dragNovelOver(event)" ondrop="dragPsDrop(event)">
            <div class="ps-group-title ${isActive ? 'active' : ''}" onclick="togglePromptSetCollapse('${esc(ps.name)}')">
                <span>${psArrow} ${ps.name}${selectedMark}</span>
                <span class="tree-actions">
                    <button class="tree-btn" onclick="event.stopPropagation();selectActivePromptSet('${esc(ps.name)}')" title="选为当前提示词集">☑</button>
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

function selectActivePromptSet(name) {
    state.activePromptSet = state.activePromptSet === name ? null : name;
    renderPromptSetsTree();
}

// ── Prompt Set CRUD ──
async function createPromptSet() {
    const name = prompt('提示词集名称：');
    if (!name?.trim()) return;
    const res = await api('/prompt-sets', { method: 'POST', body: { name: name.trim() } });
    if (res.error) { alert(res.error); return; }
    state.activePromptSet = name.trim();
    await loadPromptSets();
}

async function deletePromptSet(name) {
    if (!confirm(`确定删除提示词集「${name}」？`)) return;
    await api(`/prompt-sets/${encodeURIComponent(name)}`, { method: 'DELETE' });
    if (state.activePromptSet === name) state.activePromptSet = null;
    if (state.currentPrompt?.set === name) {
        state.currentPrompt = null;
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

async function renamePromptSet(oldName) {
    const newName = prompt('重命名提示词集：', oldName);
    if (!newName?.trim() || newName.trim() === oldName) return;
    const res = await api(`/prompt-sets/${encodeURIComponent(oldName)}/rename`, {
        method: 'POST', body: { new_name: newName.trim() }
    });
    if (res.error) { alert(res.error); return; }
    if (state.activePromptSet === oldName) state.activePromptSet = newName.trim();
    if (state.currentPrompt?.set === oldName) state.currentPrompt.set = newName.trim();
    await loadPromptSets();
}

async function addPromptItem(psName) {
    const title = prompt('条目名称：');
    if (!title?.trim()) return;
    const ps = getPromptSet(psName);
    ps.items.push({ title: title.trim(), mode: 'fixed', enabled: true });
    await api(`/prompt-sets/${encodeURIComponent(psName)}/structure`, { method: 'PUT', body: ps });
    await loadPromptSets();
}

async function deletePromptItem(psName, idx) {
    const ps = getPromptSet(psName);
    if (!confirm(`删除「${ps.items[idx].title}」？`)) return;
    ps.items.splice(idx, 1);
    await api(`/prompt-sets/${encodeURIComponent(psName)}/structure`, { method: 'PUT', body: ps });
    if (state.currentPrompt?.set === psName && state.currentPrompt?.idx === idx) {
        state.currentPrompt = null;
        state.editorMode = 'novel';
    }
    await loadPromptSets();
}

async function renamePromptItem(psName, idx) {
    const ps = getPromptSet(psName);
    const oldTitle = ps.items[idx].title;
    const newTitle = prompt('重命名条目：', oldTitle);
    if (!newTitle?.trim() || newTitle.trim() === oldTitle) return;
    ps.items[idx].title = newTitle.trim();
    await api(`/prompt-sets/${encodeURIComponent(psName)}/structure`, { method: 'PUT', body: ps });
    await loadPromptSets();
}

async function toggleItemMode(psName, idx) {
    const ps = getPromptSet(psName);
    const it = ps.items[idx];
    it.mode = it.mode === 'fixed' ? 'ai_editable' : 'fixed';
    await api(`/prompt-sets/${encodeURIComponent(psName)}/structure`, { method: 'PUT', body: ps });
    await loadPromptSets();
}

async function toggleItemEnabled(psName, idx, checked) {
    const ps = getPromptSet(psName);
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
    await api(`/prompt-sets/${encodeURIComponent(state.activePromptSet)}/structure`, { method: 'PUT', body: ps });
    await loadPromptSets();
    renderTree();
}

async function removeRefChapter(psName, novel, vol, chap) {
    const ps = getPromptSet(psName);
    const ref = ps?.items?.find(it => it.mode === 'reference');
    if (!ref) return;
    ref.chapters = (ref.chapters || []).filter(c => !(c.novel === novel && c.vol === vol && c.chap === chap));
    await api(`/prompt-sets/${encodeURIComponent(psName)}/structure`, { method: 'PUT', body: ps });
    await loadPromptSets();
    renderTree();
}

// ── Prompt Item selection (switches editor to prompt mode) ──
async function selectPromptItem(psName, idx) {
    await saveEditor();
    const ps = getPromptSet(psName);
    const item = ps.items[idx];
    state.activePromptSet = psName;

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
        state.currentPrompt = { set: psName, idx };
        state.editorMode = 'prompt';
        document.getElementById('editor').value = '[若需阅读某章节，在回复中使用 <<<READ:小说名/卷序号/章序号>>> 格式，如 <<<READ:我的小说/0/2>>>，系统会自动获取内容后让你继续]';
        document.getElementById('current-label').textContent = `[只读] ${psName} / 读取指令说明`;
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

    // Normal prompt item — edit in prompt mode
    state.currentPrompt = { set: psName, idx };
    state.editorMode = 'prompt';

    document.getElementById('current-label').textContent = `[提示词] ${psName} / ${item.title}`;
    document.getElementById('current-label').className = 'chapter-title prompt-mode';

    const data = await api(`/prompt-sets/${encodeURIComponent(psName)}/item/${idx}`);
    document.getElementById('editor').value = data.content || '';
    renderTree();
    renderPromptSetsTree();
    setStatus('已加载');
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
        if (item && ['context', 'chapter', 'reference', 'catalog', 'read_hint'].includes(item.mode)) return;
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
    // Match <Think>...</Think> or <think>...</think> (case-insensitive)
    const re = /<think>([\s\S]*?)<\/think>/i;
    const m = re.exec(content);
    if (m) {
        const think = m[1].trim();
        const visible = content.slice(m.index + m[0].length).trim();
        return { think, visible };
    }
    return { think: '', visible: content };
}

function renderChatMessages() {
    const container = document.getElementById('chat-messages');
    container.innerHTML = state.chatMessages.map((m, i) => {
        if (m.role !== 'assistant') {
            return `<div class="msg ${m.role}">${escHtml(m.content)}</div>`;
        }
        const { think, visible } = splitThink(m.content);
        const thinkBtn = think
            ? `<button onclick="toggleThink(this,${i})">思考</button>`
            : '';
        const thinkBlock = think
            ? `<div class="msg-think" id="think-${i}" style="display:none;">${escHtml(think)}</div>`
            : '';
        const actions = `<div class="msg-actions">
                <button onclick="insertToEditor(${i})">插入到编辑器</button>
                <button onclick="replaceEditor(${i})">替换编辑器</button>
                <button onclick="copyMsg(${i})">复制</button>
                ${thinkBtn}
               </div>`;
        return `<div class="msg ${m.role}">${thinkBlock}${escHtml(visible)}${actions}</div>`;
    }).join('');
    container.scrollTop = container.scrollHeight;
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

// ── Build system content from prompt set items in order ──
async function buildSystemContent() {
    if (!state.activePromptSet) return { systemContent: '', contextEnabled: true };

    const data = await api(`/prompt-sets/${encodeURIComponent(state.activePromptSet)}/all-items`);
    const items = data.items || [];
    const parts = [];
    let contextEnabled = false;

    // Get chapter content for chapter items
    let chapterContent = '';
    if (state.current) {
        if (state.editorMode === 'novel') {
            chapterContent = document.getElementById('editor').value || '';
        } else {
            const ch = await api(`/novels/${encodeURIComponent(state.current.novel)}/chapter/${state.current.vol}/${state.current.chap}`);
            chapterContent = ch.content || '';
        }
    }

    for (const it of items) {
        if (it.mode === 'context') {
            contextEnabled = true;
            continue;
        }
        if (it.mode === 'chapter') {
            if (chapterContent.trim()) {
                parts.push(chapterContent);
            }
            continue;
        }
        if (it.mode === 'reference') {
            const refChapters = it.chapters || [];
            for (const rc of refChapters) {
                try {
                    const ch = await api(`/novels/${encodeURIComponent(rc.novel)}/chapter/${rc.vol}/${rc.chap}`);
                    if (ch.content?.trim()) parts.push(ch.content);
                } catch {}
            }
            continue;
        }
        if (it.mode === 'read_hint') {
            parts.push('[若需阅读某章节，在回复中使用 <<<READ:小说名/卷序号/章序号>>> 格式，如 <<<READ:我的小说/0/2>>>，系统会自动获取内容后让你继续]');
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
                parts.push(`[可用章节目录]\n${index}`);
            }
            // File repo
            try {
                const repo = await api('/file-repo/tree');
                if (repo.tree) {
                    parts.push(`[文件仓库 - 若需阅读某文件，在回复中使用 <<<FILE:相对路径>>> 格式，如 <<<FILE:角色总结/小智.txt>>>，系统会自动获取文件内容后让你继续]\n文件列表:\n${repo.tree}`);
                }
            } catch {}
            continue;
        }
        // Normal items: only send content, NO title
        let content = it.content.trim();
        if (!content) continue;
        if (it.mode === 'ai_editable') {
            content += `\n[可修改：若需更新此条目，在回复末尾加 <<<UPDATE:${it.title}>>>新内容<<<END>>>]`;
        }
        parts.push(content);
    }

    return { systemContent: parts.join('\n\n---\n\n'), contextEnabled };
}

// ── Send chat ──
async function sendChat() {
    const input = document.getElementById('chat-input');
    const text = input.value.trim();
    if (!text) return;
    input.value = '';

    await saveEditor();

    state.chatMessages.push({ role: 'user', content: text });
    renderChatMessages();

    const sendBtn = document.getElementById('chat-send');
    sendBtn.disabled = true;

    const { systemContent, contextEnabled } = await buildSystemContent();

    const contextMessages = contextEnabled
        ? state.chatMessages.filter(m => !m._preview).map(m => ({ role: m.role, content: splitThink(m.content).visible }))
        : [{ role: 'user', content: text }];

    const body = {
        messages: contextMessages,
        system_content: systemContent,
    };

    try {
        const res = await fetch('/api/chat', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        });

        const reader = res.body.getReader();
        const decoder = new TextDecoder('utf-8');
        let assistantMsg = { role: 'assistant', content: '' };
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
                        const delta = obj.choices?.[0]?.delta?.content || '';
                        assistantMsg.content += delta;
                    }
                } catch {}
            }
            renderChatMessages();
        }

        // After streaming complete, check for AI updates
        await processAiUpdates(assistantMsg);

    } catch (e) {
        state.chatMessages.push({ role: 'assistant', content: `[连接错误: ${e.message}]` });
    }
    renderChatMessages();
    sendBtn.disabled = false;
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

// Ctrl+Enter to send
document.getElementById('chat-input').addEventListener('keydown', e => {
    if (e.key === 'Enter' && e.ctrlKey) { e.preventDefault(); sendChat(); }
});

// Auto-resize chat input
document.getElementById('chat-input').addEventListener('input', function() {
    this.style.height = 'auto';
    this.style.height = Math.min(this.scrollHeight, 120) + 'px';
});

// ── Preview what gets sent to AI ──
const PREVIEW_TAG = '📋 【发送预览】';

async function previewPrompt() {
    await saveEditor();
    state.chatMessages = state.chatMessages.filter(m => !m._preview);

    const { systemContent, contextEnabled } = await buildSystemContent();

    // Build the exact messages array that would be sent
    const previewParts = [];
    previewParts.push(systemContent || '(空)');

    if (contextEnabled) {
        const contextMsgs = state.chatMessages.filter(m => !m._preview).map(m => `[${m.role}] ${splitThink(m.content).visible}`).join('\n\n');
        previewParts.push(`══════ CONTEXT MESSAGES (${state.chatMessages.filter(m => !m._preview).length}条) ══════\n${contextMsgs || '(无对话历史)'}`);
    } else {
        previewParts.push(`══════ CONTEXT ══════\n(上下文已禁用，仅发送当前消息)`);
    }

    const preview = previewParts.join('\n\n────────────────────\n\n');
    // Show preview in editor instead of chat
    state.editorMode = 'prompt';
    state.currentPrompt = { set: '_preview', idx: -1 };
    document.getElementById('editor').value = `${PREVIEW_TAG}\n\n${preview}`;
    document.getElementById('current-label').textContent = '[只读] 发送预览';
    document.getElementById('current-label').className = 'chapter-title prompt-mode';
    renderTree();
    renderPromptSetsTree();
    setStatus('只读预览');
}

// ── Settings modal ──
async function openSettings() {
    const cfg = await api('/config');
    showModal('设置', `
        <label>服务端口</label>
        <input id="cfg-port" type="number" value="${cfg.port}">
        <label>API 地址</label>
        <input id="cfg-url" value="${escHtml(cfg.api_url)}">
        <label>API Key（可选）</label>
        <input id="cfg-key" value="${escHtml(cfg.api_key || '')}">
        <label>模型</label>
        <input id="cfg-model" value="${escHtml(cfg.model)}">
        <label>全局默认提示词</label>
        <textarea id="cfg-prompt">${escHtml(cfg.default_system_prompt)}</textarea>
    `, async () => {
        await api('/config', { method: 'PUT', body: {
            port: parseInt(document.getElementById('cfg-port').value),
            api_url: document.getElementById('cfg-url').value,
            api_key: document.getElementById('cfg-key').value,
            model: document.getElementById('cfg-model').value,
            default_system_prompt: document.getElementById('cfg-prompt').value,
        }});
    });
}

// ── Modal helper ──
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
