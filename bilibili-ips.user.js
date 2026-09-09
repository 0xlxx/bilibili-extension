// ==UserScript==
// @name         Bilibili 评论增强 - IP属地 & 粉丝数
// @namespace    biliip
// @version      2.3.2
// @description  在 Bilibili 评论区显示用户 IP 属地和粉丝数量，支持独立开关
// @author       biliip
// @updateURL   https://raw.githubusercontent.com/0xlxx/bilibili-extension/main/bilibili-ips.user.js
// @downloadURL https://raw.githubusercontent.com/0xlxx/bilibili-extension/main/bilibili-ips.user.js
// @match        https://*.bilibili.com/*
// @grant        none
// @run-at       document-end
// ==/UserScript==

(function () {
    'use strict';

    // ═══════════════════════════════════════════════════════════════
    // Module 1: 配置与常量
    // ═══════════════════════════════════════════════════════════════

    const STORAGE_KEY = 'bili-enhancer-settings';

    const DEFAULT_SETTINGS = { showIp: true, showFans: true, enableFavorite: true };

    const CONFIG = {
        enabledPages: ['video', 'space', 'dynamic'],
        position: 'before-like',
    };

    const PAGE_PATTERNS = {
        video: 'https://www.bilibili.com/video/',
        space: 'https://space.bilibili.com/',
        dynamic: 'https://t.bilibili.com/',
        dynamicDetail: 'https://www.bilibili.com/opus/',
        watchLater: 'https://www.bilibili.com/list/watchlater',
    };

    /** 粉丝数颜色分级 */
    const FAN_TIERS = [
        { max: 100,     color: '#78909C' },   // 蓝灰 — 少量
        { max: 1000,    color: '#42A5F5' },   // 中蓝 — 百级
        { max: 10000,   color: '#FF9800' },   // 暖琥珀 — 千级
        { max: 100000,  color: '#EF5350' },   // 珊瑚红 — 万级
        { max: Infinity, color: '#F9A825' },  // 金 — 十万+
    ];

    // ═══════════════════════════════════════════════════════════════
    // Module 2: 持久化设置
    // ═══════════════════════════════════════════════════════════════

    function loadSettings() {
        try {
            const raw = localStorage.getItem(STORAGE_KEY);
            if (raw) {
                const saved = JSON.parse(raw);
                // 合并默认值，向前兼容后续新增字段
                return { ...DEFAULT_SETTINGS, ...saved };
            }
        } catch (_) { /* corrupted JSON — fall through */ }
        return { ...DEFAULT_SETTINGS };
    }

    function saveSettings(s) {
        try {
            localStorage.setItem(STORAGE_KEY, JSON.stringify(s));
        } catch (_) { /* quota exceeded — silently degrade */ }
    }

    let settings = loadSettings();

    // ═══════════════════════════════════════════════════════════════
    // Module 3: 数据提取
    // ═══════════════════════════════════════════════════════════════

    /**
     * 从评论 shadow root 提取 IP 属地和用户 mid
     * @param {ShadowRoot} root - 评论项的 shadow root
     * @returns {{ ip: string|null, mid: string|null }}
     */
    function extractCommentData(root) {
        try {
            // IP：沿用已验证路径 — footer 内 action-buttons 元素的 __data
            const footer = root.getElementById('footer');
            const controlEl = footer && footer.children[0];
            const controlData = controlEl && controlEl.__data;
            const ip = controlData?.reply_control?.location || null;

            // mid：从宿主元素 __data.member 获取用户 ID
            const hostData = root.host && root.host.__data;
            const mid = hostData?.member?.mid || null;
            const uname = hostData?.member?.uname || null;
            const content = hostData?.content?.message || hostData?.content?.text || null;
            const ctime = hostData?.ctime || null;
            const rpid = hostData?.rpid || null;

            return {
                ip,
                mid: mid ? String(mid) : null,
                uname,
                content,
                ctime,
                rpid,
            };
        } catch (_e) {
            return { ip: null, mid: null, uname: null, content: null, ctime: null, rpid: null };
        }
    }

    /**
     * 获取粉丝数对应的颜色等级
     */
    function getFanTier(n) {
        for (let i = 0; i < FAN_TIERS.length; i++) {
            if (n < FAN_TIERS[i].max) return i + 1;
        }
        return FAN_TIERS.length;
    }

    // ═══════════════════════════════════════════════════════════════
    // Module 4: 粉丝数 API 获取与缓存
    // ═══════════════════════════════════════════════════════════════

    /** 粉丝数缓存：mid → { count: number, ts: number } */
    const fanCache = new Map();
    /** 正在请求中的 mid → Promise，避免重复请求 */
    const fanPending = new Map();
    const CACHE_TTL = 10 * 60 * 1000; // 缓存 10 分钟

    /**
     * 通过 Bilibili API 获取用户粉丝数
     * @param {string} mid
     * @returns {Promise<number|null>}
     */
    async function fetchFanCount(mid) {
        // 检查缓存
        const cached = fanCache.get(mid);
        if (cached && (Date.now() - cached.ts) < CACHE_TTL) {
            return cached.count;
        }

        // 去重：同一 mid 的并发请求共享 Promise
        if (fanPending.has(mid)) {
            return fanPending.get(mid);
        }

        const promise = (async () => {
            try {
                const resp = await fetch(
                    `https://api.bilibili.com/x/relation/stat?vmid=${mid}`,
                    { credentials: 'omit' }
                );
                if (!resp.ok) return null;
                const json = await resp.json();
                if (json.code !== 0 || !json.data) return null;
                const count = Number(json.data.follower);
                if (isNaN(count)) return null;
                fanCache.set(mid, { count, ts: Date.now() });
                return count;
            } catch (_) {
                return null;
            } finally {
                fanPending.delete(mid);
            }
        })();

        fanPending.set(mid, promise);
        return promise;
    }

    // ═══════════════════════════════════════════════════════════════
    // Module 5: 格式化
    // ═══════════════════════════════════════════════════════════════

    /**
     * 格式化粉丝数
     * < 1000  → "128粉丝"
     * 1k-10k  → "1.2k粉丝"
     * >= 10k  → "1.2w粉丝"
     */
    function formatFans(n) {
        if (n == null || isNaN(n)) return null;
        if (n < 1000) return n + '粉丝';
        if (n < 10000) {
            const v = (n / 1000).toFixed(1).replace(/\.0$/, '');
            return v + 'k粉丝';
        }
        const v = (n / 10000).toFixed(1).replace(/\.0$/, '');
        return v + 'w粉丝';
    }

    // ═══════════════════════════════════════════════════════════════
    // Module 6: CSS 样式注入
    // ═══════════════════════════════════════════════════════════════

    function injectStyles() {
        if (document.getElementById('be-styles')) return;

        const style = document.createElement('style');
        style.id = 'be-styles';
        style.textContent = `
            /* ── 主题感知基色 ── */
            :root {
                --be-fan-base: #9499a0;
                --be-surface: #ffffff;
                --be-text: #18191c;
                --be-panel-bg: #ffffff;
                --be-panel-shadow: rgba(0,0,0,0.08);
            }
            html[data-theme="dark"] {
                --be-fan-base: #8b8b8b;
                --be-surface: #1a1a1a;
                --be-text: #e3e5e7;
                --be-panel-bg: #1e1e1e;
                --be-panel-shadow: rgba(0,0,0,0.3);
            }

            /* ── 可见性控制（CSS 自定义属性穿透 Shadow DOM） ── */
            :root {
                --be-show-ip: inline-flex;
                --be-show-fans: inline-flex;
                --be-show-fav: inline-flex;
            }

            /* ── 通用 Badge ── */
            .be-badge {
                display: inline-flex;
                align-items: center;
                height: 22px;
                padding: 0 6px;
                margin-right: 6px;
                font-size: 11px;
                line-height: 22px;
                border-radius: 4px;
                white-space: nowrap;
                user-select: none;
                flex-shrink: 0;
                font-weight: 500;
                letter-spacing: 0.01em;
                vertical-align: middle;
            }

            /* ── IP 属地 Badge（低调灰，color-mix 适配主题） ── */
            .be-badge-ip {
                display: var(--be-show-ip);
                color: color-mix(in srgb, #9499a0 90%, var(--be-fan-base) 10%);
                background: color-mix(in srgb, #9499a0 13%, transparent);
                border: 0.5px solid color-mix(in srgb, #9499a0 18%, transparent);
            }

            /* ── 粉丝 Badge（颜色通过 inline style 设置，绕过 Shadow DOM 隔离） ── */
            .be-badge-fans {
                display: var(--be-show-fans);
            }

            /* ── 设置按钮 ── */
            #be-settings-btn {
                position: fixed;
                bottom: 100px;
                right: 24px;
                width: 40px;
                height: 40px;
                border-radius: 10px;
                background: color-mix(in srgb, var(--be-text) 10%, transparent);
                backdrop-filter: blur(12px);
                -webkit-backdrop-filter: blur(12px);
                border: 0.5px solid color-mix(in srgb, var(--be-fan-base) 22%, transparent);
                cursor: pointer;
                z-index: 99999;
                display: flex;
                align-items: center;
                justify-content: center;
                opacity: 0.55;
                transition: opacity 0.2s ease, transform 0.2s ease, background 0.2s ease;
            }
            #be-settings-btn:hover {
                opacity: 1;
                background: color-mix(in srgb, var(--be-text) 18%, transparent);
                transform: scale(1.06);
            }
            #be-settings-btn svg {
                width: 19px;
                height: 19px;
                fill: none;
                stroke: color-mix(in srgb, var(--be-fan-base) 85%, var(--be-text) 15%);
                stroke-width: 1.8;
                stroke-linecap: round;
                stroke-linejoin: round;
            }

            /* ── 设置面板 ── */
            #be-panel {
                position: fixed;
                bottom: 152px;
                right: 24px;
                width: 210px;
                background: color-mix(in srgb, var(--be-panel-bg) 94%, var(--be-fan-base) 6%);
                backdrop-filter: blur(20px);
                -webkit-backdrop-filter: blur(20px);
                border: 0.5px solid color-mix(in srgb, var(--be-fan-base) 22%, transparent);
                border-radius: 12px;
                padding: 16px;
                z-index: 99998;
                box-shadow: 0 4px 24px var(--be-panel-shadow);
                opacity: 0;
                transform: translateY(8px);
                pointer-events: none;
                transition: opacity 0.22s ease, transform 0.22s ease;
            }
            #be-panel.be-visible {
                opacity: 1;
                transform: translateY(0);
                pointer-events: auto;
            }

            #be-panel-title {
                margin: 0 0 14px 0;
                font-size: 13px;
                font-weight: 600;
                color: color-mix(in srgb, var(--be-text) 90%, transparent);
                letter-spacing: 0.02em;
                user-select: none;
            }

            /* ── 开关行 ── */
            .be-row {
                display: flex;
                align-items: center;
                justify-content: space-between;
                padding: 9px 0;
            }
            .be-row + .be-row {
                border-top: 0.5px solid color-mix(in srgb, var(--be-fan-base) 14%, transparent);
            }
            .be-row-label {
                font-size: 13px;
                font-weight: 500;
                color: color-mix(in srgb, var(--be-text) 70%, var(--be-fan-base) 30%);
                user-select: none;
            }

            /* ── Solid Pill 开关 ── */
            .be-toggle {
                position: relative;
                display: inline-block;
                width: 40px;
                height: 24px;
                flex-shrink: 0;
                cursor: pointer;
            }
            .be-toggle input {
                position: absolute;
                opacity: 0;
                width: 0;
                height: 0;
                pointer-events: none;
            }
            .be-toggle-track {
                display: block;
                width: 100%;
                height: 100%;
                border-radius: 12px;
                background: color-mix(in srgb, var(--be-fan-base) 32%, transparent);
                transition: background 0.22s ease;
                position: relative;
            }
            .be-toggle input:checked + .be-toggle-track {
                background: #00AEEC;
            }
            .be-toggle-thumb {
                position: absolute;
                top: 3px;
                left: 3px;
                width: 18px;
                height: 18px;
                border-radius: 50%;
                background: #ffffff;
                box-shadow: 0 1px 3px rgba(0,0,0,0.15);
                transition: transform 0.22s cubic-bezier(0.34, 1.56, 0.64, 1);
            }
            .be-toggle input:checked + .be-toggle-track .be-toggle-thumb {
                transform: translateX(16px);
            }

            /* ── 导出收藏按钮 ── */
            .be-export-btn {
                margin-left: auto;
                padding: 4px 12px;
                font-size: 12px;
                font-weight: 500;
                color: color-mix(in srgb, var(--be-text) 85%, transparent);
                background: color-mix(in srgb, var(--be-fan-base) 12%, transparent);
                border: 0.5px solid color-mix(in srgb, var(--be-fan-base) 22%, transparent);
                border-radius: 6px;
                cursor: pointer;
                transition: background .2s ease, transform .2s ease;
            }
            .be-export-btn:hover {
                background: color-mix(in srgb, var(--be-fan-base) 20%, transparent);
                transform: translateY(-1px);
            }
            .be-row-actions {
                display: flex;
                gap: 6px;
                margin-left: auto;
            }
            .be-row-actions .be-export-btn { margin-left: 0; }

            /* ── 收藏管理面板 ── */
            #be-fav-overlay {
                position: fixed;
                inset: 0;
                background: rgba(0,0,0,.45);
                z-index: 100001;
                display: none;
                align-items: center;
                justify-content: center;
                padding: 16px;
            }
            #be-fav-overlay.be-open { display: flex; }
            #be-fav-panel {
                width: min(560px, 94vw);
                max-height: 82vh;
                display: flex;
                flex-direction: column;
                background: color-mix(in srgb, var(--be-panel-bg) 96%, var(--be-fan-base) 4%);
                border: 0.5px solid color-mix(in srgb, var(--be-fan-base) 22%, transparent);
                border-radius: 14px;
                overflow: hidden;
                box-shadow: 0 12px 40px rgba(0,0,0,.28);
            }
            .be-fav-title {
                display: flex;
                align-items: center;
                justify-content: space-between;
                padding: 14px 18px;
                font-size: 14px;
                font-weight: 600;
                color: color-mix(in srgb, var(--be-text) 90%, transparent);
                border-bottom: 0.5px solid color-mix(in srgb, var(--be-fan-base) 16%, transparent);
            }
            #be-fav-close {
                border: none;
                background: transparent;
                font-size: 20px;
                line-height: 1;
                color: color-mix(in srgb, var(--be-fan-base) 80%, var(--be-text) 20%);
                cursor: pointer;
                padding: 2px 6px;
                border-radius: 6px;
            }
            #be-fav-close:hover { color: var(--be-text); background: color-mix(in srgb, var(--be-fan-base) 14%, transparent); }
            .be-fav-list {
                overflow: auto;
                padding: 12px 16px 16px;
                font-size: 13px;
            }
            .be-fav-empty {
                text-align: center;
                color: color-mix(in srgb, var(--be-fan-base) 70%, var(--be-text) 30%);
                padding: 40px 0;
            }
            .be-fav-item {
                padding: 12px 14px;
                border: 0.5px solid color-mix(in srgb, var(--be-fan-base) 16%, transparent);
                border-radius: 10px;
                margin-bottom: 10px;
                background: color-mix(in srgb, var(--be-panel-bg) 70%, transparent);
            }
            .be-fav-item-meta {
                font-size: 12px;
                color: color-mix(in srgb, var(--be-fan-base) 65%, var(--be-text) 35%);
                margin-bottom: 6px;
            }
            .be-fav-item-content {
                color: color-mix(in srgb, var(--be-text) 88%, transparent);
                line-height: 1.6;
                margin-bottom: 10px;
                word-break: break-word;
                display: -webkit-box;
                -webkit-line-clamp: 4;
                -webkit-box-orient: vertical;
                overflow: hidden;
            }
            .be-fav-item-actions {
                display: flex;
                gap: 12px;
                align-items: center;
            }
            .be-fav-open {
                color: #00aeec;
                text-decoration: none;
                font-size: 12px;
            }
            .be-fav-open:hover { text-decoration: underline; }
            .be-fav-del {
                border: none;
                background: transparent;
                color: #ef5350;
                font-size: 12px;
                cursor: pointer;
                padding: 2px 4px;
                border-radius: 4px;
            }
            .be-fav-del:hover { background: rgba(239,83,80,.12); }
        `;
        document.head.appendChild(style);
    }

    // ═══════════════════════════════════════════════════════════════
    // 页面匹配
    // ═══════════════════════════════════════════════════════════════

    function matchPage(enabledPages) {
        const href = window.location.href;
        for (const page of enabledPages) {
            if (page === 'dynamic') {
                if (href.startsWith(PAGE_PATTERNS.dynamic) || href.startsWith(PAGE_PATTERNS.dynamicDetail)) {
                    return true;
                }
            }
            if (href.startsWith(PAGE_PATTERNS[page])) {
                return true;
            }
        }
        if (enabledPages.includes('video') && href.startsWith(PAGE_PATTERNS.watchLater)) {
            return true;
        }
        return false;
    }

    // ═══════════════════════════════════════════════════════════════
    // Module 7: Badge 渲染
    // ═══════════════════════════════════════════════════════════════

    /**
     * 创建粉丝 Badge 元素
     */
    /**
     * 将 hex 颜色转为 rgb 分量
     */
    function hexToRgb(hex) {
        return {
            r: parseInt(hex.slice(1, 3), 16),
            g: parseInt(hex.slice(3, 5), 16),
            b: parseInt(hex.slice(5, 7), 16),
        };
    }

    /** 检测当前是否为深色模式 */
    function isDarkTheme() {
        return document.documentElement.getAttribute('data-theme') === 'dark';
    }

    /**
     * 给 badge 元素设置通用结构样式（inline，绕过 Shadow DOM 隔离）
     */
    function applyBaseBadgeStyles(el, displayVar) {
        const s = el.style;
        s.display = `var(${displayVar})`;
        s.alignItems = 'center';
        s.height = '22px';
        s.padding = '0 6px';
        s.marginRight = '6px';
        s.fontSize = '11px';
        s.lineHeight = '22px';
        s.borderRadius = '4px';
        s.whiteSpace = 'nowrap';
        s.userSelect = 'none';
        s.flexShrink = '0';
        s.fontWeight = '500';
        s.letterSpacing = '0.01em';
        s.verticalAlign = 'middle';
    }

    /**
     * 为粉丝 Badge 设置颜色（inline style，绕过 Shadow DOM 隔离）
     */
    function applyFanBadgeColors(el, tier) {
        const tierIdx = tier - 1;
        const accentHex = FAN_TIERS[tierIdx].color;
        const dark = isDarkTheme();
        const { r, g, b } = hexToRgb(accentHex);

        // 深色模式下提亮文字
        const lightenAmount = dark ? 40 : 0;
        const tr = Math.min(255, r + lightenAmount);
        const tg = Math.min(255, g + lightenAmount);
        const tb = Math.min(255, b + lightenAmount);

        el.style.color = dark
            ? `rgb(${tr},${tg},${tb})`
            : `rgb(${Math.max(0, r - 20)},${Math.max(0, g - 20)},${Math.max(0, b - 20)})`;
        el.style.backgroundColor = `rgba(${r},${g},${b},0.14)`;
        el.style.border = `0.5px solid rgba(${r},${g},${b},0.24)`;
    }

    function createFanBadge(count) {
        const tier = getFanTier(count);
        const text = formatFans(count);
        if (!text) return null;

        const el = document.createElement('div');
        el.className = 'be-badge be-badge-fans';
        el.setAttribute('data-tier', String(tier));
        el.textContent = text;

        applyBaseBadgeStyles(el, '--be-show-fans');
        applyFanBadgeColors(el, tier);

        return el;
    }

    /**
     * 在 reply-control 中插入 fan badge（放在 IP badge 后面、like 前面）
     */
    function insertFanBadge(replyControlRoot, fanEl) {
        // 已有则跳过
        if (replyControlRoot.querySelector('.be-badge-fans')) return;

        // 找到参考位置：IP badge 后面，或 like 前面
        const ipBadge = replyControlRoot.querySelector('.be-badge-ip');
        if (ipBadge && ipBadge.nextSibling) {
            replyControlRoot.insertBefore(fanEl, ipBadge.nextSibling);
        } else if (replyControlRoot.children.like) {
            replyControlRoot.insertBefore(fanEl, replyControlRoot.children.like);
        } else {
            replyControlRoot.appendChild(fanEl);
        }
    }

    /**
     * 在评论操作栏中渲染 IP Badge，并异步加载粉丝 Badge
     */
    function renderBadges(root, data, replyControlRoot) {
        // 确保 reply-control 已渲染子元素
        if (!replyControlRoot.children || replyControlRoot.children.length === 0) return;

        // ── IP Badge（同步） ──
        if (data.ip && !replyControlRoot.querySelector('.be-badge-ip')) {
            const ipEl = document.createElement('div');
            ipEl.className = 'be-badge be-badge-ip';
            ipEl.textContent = data.ip;

            applyBaseBadgeStyles(ipEl, '--be-show-ip');
            // IP badge 的低调灰配色（inline，绕过 Shadow DOM）
            ipEl.style.color = '#9499a0';
            ipEl.style.backgroundColor = 'rgba(148,153,160,0.12)';
            ipEl.style.border = '0.5px solid rgba(148,153,160,0.18)';

            if (CONFIG.position === 'before-like' && replyControlRoot.children.like) {
                replyControlRoot.insertBefore(ipEl, replyControlRoot.children.like);
            } else {
                replyControlRoot.appendChild(ipEl);
            }
        }

        // ── 粉丝 Badge（异步，通过 API 获取） ──
        if (data.mid && !replyControlRoot.querySelector('.be-badge-fans')) {
            fetchFanCount(data.mid).then(count => {
                if (count == null) return;
                // 二次确认 footer 和 replyControlRoot 仍存在
                const footer = root.getElementById('footer');
                if (!footer || !footer.children[0]) return;
                const rcRoot = footer.children[0].shadowRoot;
                if (!rcRoot) return;
                const fanEl = createFanBadge(count);
                if (fanEl) insertFanBadge(rcRoot, fanEl);
            });
        }
    }

    /**
     * 通过 CSS 自定义属性控制所有 badge 的可见性
     * CSS 自定义属性会穿透 Shadow DOM，无需遍历 shadow tree
     */
    function applyVisibility() {
        document.documentElement.style.setProperty(
            '--be-show-ip',
            settings.showIp ? 'inline-flex' : 'none'
        );
        document.documentElement.style.setProperty(
            '--be-show-fans',
            settings.showFans ? 'inline-flex' : 'none'
        );
        document.documentElement.style.setProperty(
            '--be-show-fav',
            settings.enableFavorite ? 'inline-flex' : 'none'
        );
    }

    /**
     * 主题切换时重新给所有粉丝 Badge 上色
     */
    function recolorAllFanBadges() {
        // 粉丝 badge 在 shadow DOM 内，document.querySelectorAll 找不到它们
        // 但我们可以遍历所有 bili-comments 下的 shadow tree
        const comments = document.getElementsByTagName('bili-comments');
        for (const comment of comments) {
            const shadow = comment.shadowRoot;
            if (!shadow) continue;
            const feed = shadow.children?.contents?.children?.feed;
            if (!feed) continue;
            for (const stack of feed.children) {
                const ss = stack.shadowRoot;
                if (!ss) continue;
                // 主评论
                const main = ss.children.comment;
                if (main?.shadowRoot) {
                    recolorInShadowRoot(main.shadowRoot);
                }
                // 回复
                const replies = ss.children?.replies?.children?.[0];
                if (replies?.shadowRoot) {
                    const renderers = replies.shadowRoot.querySelectorAll('bili-comment-reply-renderer');
                    for (const r of renderers) {
                        if (r.shadowRoot) recolorInShadowRoot(r.shadowRoot);
                    }
                }
            }
        }
    }

    function recolorInShadowRoot(root) {
        const footer = root.getElementById('footer');
        if (!footer?.children?.[0]) return;
        const rc = footer.children[0].shadowRoot;
        if (!rc) return;
        const fanBadge = rc.querySelector('.be-badge-fans');
        if (!fanBadge) return;
        const tier = parseInt(fanBadge.getAttribute('data-tier'), 10);
        if (tier) applyFanBadgeColors(fanBadge, tier);
    }

    // ═══════════════════════════════════════════════════════════════
    // Module 8: 评论遍历与 Observation
    // ═══════════════════════════════════════════════════════════════

    /**
     * 处理单个评论根节点：提取数据、渲染 badge、注册 observer
     */
    function processCommentRoot(commentRoot, observer) {
        observer.observe(commentRoot, { childList: true, subtree: true });

        const data = extractCommentData(commentRoot);
        if (!data) return;

        const footer = commentRoot.getElementById('footer');
        if (!footer || !footer.children[0]) return;

        const replyControlRoot = footer.children[0].shadowRoot;
        if (!replyControlRoot) return;

        observer.observe(replyControlRoot, { childList: true, subtree: true });

        renderBadges(commentRoot, data, replyControlRoot);
        addFavoriteButton(commentRoot, data, replyControlRoot);
    }

    /**
     * 遍历所有 bili-comments 并标注 IP + 粉丝
     */
    function labelAllComments(observer) {
        const comments = document.getElementsByTagName('bili-comments');
        if (comments.length === 0) return;

        for (const comment of comments) {
            // 观察 bili-comments 自身的 shadow root
            const commentShadow = comment.shadowRoot;
            if (!commentShadow) continue;
            observer.observe(commentShadow, { childList: true, subtree: true });

            const feed = commentShadow.children?.contents?.children?.feed;
            if (!feed) continue;

            for (const commentStack of feed.children) {
                const stackShadow = commentStack.shadowRoot;
                if (!stackShadow) continue;
                observer.observe(stackShadow, { childList: true, subtree: true });

                // ── 主评论 ──
                const mainComment = stackShadow.children.comment;
                if (mainComment && mainComment.shadowRoot) {
                    processCommentRoot(mainComment.shadowRoot, observer);
                }

                // ── 回复 ──
                const replies = stackShadow.children?.replies;
                if (!replies || !replies.children[0]) continue;

                const replyContainer = replies.children[0];
                if (replyContainer.shadowRoot) {
                    observer.observe(replyContainer.shadowRoot, { childList: true, subtree: true });
                    const replyRenderers = replyContainer.shadowRoot.querySelectorAll(
                        'bili-comment-reply-renderer'
                    );
                    for (const replyRenderer of replyRenderers) {
                        if (replyRenderer.shadowRoot) {
                            processCommentRoot(replyRenderer.shadowRoot, observer);
                        }
                    }
                }
            }
        }
    }

    // ═══════════════════════════════════════════════════════════════
    // Module 8.5: 评论收藏功能（IndexedDB 无感存储 + 导出）
    // ═══════════════════════════════════════════════════════════════

    const FAV_DB_NAME = 'bili-enhancer-fav';
    const FAV_DB_STORE = 'favorites';            // keyPath: id
    const FAV_EXPORT_PREFIX = 'bilibili-favorites';
    const FAV_EXPORT_TYPES = [{ description: 'JSON 收藏文件', accept: { 'application/json': ['.json'] } }];

    let favoriteIdSet = new Set();               // 本会话已知的已收藏 id
    let favoriteLoaded = false;                  // 是否已从 IndexedDB 初始化
    let favDbPromise = null;

    /** 打开（或创建）收藏数据库 */
    function openFavDb() {
        if (!favDbPromise) {
            favDbPromise = new Promise((resolve, reject) => {
                const req = indexedDB.open(FAV_DB_NAME, 2);
                req.onupgradeneeded = () => {
                    const db = req.result;
                    if (!db.objectStoreNames.contains(FAV_DB_STORE)) {
                        db.createObjectStore(FAV_DB_STORE, { keyPath: 'id' });
                    }
                };
                req.onsuccess = () => resolve(req.result);
                req.onerror = () => reject(req.error);
            });
        }
        return favDbPromise;
    }

    /** 读取全部收藏 */
    async function favGetAll() {
        try {
            const db = await openFavDb();
            const list = await new Promise((resolve, reject) => {
                const tx = db.transaction(FAV_DB_STORE, 'readonly');
                const r = tx.objectStore(FAV_DB_STORE).getAll();
                r.onsuccess = () => resolve(r.result || []);
                r.onerror = () => reject(r.error);
            });
            return list;
        } catch (_) { return []; }
    }

    /** 写入单条收藏记录 */
    async function favPut(record) {
        const db = await openFavDb();
        await new Promise((resolve, reject) => {
            const tx = db.transaction(FAV_DB_STORE, 'readwrite');
            tx.objectStore(FAV_DB_STORE).put(record);
            tx.oncomplete = resolve;
            tx.onerror = () => reject(tx.error);
            tx.onabort = () => reject(tx.error);
        });
    }

    /** 删除单条收藏记录 */
    async function favDelete(id) {
        const db = await openFavDb();
        await new Promise((resolve, reject) => {
            const tx = db.transaction(FAV_DB_STORE, 'readwrite');
            tx.objectStore(FAV_DB_STORE).delete(id);
            tx.oncomplete = resolve;
            tx.onerror = () => reject(tx.error);
            tx.onabort = () => reject(tx.error);
        });
    }

    function hasFsAccessApi() {
        return typeof window.showSaveFilePicker === 'function';
    }

    /** 生成评论唯一 id */
    function commentUniqueId(data) {
        if (data.rpid) return String(data.rpid);
        return `${data.mid || 'anon'}-${data.ctime || 0}-${(data.content || '').slice(0, 20)}`;
    }

    /** 组装收藏记录 */
    /** 构建规范评论链接（与 B 站「复制评论链接」一致），用于从收藏跳转到具体评论 */
    function buildCommentUrl(data) {
        const rpid = data.rpid ? String(data.rpid) : '';
        const vid = location.pathname.match(/^\/video\/([A-Za-z0-9]+)/);
        if (vid && rpid) {
            return location.origin + '/video/' + vid[1] +
                '?comment_on=1&comment_root_id=' + rpid + '&share_tag=s_i#reply' + rpid;
        }
        // 其它页面（动态/opus 等）暂保留当前地址
        return location.href;
    }

    /** 打开原评论时规范化链接：老收藏若不带锚点，尝试用 BVID + id 重建 */
    function normalizeRecordUrl(record) {
        const page = record && record.page;
        if (page && /comment_root_id=/.test(page) && /#reply/.test(page)) return page;
        const vid = (page || '').match(/\/video\/([A-Za-z0-9]+)/);
        const rpid = record && record.id ? String(record.id) : '';
        if (vid && rpid) {
            return location.origin + '/video/' + vid[1] +
                '?comment_on=1&comment_root_id=' + rpid + '&share_tag=s_i#reply' + rpid;
        }
        return page || '';
    }

    function buildFavoriteRecord(data) {
        return {
            id: commentUniqueId(data),
            mid: data.mid,
            uname: data.uname,
            content: data.content,
            ctime: data.ctime,
            ip: data.ip,
            fans: data.fans || null,
            page: buildCommentUrl(data),
            saved_at: new Date().toISOString(),
        };
    }

    /** 收藏 / 取消收藏一条评论（无感写入 IndexedDB） */
    async function toggleFavorite(data) {
        const id = commentUniqueId(data);
        try {
            if (favoriteIdSet.has(id)) {
                await favDelete(id);
                favoriteIdSet.delete(id);
                return { ok: true, action: 'removed' };
            } else {
                const record = buildFavoriteRecord(data);
                await favPut(record);
                favoriteIdSet.add(id);
                return { ok: true, action: 'added' };
            }
        } catch (e) {
            return { ok: false, error: String((e && e.message) || e) };
        }
    }

    /** 初始化：从 IndexedDB 读取已收藏 id 集合 */
    async function initFavoriteState() {
        if (favoriteLoaded) return;
        try {
            const list = await favGetAll();
            favoriteIdSet = new Set(list.map(c => c && c.id).filter(Boolean));
        } catch (_) { /* ignore */ }
        favoriteLoaded = true;
    }

    /** 导出收藏到本地文件（优先 File System Access API，降级为下载） */
    async function exportFavorites() {
        const list = await favGetAll();
        if (!list.length) {
            showFavToast('暂无收藏可导出');
            return;
        }
        const d = new Date();
        const pad = n => String(n).padStart(2, '0');
        const filename = `${FAV_EXPORT_PREFIX}-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}.json`;
        const json = JSON.stringify(list, null, 2);

        if (hasFsAccessApi()) {
            try {
                const handle = await window.showSaveFilePicker({
                    suggestedName: filename,
                    types: FAV_EXPORT_TYPES,
                });
                const writable = await handle.createWritable();
                await writable.write(json);
                await writable.close();
                showFavToast('已导出 ' + handle.name);
                return;
            } catch (e) {
                // 用户取消或失败 → 回退到下载
                if (e && e.name === 'AbortError') return; // 用户主动取消，静默
            }
        }

        // 降级：触发浏览器下载
        const blob = new Blob([json], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(url);
        showFavToast('已导出：' + filename);
    }

    /** 收藏管理面板（查看 / 打开 / 删除） */
    let favPanelEl = null;

    function ensureFavPanel() {
        if (favPanelEl) return favPanelEl;
        const overlay = document.createElement('div');
        overlay.id = 'be-fav-overlay';
        overlay.innerHTML = `
            <div id="be-fav-panel">
                <div class="be-fav-title">
                    <span id="be-fav-title-text">我的收藏</span>
                    <button id="be-fav-close" title="关闭">×</button>
                </div>
                <div id="be-fav-list" class="be-fav-list"></div>
            </div>`;
        document.body.appendChild(overlay);

        overlay.addEventListener('click', (e) => {
            if (e.target === overlay) closeFavPanel();
        });
        overlay.querySelector('#be-fav-close').addEventListener('click', closeFavPanel);
        overlay.querySelector('#be-fav-list').addEventListener('click', (e) => {
            const del = e.target.closest('.be-fav-del');
            if (del) removeFavorite(del.getAttribute('data-id'));
        });
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') closeFavPanel();
        });
        favPanelEl = overlay;
        return overlay;
    }

    async function openFavoritesPanel() {
        const overlay = ensureFavPanel();
        overlay.classList.add('be-open');
        await renderFavoritesList();
    }

    function closeFavPanel() {
        const o = document.getElementById('be-fav-overlay');
        if (o) o.classList.remove('be-open');
    }

    async function renderFavoritesList() {
        const overlay = ensureFavPanel();
        const listEl = overlay.querySelector('#be-fav-list');
        const title = overlay.querySelector('#be-fav-title-text');
        const list = await favGetAll();
        title.textContent = '我的收藏 (' + list.length + ')';
        if (!list.length) {
            listEl.innerHTML = '<div class="be-fav-empty">还没有收藏的评论</div>';
            return;
        }
        listEl.innerHTML = list.map(r => {
            const savedAt = r.saved_at ? new Date(r.saved_at).toLocaleString('zh-CN') : '';
            const ctime = r.ctime ? new Date(r.ctime * 1000).toLocaleString('zh-CN') : '';
            const uname = (r.uname || '匿名').replace(/</g, '&lt;');
            const content = (r.content || '').replace(/</g, '&lt;');
            const page = normalizeRecordUrl(r);
            const id = (r.id || '').replace(/"/g, '&quot;');
            const openTag = page
                ? `<a class="be-fav-open" href="${page}" target="_blank" rel="noopener">打开原评论</a>`
                : '';
            return `<div class="be-fav-item">
                <div class="be-fav-item-meta">${uname} · 评论于 ${ctime} · 收藏于 ${savedAt}</div>
                <div class="be-fav-item-content">${content}</div>
                <div class="be-fav-item-actions">
                    ${openTag}
                    <button class="be-fav-del" data-id="${id}">删除</button>
                </div>
            </div>`;
        }).join('');
    }

    async function removeFavorite(id) {
        try {
            await favDelete(id);
            favoriteIdSet.delete(id);
            await renderFavoritesList();
            showFavToast('已删除收藏');
        } catch (e) {
            showFavToast('删除失败：' + ((e && e.message) || e));
        }
    }

    /** 设置收藏按钮的已收藏视觉状态 */
    function setFavButtonState(btn, faved) {
        const svg = btn.querySelector('svg');
        const color = faved ? '#f6c344' : '#9499a0';
        btn.classList.toggle('be-faved', faved);
        btn.title = faved ? '取消收藏' : '收藏评论';
        if (svg) {
            svg.style.stroke = color;
            svg.style.fill = faved ? color : 'none';
        }
        btn.setAttribute('aria-pressed', faved ? 'true' : 'false');
    }

    /** 轻量提示条 */
    function showFavToast(msg) {
        let el = document.getElementById('be-fav-toast');
        if (!el) {
            el = document.createElement('div');
            el.id = 'be-fav-toast';
            el.style.cssText =
                'position:fixed;bottom:60px;left:50%;transform:translateX(-50%);' +
                'background:rgba(24,25,28,.92);color:#fff;padding:8px 16px;border-radius:8px;' +
                'font-size:13px;z-index:100000;opacity:0;transition:opacity .2s ease;' +
                'pointer-events:none;white-space:nowrap;box-shadow:0 4px 16px rgba(0,0,0,.2);';
            document.body.appendChild(el);
        }
        el.textContent = msg;
        el.style.opacity = '1';
        clearTimeout(el._t);
        el._t = setTimeout(() => { el.style.opacity = '0'; }, 2200);
    }

    function addFavoriteButton(root, data, replyControlRoot) {
        if (!settings.enableFavorite) return;
        if (!data.mid) return;
        if (replyControlRoot.querySelector('.be-fav-btn')) return;
        if (!replyControlRoot.children || replyControlRoot.children.length === 0) return;

        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'be-fav-btn';
        btn.setAttribute('aria-label', '收藏评论');
        btn.innerHTML =
            '<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">' +
            '<path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/>' +
            '</svg>';

        const s = btn.style;
        s.display = 'var(--be-show-fav, inline-flex)';
        s.alignItems = 'center';
        s.justifyContent = 'center';
        s.height = '22px';
        s.width = '22px';
        s.padding = '0';
        s.marginRight = '6px';
        s.marginLeft = '2px';
        s.border = 'none';
        s.background = 'transparent';
        s.cursor = 'pointer';
        s.flexShrink = '0';
        s.verticalAlign = 'middle';

        const svg = btn.querySelector('svg');
        if (svg) {
            svg.style.width = '14px';
            svg.style.height = '14px';
            svg.style.fill = 'none';
            svg.style.stroke = '#9499a0';
            svg.style.strokeWidth = '1.8';
            svg.style.strokeLinecap = 'round';
            svg.style.strokeLinejoin = 'round';
            svg.style.transition = 'stroke .2s ease, fill .2s ease';
        }

        setFavButtonState(btn, favoriteIdSet.has(commentUniqueId(data)));

        btn.addEventListener('mouseenter', () => {
            const c = btn.classList.contains('be-faved') ? '#f6c344' : '#ffb300';
            if (svg) svg.style.stroke = c;
        });
        btn.addEventListener('mouseleave', () => {
            setFavButtonState(btn, btn.classList.contains('be-faved'));
        });

        btn.addEventListener('click', async (e) => {
            e.stopPropagation();
            if (btn.disabled) return;
            btn.disabled = true;
            const res = await toggleFavorite(data);
            btn.disabled = false;
            if (res.ok) {
                setFavButtonState(btn, res.action === 'added');
                showFavToast(res.action === 'added' ? '已收藏' : '已取消收藏');
            } else if (res.error === 'no-file') {
                showFavToast('此浏览器不支持文件系统保存');
            } else {
                showFavToast('收藏失败：' + res.error);
            }
        });

        // 插入：放在点赞按钮之前，或追加到操作栏末尾
        if (replyControlRoot.children.like) {
            replyControlRoot.insertBefore(btn, replyControlRoot.children.like);
        } else {
            replyControlRoot.appendChild(btn);
        }
    }

    // ═══════════════════════════════════════════════════════════════
    // Module 9: 设置面板 UI
    // ═══════════════════════════════════════════════════════════════

    function createSettingsUI() {
        // ── 浮动按钮 ──
        const btn = document.createElement('div');
        btn.id = 'be-settings-btn';
        btn.title = '评论增强设置';
        btn.innerHTML = `
            <svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
                <circle cx="12" cy="12" r="3"/>
                <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>
            </svg>`;

        // ── 设置面板 ──
        const panel = document.createElement('div');
        panel.id = 'be-panel';
        panel.innerHTML = `
            <div id="be-panel-title">评论增强设置</div>
            <div class="be-row">
                <span class="be-row-label">IP 属地</span>
                <label class="be-toggle">
                    <input type="checkbox" id="be-toggle-ip" ${settings.showIp ? 'checked' : ''}>
                    <span class="be-toggle-track">
                        <span class="be-toggle-thumb"></span>
                    </span>
                </label>
            </div>
            <div class="be-row">
                <span class="be-row-label">粉丝数量</span>
                <label class="be-toggle">
                    <input type="checkbox" id="be-toggle-fans" ${settings.showFans ? 'checked' : ''}>
                    <span class="be-toggle-track">
                        <span class="be-toggle-thumb"></span>
                    </span>
                </label>
            </div>
            <div class="be-row">
                <span class="be-row-label">评论收藏</span>
                <label class="be-toggle">
                    <input type="checkbox" id="be-toggle-fav" ${settings.enableFavorite ? 'checked' : ''}>
                    <span class="be-toggle-track">
                        <span class="be-toggle-thumb"></span>
                    </span>
                </label>
            </div>
            <div class="be-row">
                <span class="be-row-label">收藏管理</span>
                <div class="be-row-actions">
                    <button type="button" id="be-view-fav" class="be-export-btn">查看</button>
                    <button type="button" id="be-export-fav" class="be-export-btn">导出</button>
                </div>
            </div>
        `;

        document.body.appendChild(btn);
        document.body.appendChild(panel);

        // ── 事件绑定 ──

        // 切换面板
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            panel.classList.toggle('be-visible');
        });

        // 点击外部关闭
        document.addEventListener('click', (e) => {
            if (!panel.classList.contains('be-visible')) return;
            if (!panel.contains(e.target) && e.target !== btn && !btn.contains(e.target)) {
                panel.classList.remove('be-visible');
            }
        });

        // ESC 关闭
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && panel.classList.contains('be-visible')) {
                panel.classList.remove('be-visible');
            }
        });

        // IP 开关
        panel.querySelector('#be-toggle-ip').addEventListener('change', function () {
            settings.showIp = this.checked;
            saveSettings(settings);
            applyVisibility();
        });

        // 粉丝开关
        panel.querySelector('#be-toggle-fans').addEventListener('change', function () {
            settings.showFans = this.checked;
            saveSettings(settings);
            applyVisibility();
        });

        // 评论收藏开关
        panel.querySelector('#be-toggle-fav').addEventListener('change', function () {
            settings.enableFavorite = this.checked;
            saveSettings(settings);
            applyVisibility();
        });

        // 查看收藏
        panel.querySelector('#be-view-fav').addEventListener('click', function () {
            openFavoritesPanel();
        });

        // 导出收藏
        panel.querySelector('#be-export-fav').addEventListener('click', async function () {
            try {
                await exportFavorites();
            } catch (e) {
                showFavToast('导出失败：' + ((e && e.message) || e));
            }
        });
    }

    // ═══════════════════════════════════════════════════════════════
    // Module 10: 入口 & 编排
    // ═══════════════════════════════════════════════════════════════

    function init() {
        if (!matchPage(CONFIG.enabledPages)) return;

        injectStyles();
        applyVisibility(); // 应用初始可见性设置
        createSettingsUI();
        initFavoriteState(); // 恢复收藏文件句柄与已收藏集合

        // 监听主题切换，重新着色粉丝 Badge
        new MutationObserver(() => {
            recolorAllFanBadges();
        }).observe(document.documentElement, {
            attributes: true,
            attributeFilter: ['data-theme'],
        });

        const observer = new MutationObserver(() => {
            labelAllComments(observer);
        });

        observer.observe(document.body, {
            childList: true,
            subtree: true,
        });

        // 首次扫描已加载的评论
        labelAllComments(observer);
    }

    // ── 启动 ──

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
