/**
 * WebSocket 连接、鉴权与消息合并 —— 从 web-vue3/src/store/websocket.js 移植。
 *
 * ⚠️★ 与 Vue 版的**唯一结构性差异**：定时器（心跳 / ping / token 刷新 / 收件合帧）放在
 * **模块级变量**里，而不是 store state。React 严格模式下 effect 会双调用，把定时器放进
 * 响应式 state 很容易被重复创建、或随组件卸载被误清；集中在模块级、由本模块独占管理最稳。
 *
 * ⚠️★ 首次连接**不要**写在组件的 useEffect 里（开发期会连两次）。由引导阶段的
 * `startRealtime()` 调 `useWebSocketStore.getState().connect()`，且 `connect()` 自身幂等
 * （`websocketConnecting` 守卫）。
 *
 * ⚠️★ DropLeaf（单人剪贴板）：房间已删除 —— 后端房间恒 `default`，归一化后是空串。
 * 房间切换 / 地址栏同步那一层已拆掉，只保留 `normalizeRoomName`（写请求仍带 `?room=`）。
 */
import { create } from 'zustand';
import axios from 'axios';
import { API_BASE_URL } from '@/lib/base';
import { useAppStore, type AppConfig, type ReceivedItem } from './appStore';
import { engine } from './draftStore';
import { useAuthStore } from './authStore';

// ⚠️ 草稿引擎的会话守卫（最终收尾）：resync 补拉的迟到结果不得写回。
// 放在模块初始化时注册一次；判据是「登录门仍处于 ready」——退出/会话失效后
// 返回的 GET /draft 结果会被 reconcile 丢弃。
engine.setSessionGuard(() => useAuthStore.getState().phase === 'ready');

/**
 * 房间会话令牌的存储键。
 *
 * ⚠️★ 存在 **`localStorage`** 里，不是 `sessionStorage`（2026-10-26 改）。
 * 用户报的「PWA 每次回去都要输密码」就是这一条：`sessionStorage` 的生命周期是
 * **一个标签页 / 一次会话**，而手机上的 PWA 被切到后台、被系统回收、或者被用户从多任务里
 * 划掉之后，sessionStorage 就**没了** —— 于是每次打开都当成「从没登过」。
 * 桌面浏览器上不容易发现，因为标签页通常一直开着。
 *
 * ⚠️ 换成 `localStorage` **不会**延长令牌的权限：它自带 `expiresAt`
 * （见 `getEffectiveAuthEntry` 里那道过期判断），到点照样要重输密码。
 * 变的只是「关掉应用之后还记得多久」。
 *
 * ⚠️ 这是唯一一处把房间凭据落盘的地方 —— 它是个**有时限**的会话令牌，不是密码本身。
 */
const ROOM_AUTH_CACHE_KEY = 'roomAuthCache';
const DEFAULT_ROOM_KEY = '__default__';
export const GLOBAL_ROOM_KEY = '__global__';

/**
 * 条目的 id —— **一律归一成字符串**。
 *
 * ⚠️★ 线上契约里 id 有**两种形状**（Go 导出的冻结用例就是证据）：
 *   · WS 事件（`receive` / `update` / `revoke`）：**数字** —— `cases/protocol/text_receive.json` 的 `"id":7`；
 *   · HTTP 历史（`/content`、`/content/latest`）：**字符串** —— `cases/protocol/content_list.json` 的 `"id":"7"`。
 * 而 `ReceivedItem.id` 声明的是 `string`。
 *
 * ⚠️★ 所以**任何拿事件里的 id 去和列表比**的地方都必须先过这里。不过的后果是**静默**的：
 * 刷新之后列表来自历史（字符串），`e.id === data.id`（数字）永远不成立 →
 * 删除**成功了**但卡片不消失、要再刷新一次；`update` 事件同理不生效。
 * （2026-10-20 修的就是这个。Vue 版当年也是同一个写法，所以这 bug 一直都在。）
 */
function itemId(item: { id?: unknown } | null | undefined): string {
    return String(item?.id ?? '');
}

/** 鉴权缓存的条目：新格式是对象（带过期），老格式是裸字符串（视为不过期）。 */
export type RoomAuthEntry = string | { token: string; expiresAt: number };

function loadRoomAuthCache(): Record<string, RoomAuthEntry> {
    let fromStore: Record<string, RoomAuthEntry> = {};
    try {
        // ⚠️ 老版本写的是 sessionStorage（关掉就没了）。**顺手读一眼**：同一次会话里
        // 升级上来的用户不至于被多问一次密码 —— 下一次 persist 就落到 localStorage 了。
        const raw = localStorage.getItem(ROOM_AUTH_CACHE_KEY)
            || sessionStorage.getItem(ROOM_AUTH_CACHE_KEY);
        if (raw) {
            const parsed = JSON.parse(raw);
            if (parsed && typeof parsed === 'object') {
                fromStore = parsed;
            }
        }
    } catch {
        fromStore = {};
    }
    return fromStore;
}

// ── 定时器（模块级，见文件头）────────────────────────────────────────────
let pingTimer: ReturnType<typeof setInterval> | null = null;
let authRefreshTimer: ReturnType<typeof setTimeout> | null = null;
let receiveFlushTimer: ReturnType<typeof setTimeout> | null = null;
let pendingReceiveQueue: unknown[] = [];

// ── resync 补拉的有限重试（最终收尾）──────────────────────────────────────
// DO 在纪元故障后补发 resync；补拉走 HTTP（GET /draft、GET /content），
// 连续故障时（限流 503、D1 不可用、网络抖动）失败需要重试。规则：
//   · 只对**可重试**错误重试：网络错误（无 response）、429、5xx；
//     401 交给现有会话失效流程（不在这重试）；其余 4xx 是确定性失败，重试无意义；
//   · 间隔 2s → 5s → 15s，最多 3 次；任何一项成功后立即停止该项的重试；
//   · 草稿与历史**分别**判断：一项成功不影响另一项的重试；
//   · 多个 resync 合并：同一补拉会话里草稿/历史各只有一个任务在跑；
//   · 退出/切换会话时取消全部任务；迟到结果不写回（每轮补拉记一个会话代号）。
type RetryError = { response?: { status?: number } };
const RESYNC_RETRY_DELAYS_MS = [2_000, 5_000, 15_000];

const isRetryableHttpError = (error: RetryError): boolean => {
    const status = error?.response?.status ?? 0;
    // 无 response / status 0 = 网络层失败（断网、DNS、连接被断）。
    if (!status) return true;
    return status === 429 || status >= 500;
};

interface ResyncTask { attempt: number; timer: ReturnType<typeof setTimeout> | null }
interface ResyncSession { generation: number; draft: ResyncTask | null; history: ResyncTask | null }

let resyncSession: ResyncSession | null = null;

/** 取消当前补拉会话的全部任务（退出/切换会话时调用）。迟到结果靠代号比对丢弃。 */
function cancelResyncTasks(): void {
    if (resyncSession?.draft?.timer) clearTimeout(resyncSession.draft.timer);
    if (resyncSession?.history?.timer) clearTimeout(resyncSession.history.timer);
    resyncSession = null;
}

/** 发一拍延迟探测（服务端回 `pong`，并顺带续期 presence）。 */
function sendPing(socket: WebSocket | null): void {
    if (!socket || socket.readyState !== WebSocket.OPEN) {
        return;
    }
    try {
        socket.send(JSON.stringify({ event: 'ping', data: Date.now() }));
    } catch { /* 连接刚好断了就算了 */ }
}

// 标签页切换 / 休眠唤醒 / 网络恢复（最终收尾）。
// 后台标签页的 setInterval 会被浏览器节流，30s 的 ping 可能被拖长；回到前台
// 立刻补一拍，在线状态与延迟数字马上恢复。断线时（休眠/换网）由 onclose 重连
// 覆盖，这里再补一条 `online` 立即重连，不等 15s 的静默重试。
let lifecycleBound = false;
function bindLifecycle(get: () => WsState): void {
    if (lifecycleBound || typeof window === 'undefined') {
        return;
    }
    lifecycleBound = true;

    window.addEventListener('online', () => {
        const state = get();
        if (!state.websocket && !state.websocketConnecting) {
            void state.connect();
        }
    });

    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState !== 'visible') {
            return;
        }
        const state = get();
        if (state.websocket && state.websocket.readyState === WebSocket.OPEN) {
            sendPing(state.websocket);
        } else if (!state.websocketConnecting) {
            void state.connect();
        }
    });
}

function normalizeRoomName(room = ''): string {
    const normalized = (room || '').trim();
    return normalized === 'default' ? '' : normalized;
}

interface WsState {
    websocket: WebSocket | null;
    websocketConnecting: boolean;
    authCode: string;
    roomAuthCache: Record<string, RoomAuthEntry>;
    roomProtectionCache: Record<string, boolean>;
    room: string;
    retry: number;
    latency: number | null;

    normalizeRoomName: (room?: string) => string;
    getRoomStorageKey: (room?: string) => string;
    persistRoomAuthCache: () => void;
    getGlobalAuthToken: () => string;
    getEffectiveAuthEntry: (room?: string) => { token: string; expiresAt: number; key: string } | null;
    getAuthTokenForRoom: (room?: string) => string;
    cacheAuthTokenForRoom: (room: string, token: string, expiresAt?: number) => void;
    clearAuthTokenForRoom: (room?: string) => void;
    getKnownAuthTokens: (room?: string) => string[];
    clearAuthRefreshTimer: () => void;
    setRoomProtection: (room: string, isProtected: boolean) => void;
    fetchServerInfo: (room?: string, opts?: { token?: string }) => Promise<Record<string, unknown>>;
    verifyRoomAccess: (room: string, token: string) => Promise<boolean>;
    resolveAuthTokenForRoom: (room: string, opts?: { interactive?: boolean }) => Promise<string | null>;
    obtainRoomSessionToken: (room: string, password: string) => Promise<{ token: string | null; expiresAt: number; scope: string; unauthorized: boolean } | null>;
    refreshRoomSessionToken: (room: string) => Promise<{ token: string | null; expiresAt: number; scope: string; unauthorized: boolean } | null>;
    scheduleAuthRefresh: (room?: string) => void;
    getWebSocketEndpoint: (room?: string) => string;
    connect: () => Promise<void>;
    flushPendingReceives: () => void;
    mergeMessages: (incomingItems: ReceivedItem[]) => void;
    queueReceive: (data: ReceivedItem) => void;
    loadHistoryFromHttp: (room?: string) => Promise<ReceivedItem[] | null>;
    handleEvent: (event: string, data: unknown) => void;
    disconnect: () => void;
    failure: () => void;
    handleHttpUnauthorized: (config?: { params?: unknown; __sentAuthToken?: string }) => void;
    getRequestRoom: (config?: { params?: unknown }) => string;
    getRequestAuthToken: (config?: { params?: unknown }) => string;
}

export const useWebSocketStore = create<WsState>((set, get) => ({
    websocket: null,
    websocketConnecting: false,
    authCode: '',
    roomAuthCache: loadRoomAuthCache(),
    roomProtectionCache: {},
    room: '',
    retry: 0,
    latency: null,


    /* ---------- 房间/鉴权工具 ---------- */
    normalizeRoomName,
    getRoomStorageKey: (room) => normalizeRoomName(room ?? get().room) || DEFAULT_ROOM_KEY,
    persistRoomAuthCache: () => {
        // ⚠️ 写不进去**不算错**（隐私模式 / 配额满）：代价只是「下次还要输密码」，
        // 而抛出去会把登录流程整个打断 —— 那是更糟的方向。所以吞掉，但留一句话。
        try {
            localStorage.setItem(ROOM_AUTH_CACHE_KEY, JSON.stringify(get().roomAuthCache));
            // 老版本那份还在的话清掉，免得下次 load 时读到过期的旧值。
            sessionStorage.removeItem(ROOM_AUTH_CACHE_KEY);
        } catch (error) {
            console.warn('[paste] 令牌存不下来（下次打开要重新输密码）：', error);
        }
    },
    getGlobalAuthToken: () => {
        const entry = get().roomAuthCache[GLOBAL_ROOM_KEY];
        if (typeof entry === 'string') {
            return entry;
        }
        if (entry && typeof entry === 'object' && typeof entry.token === 'string') {
            return entry.token;
        }
        return '';
    },
    getEffectiveAuthEntry: (room) => {
        const now = Math.floor(Date.now() / 1000);
        const cache = get().roomAuthCache;
        const read = (key: string) => {
            const entry = cache[key];
            if (typeof entry === 'string' && entry) {
                return { token: entry, expiresAt: 0, key };
            }
            if (entry && typeof entry === 'object' && typeof entry.token === 'string' && entry.token) {
                const expiresAt = Number(entry.expiresAt) || 0;
                if (expiresAt > 0 && expiresAt <= now) {
                    return null;
                }
                return { token: entry.token, expiresAt, key };
            }
            return null;
        };
        return read(get().getRoomStorageKey(room)) || read(GLOBAL_ROOM_KEY);
    },
    getAuthTokenForRoom: (room) => {
        const effective = get().getEffectiveAuthEntry(room);
        return effective ? effective.token : '';
    },
    cacheAuthTokenForRoom: (room, token, expiresAt = 0) => {
        const normalizedToken = (token || '').trim();
        const key = get().getRoomStorageKey(room);
        if (!normalizedToken) {
            get().clearAuthTokenForRoom(room);
            return;
        }
        const cache = { ...get().roomAuthCache };
        const existing = cache[key];
        const effectiveExpiresAt = Number(expiresAt) > 0
            ? Number(expiresAt)
            : (existing && typeof existing === 'object' && Number(existing.expiresAt) > 0 ? Number(existing.expiresAt) : 0);
        cache[key] = { token: normalizedToken, expiresAt: effectiveExpiresAt };
        set({ roomAuthCache: cache });
        get().persistRoomAuthCache();
        if (normalizeRoomName(room) === normalizeRoomName(get().room)) {
            set({ authCode: normalizedToken });
        }
        get().scheduleAuthRefresh(room);
    },
    clearAuthTokenForRoom: (room) => {
        const key = get().getRoomStorageKey(room);
        const cache = { ...get().roomAuthCache };
        if (Object.prototype.hasOwnProperty.call(cache, key)) {
            delete cache[key];
            set({ roomAuthCache: cache });
            get().persistRoomAuthCache();
        }
        if (normalizeRoomName(room ?? get().room) === normalizeRoomName(get().room)) {
            set({ authCode: '' });
            get().clearAuthRefreshTimer();
        }
    },
    getKnownAuthTokens: (room) => {
        const tokens: string[] = [];
        const push = (token: RoomAuthEntry | undefined) => {
            let value: unknown = token;
            if (token && typeof token === 'object' && typeof token.token === 'string') {
                value = token.token;
            }
            const normalized = String(value || '').trim();
            if (normalized && !tokens.includes(normalized)) {
                tokens.push(normalized);
            }
        };
        push(get().getAuthTokenForRoom(room));
        push(get().authCode);
        Object.values(get().roomAuthCache).forEach(push);
        return tokens;
    },
    clearAuthRefreshTimer: () => {
        if (authRefreshTimer) {
            clearTimeout(authRefreshTimer);
            authRefreshTimer = null;
        }
    },
    setRoomProtection: (room, isProtected) => {
        set({ roomProtectionCache: { ...get().roomProtectionCache, [normalizeRoomName(room)]: Boolean(isProtected) } });
    },
    fetchServerInfo: async (room, { token = '' } = {}) => {
        const response = await axios.get('server', {
            params: new URLSearchParams([['room', normalizeRoomName(room ?? get().room)]]),
            headers: token ? { Authorization: `Bearer ${token}` } : undefined,
            __skipRoomAuthHandling: true,
        });
        if (Object.prototype.hasOwnProperty.call(response.data || {}, 'roomProtected')) {
            get().setRoomProtection(room ?? get().room, response.data.roomProtected);
        }
        return response.data;
    },
    verifyRoomAccess: async (room, token) => {
        if (!token) {
            return false;
        }
        const serverInfo = await get().fetchServerInfo(room, { token });
        return serverInfo.auth ? serverInfo.authorized === true : true;
    },
    resolveAuthTokenForRoom: async (room, { interactive = true } = {}) => {
        const normalizedRoom = normalizeRoomName(room);
        const cachedToken = get().getAuthTokenForRoom(normalizedRoom);
        if (cachedToken) {
            return cachedToken;
        }
        const serverInfo = await get().fetchServerInfo(normalizedRoom);
        if (!serverInfo.auth) {
            return '';
        }
        const candidates = get().getKnownAuthTokens(normalizedRoom);
        for (const token of candidates) {
            if (await get().verifyRoomAccess(normalizedRoom, token)) {
                return token;
            }
        }
        if (interactive) {
            // 会话拿不到任何有效令牌：确认失效，回登录页（全页登录页取代了旧弹窗）
            useAuthStore.getState().invalidate();
        }
        return null;
    },
    obtainRoomSessionToken: async (room, password) => {
        try {
            const response = await axios.post('auth/token', { password }, {
                params: new URLSearchParams([['room', normalizeRoomName(room)]]),
                __skipRoomAuthHandling: true,
            });
            const data = response.data || {};
            return {
                token: data.token || null,
                expiresAt: Number(data.expiresAt) || 0,
                scope: data.scope === 'global' ? 'global' : '',
                unauthorized: false,
            };
        } catch (error) {
            console.error('Failed to obtain session token:', error);
            // 401 = 密码不对（服务端明确拒绝）；其它（网络/5xx/429）交给 login 页的
            // networkError 分支 —— 密码错误提示和网络故障提示必须分开。
            const status = (error as { response?: { status?: number } })?.response?.status ?? 0;
            return { token: null, expiresAt: 0, scope: '', unauthorized: status === 401 };
        }
    },
    refreshRoomSessionToken: async (room) => {
        const normalizedRoom = normalizeRoomName(room);
        const currentToken = get().getAuthTokenForRoom(normalizedRoom);
        if (!currentToken) {
            return null;
        }
        // ⚠️★ 续签也有「迟到响应」竞态（复审 2026-11-05）：请求发出后用户可能已经
        // 退出并重新登录（令牌换代）。普通请求的 401 由 handleHttpUnauthorized 按
        // __sentAuthToken 比对丢弃；续签走 __skipRoomAuthHandling，必须在这里自己比。
        // 否则旧续签的 401 会把刚登录的新令牌清掉、把人踢回登录页。
        const sentToken = currentToken;
        const isStale = () => {
            const latest = get().getAuthTokenForRoom(normalizedRoom);
            return latest !== sentToken;
        };
        try {
            const response = await axios.post('auth/token/refresh', null, {
                params: new URLSearchParams([['room', normalizedRoom]]),
                __skipRoomAuthHandling: true,
            });
            if (isStale()) {
                // 会话已换代：旧续签的结果不覆盖新令牌（新令牌由登录流程自己管）。
                return { token: null, expiresAt: 0, scope: '', unauthorized: false };
            }
            const data = response.data || {};
            return {
                token: data.token || null,
                expiresAt: Number(data.expiresAt) || 0,
                scope: data.scope === 'global' ? 'global' : '',
                unauthorized: false,
            };
        } catch (error) {
            console.error('Failed to refresh session token:', error);
            // 401 = 服务器明确拒绝续签（会话确认失效）；其它（网络/5xx）不算失效
            const status = (error as { response?: { status?: number } })?.response?.status ?? 0;
            if (status === 401 && isStale()) {
                // 旧会话的迟到 401：当前令牌已经换代，不能当作「新会话失效」。
                return { token: null, expiresAt: 0, scope: '', unauthorized: false };
            }
            return { token: null, expiresAt: 0, scope: '', unauthorized: status === 401 };
        }
    },
    scheduleAuthRefresh: (room) => {
        get().clearAuthRefreshTimer();
        const normalizedRoom = normalizeRoomName(room ?? get().room);
        if (normalizedRoom !== normalizeRoomName(get().room)) {
            return;
        }
        const effective = get().getEffectiveAuthEntry(normalizedRoom);
        const token = effective ? effective.token : '';
        const expiresAt = effective ? effective.expiresAt : 0;
        if (!token || !expiresAt) {
            return;
        }
        const remainingSeconds = expiresAt - Math.floor(Date.now() / 1000);
        // ⚠️★ 剩余 ≤60s 时**不再直接放弃**（安全修复 2026-11-05 的竞态修复）：
        // 旧逻辑在「到期前 60s 断网」的窗口里，失败分支重新调度会被这道门拦住，
        // 续签就永远发不出去了。现在：剩余 >0 就照排，重试间隔取 min(30s, 剩余)，
        // 有上限（Bounded retries）—— 令牌真的过期时由后续 401/续签 401 走失效路径。
        if (remainingSeconds <= 0) {
            return;
        }
        const delay = remainingSeconds > 60
            ? Math.min((remainingSeconds - 60) * 1000, 24 * 60 * 60 * 1000)
            : Math.min(remainingSeconds * 1000, 30_000);
        authRefreshTimer = setTimeout(async () => {
            authRefreshTimer = null;
            const refreshed = await get().refreshRoomSessionToken(normalizedRoom);
            if (refreshed && refreshed.token) {
                const cacheRoom = refreshed.scope === 'global' ? GLOBAL_ROOM_KEY : effective!.key;
                get().cacheAuthTokenForRoom(cacheRoom, refreshed.token, refreshed.expiresAt);
                get().scheduleAuthRefresh(normalizedRoom);
            } else if (refreshed && refreshed.unauthorized) {
                // 服务器明确拒绝续签（401）：会话确认失效，清令牌回登录页
                get().clearAuthTokenForRoom(normalizedRoom);
                useAuthStore.getState().invalidate();
            } else {
                // 网络/服务器暂时性失败：令牌多半仍有效，30s 内（或剩余时间内）再试，
                // 直到拿到新令牌或会话被确认失效。不踢登录页 —— 后续 API 若真 401
                // 会走 handleHttpUnauthorized 那条确认路。
                get().scheduleAuthRefresh(normalizedRoom);
            }
        }, delay);
    },

    getWebSocketEndpoint: (room) => {
        // ⚠️★ 连的是**后端**（`API_BASE_URL`），不是页面所在的目录：分离部署时页面在
        // CDN 上，往页面那边发 WS 只会得到一个 404 的 HTML 响应（浏览器报
        // 「WebSocket 握手失败」，看不出是地址拼错了）。
        //
        // ⚠️★ 协议跟着**后端地址**走，不能看 `location.protocol`：页面是 https、
        // 后端是 http 的开发/内网部署下，那两个结论正好相反 —— 用错的那个会被浏览器
        // 当成混合内容拦掉。
        //
        // ⚠️ 必须用地址本身（从 `document.baseURI` / 配置推导），**不能**用 config.server.prefix ——
        // 后者只能从 WS 握手的 `config` 事件拿到，而这里正是为了连上 WS 才拼地址（鸡生蛋）。
        const wsUrl = new URL('push', API_BASE_URL);
        wsUrl.protocol = wsUrl.protocol === 'https:' ? 'wss:' : 'ws:';
        const normalizedRoom = normalizeRoomName(room ?? get().room);
        if (normalizedRoom) {
            wsUrl.searchParams.set('room', normalizedRoom);
        }
        return wsUrl.toString();
    },

    /* ---------- 连接 ---------- */
    connect: async () => {
        if (get().websocketConnecting) {
            return;
        }
        set({ websocketConnecting: true });
        try {
            const currentRoom = normalizeRoomName(get().room);
            let resolvedToken: string | null = get().getAuthTokenForRoom(currentRoom);

            // 无论是否已缓存 token，都先探测 /server 以可靠获知房间是否需要认证。
            const serverInfo = await get().fetchServerInfo(currentRoom);
            if (!resolvedToken && serverInfo.auth) {
                resolvedToken = await get().resolveAuthTokenForRoom(currentRoom, { interactive: true });
                if (resolvedToken === null) {
                    set({ websocketConnecting: false });
                    return;
                }
            }

            const wsUrl = get().getWebSocketEndpoint(currentRoom);
            const protocols = resolvedToken ? [resolvedToken] : [];

            const ws = await new Promise<WebSocket>((resolve, reject) => {
                const socket = new WebSocket(wsUrl, protocols);
                socket.onopen = () => resolve(socket);
                socket.onerror = reject;
            });

            set({ websocket: ws, websocketConnecting: false, retry: 0 });
            set({ authCode: resolvedToken || get().getAuthTokenForRoom(currentRoom) });
            // DropLeaf 草稿引擎：连接建立 = 对账起点（冷启动恢复 / 重连对账都从这里进，
            // 见 draftStore 的 reconcile）。断开侧在下面 onclose 里。
            void engine.onOnline();

            // ── 空闲心跳与延迟探测合并（最终收尾）────────────────────────
            // 服务端 `handleMessage` 对**任何**消息都会续期在线状态（presence），
            // ping 帧走的就是同一条续期逻辑 —— 30s 空心跳是重复的，删掉。
            // 连接建立**立即**测一次 RTT（首屏延迟数字不用等 30s），之后每 30s 一发。
            // ⚠️ 原来 ping 是 3s 一次：纯额度浪费（免费档按时长计费不变，
            // 但每条消息都是一次 DO 请求）。服务端 presence TTL 120s、清理周期 60s，
            // 30s 的间隔足以维持在线状态。
            const ping = () => sendPing(get().websocket);
            ping();
            pingTimer = setInterval(ping, 30_000);
            // 标签页切换/休眠唤醒/网络恢复：回到前台立刻补一拍，断线立即重连。
            bindLifecycle(get);

            ws.onclose = async () => {
                if (pingTimer) {
                    clearInterval(pingTimer);
                    pingTimer = null;
                }
                set({ latency: null, websocket: null, websocketConnecting: false });
                useAppStore.setState({ device: [] });
                // 草稿引擎标记离线并定时重试对账（规则 6）；重连成功后 onOnline 再对账。
                engine.onOffline();
                if (get().retry < 3) {
                    set({ retry: get().retry + 1 });
                    setTimeout(() => { void get().connect(); }, 3000);
                    return;
                }
                // 重试耗尽：**只有服务器确认令牌已失效才回登录页**；网络不通 →
                // 保持离线（草稿在引擎内存里），15s 后静默再试 —— 断网不踢登录页。
                try {
                    const info = await get().fetchServerInfo(get().room);
                    if (info.auth) {
                        const token = get().getAuthTokenForRoom(get().room);
                        const stillValid = token ? await get().verifyRoomAccess(get().room, token) : false;
                        if (!stillValid) {
                            get().clearAuthTokenForRoom(get().room);
                            useAuthStore.getState().invalidate();
                            return;
                        }
                    }
                    setTimeout(() => { void get().connect(); }, 15_000);
                } catch {
                    setTimeout(() => { void get().connect(); }, 15_000);
                }
            };
            ws.onmessage = (e) => {
                try {
                    const parsed = JSON.parse(e.data);
                    get().handleEvent(parsed.event, parsed.data);
                } catch { /* 非 JSON 帧忽略 */ }
            };
        } catch {
            set({ websocketConnecting: false });
            get().failure();
        }
    },

    flushPendingReceives: () => {
        if (receiveFlushTimer) {
            clearTimeout(receiveFlushTimer);
            receiveFlushTimer = null;
        }
        if (!pendingReceiveQueue.length) {
            return;
        }
        const newItems = pendingReceiveQueue.splice(0);
        get().mergeMessages(newItems as ReceivedItem[]);
    },
    mergeMessages: (incomingItems) => {
        if (!incomingItems || !incomingItems.length) {
            return;
        }
        const app = useAppStore.getState();
        // ⚠️★ 顺手把**已有条目**的 id 也归一（老缓存里可能是数字）——
        //    否则列表会长期混着两种形状，去重与 `findIndex` 都会漏。
        const currentList = app.received.map((item) =>
            typeof item.id === 'string' ? item : { ...item, id: itemId(item) },
        );
        const existingIdMap = new Map<string, number>();
        currentList.forEach((item, index) => {
            existingIdMap.set(itemId(item), index);
        });

        for (const raw of incomingItems) {
            const item = { ...raw, id: itemId(raw) };
            const idx = existingIdMap.get(item.id);
            if (idx !== undefined) {
                currentList[idx] = { ...currentList[idx], ...item };
            } else {
                currentList.push(item);
            }
        }

        // 按时间倒序排列 (最新的排在最前)
        currentList.sort((a, b) => (Number(b.timestamp) || 0) - (Number(a.timestamp) || 0));

        // 如果有配置历史条数限制，进行截断
        const limit = Number(app.config?.server?.history || 0);
        if (limit > 0 && currentList.length > limit) {
            currentList.splice(limit);
        }

        useAppStore.setState({ received: currentList });
    },
    queueReceive: (data) => {
        pendingReceiveQueue.unshift(data);
        if (!receiveFlushTimer) {
            receiveFlushTimer = setTimeout(() => {
                get().flushPendingReceives();
            }, 32);
        }
    },
    // 返回**服务器这一页的原始消息**（而不是 void）：`resync` 需要据此判断
    // 「服务器历史为空」→ 整表清空（merge 只增不减，无法表达删除）。
    // ⚠️★ 失败时**上抛**：resync 的重试调度按 429/5xx/网络错误分类重试；
    // 其余调用方（config / history-appended）都是 fire-and-forget，在外层 catch 记日志。
    loadHistoryFromHttp: async (room) => {
        const normalizedRoom = normalizeRoomName(room ?? get().room);
        const response = await axios.get('content', {
            params: new URLSearchParams([['room', normalizedRoom]]),
        });
        // 请求还在飞的时候房间被换掉了 —— 这批历史不属于当前房间，丢弃（不写回）。
        if (normalizeRoomName(get().room) !== normalizedRoom) {
            return null;
        }
        const messages = response.data && Array.isArray(response.data.messages)
            ? response.data.messages
            : [];
        get().mergeMessages(messages);
        return messages;
    },
    handleEvent: (event, data) => {
        switch (event) {
            case 'receive':
                get().queueReceive(data as ReceivedItem);
                break;
            case 'receiveMulti':
                get().flushPendingReceives();
                get().mergeMessages(Array.isArray(data) ? (data as ReceivedItem[]) : [data as ReceivedItem]);
                break;
            case 'revoke': {
                get().flushPendingReceives();
                const app = useAppStore.getState();
                const received = [...app.received];
                // ⚠️ 事件里是数字、历史里是字符串 —— 必须过 `itemId`（见它的注释）。
                const targetId = itemId(data as { id?: unknown });
                const index = received.findIndex((e) => itemId(e) === targetId);
                if (index !== -1) {
                    received.splice(index, 1);
                    useAppStore.setState({ received });
                }
                break;
            }
            // 「清空剪贴板」的广播（含发起端自己）：之前**没有**这个分支 ——
            // 另一台设备只有刷新才会看到清空。现在直接清空列表（单人单房间）。
            case 'clearAll': {
                get().flushPendingReceives();
                useAppStore.setState({ received: [] });
                break;
            }
            case 'config': {
                get().flushPendingReceives();
                const config = data as AppConfig;
                useAppStore.setState({ config });
                // ⚠️ 拿到 `config` 就去取历史 —— 握手不再推历史，这条 HTTP 请求是**唯一**的来源。
                // loader 现在上抛错误（resync 的重试要用），这里尽力而为：失败记日志。
                get().loadHistoryFromHttp().catch((error) => console.error('config 后取历史失败:', error));
                console.log(
                    `%c DropLeaf ${config.version} %c private clipboard `,
                    'color:#fff;background-color:#f2572b',
                    'color:#fff;background-color:#fde8e0',
                );
                break;
            }
            case 'connect':
                useAppStore.setState({ device: [...useAppStore.getState().device, data as { id: string }] });
                break;
            case 'disconnect': {
                const device = [...useAppStore.getState().device];
                const index = device.findIndex((e) => e.id === (data as { id: string }).id);
                if (index !== -1) {
                    device.splice(index, 1);
                    useAppStore.setState({ device });
                }
                break;
            }
            case 'update': {
                get().flushPendingReceives();
                const app = useAppStore.getState();
                const received = [...app.received];
                // ⚠️ 与 revoke 同一条：事件里是数字，必须归一。
                const targetId = itemId(data as { id?: unknown });
                const index = received.findIndex((e) => itemId(e) === targetId);
                if (index !== -1) {
                    // ⚠️★ `id: targetId` 必须放在最后：`...(data as ReceivedItem)` 里那个 id
                    //    是数字，展开回来会把刚归一好的字符串又盖掉 —— 于是下一次 `update`
                    //    或 `revoke` 又匹配不上（同一条 bug 换个入口复发）。
                    received.splice(index, 1, { ...received[index], ...(data as ReceivedItem), id: targetId });
                    useAppStore.setState({ received });
                }
                break;
            }
            case 'forbidden': {
                // 服务器在 WS 层明确拒绝当前会话：确认失效，回登录页
                get().flushPendingReceives();
                get().clearAuthTokenForRoom(get().room);
                useAuthStore.getState().invalidate();
                break;
            }
            case 'pong': {
                if (typeof data === 'number' && data > 0) {
                    const rtt = Date.now() - data;
                    if (rtt >= 0) {
                        set({ latency: rtt });
                    }
                }
                break;
            }
            // DropLeaf 草稿同步：服务器每次草稿落库都会广播（**含自己 PUT 的回声** ——
            // 引擎按「自己刚 PUT 的 (id, revision, content) 指纹」识别并只更新基线；
            // 迟到帧 / 冲突的守卫也全在引擎里，见 stores/draftStore.ts）。
            case 'draft': {
                engine.applyRemoteDraft(data);
                break;
            }
            // 服务器在纪元故障期间跳过过广播，恢复后补发这条信号（第四轮复审 P2）。
            // DO 会先按序重放跳过的事件（revoke/clearAll 因此精确生效），这条 resync
            // 负责整体对账：重拉草稿（幂等），并重拉历史。
            // ⚠️★ `mergeMessages` 只增不减 —— 服务器返回**空列表**时必须整表清空，
            // 否则「清空后没有新写入」的窗口里本机旧历史永远不会消失
            // （重放队列丢失 / DO 重启时这是唯一的兜底）。
            //
            // ⚠️★ 最终收尾：补拉失败要**有限重试**（草稿/历史分别判断）。
            // 多个 resync 合并成同一个补拉会话；退出/切换会话时整体取消。
            case 'resync': {
                if (!resyncSession) {
                    resyncSession = { generation: Date.now(), draft: null, history: null };
                }
                const generation = resyncSession.generation;
                // 某一项到达终态（成功/确定性失败/重试用尽）时清掉它；
                // 两项都结束时整体拆除 —— 下一次 resync 会重新开始一轮补拉。
                const settle = (kind: 'draft' | 'history') => {
                    if (!resyncSession || resyncSession.generation !== generation) return;
                    resyncSession[kind] = null;
                    if (!resyncSession.draft && !resyncSession.history) {
                        resyncSession = null;
                    }
                };

                // ── 草稿补拉：走原有对账（保留未同步输入与冲突处理），失败按退避重试 ──
                if (!resyncSession.draft) {
                    resyncSession.draft = { attempt: 0, timer: null };
                    const pullDraft = async () => {
                        const task = resyncSession?.draft;
                        if (!resyncSession || resyncSession.generation !== generation || !task) {
                            return; // 会话已取消/换代：迟到结果不写回
                        }
                        try {
                            const result = await engine.onServerResync();
                            if (!resyncSession || resyncSession.generation !== generation) {
                                return; // 迟到结果：不写回、不再排重试
                            }
                            if (result.ok) {
                                settle('draft'); // 成功：停止该项重试
                                return;
                            }
                            if (!result.retryable) {
                                settle('draft'); // 确定性失败（含会话守卫）：不重试
                                return;
                            }
                            if (task.attempt >= RESYNC_RETRY_DELAYS_MS.length) {
                                console.warn('[paste] resync 草稿补拉重试用尽，等待下一次 resync');
                                settle('draft');
                                return;
                            }
                            const delay = RESYNC_RETRY_DELAYS_MS[task.attempt];
                            task.attempt += 1;
                            task.timer = setTimeout(() => { void pullDraft(); }, delay);
                        } catch (error) {
                            // reconcile 本身不再抛；这里兜住意外异常，按可重试处理。
                            if (!isRetryableHttpError(error as RetryError)) return;
                            if (task.attempt >= RESYNC_RETRY_DELAYS_MS.length) return;
                            const delay = RESYNC_RETRY_DELAYS_MS[task.attempt];
                            task.attempt += 1;
                            task.timer = setTimeout(() => { void pullDraft(); }, delay);
                        }
                    };
                    void pullDraft();
                }

                // ── 历史补拉：成功按服务器列表对齐（空 = 清表）；失败按退避重试 ──
                if (!resyncSession.history) {
                    resyncSession.history = { attempt: 0, timer: null };
                    const pullHistory = async () => {
                        const task = resyncSession?.history;
                        if (!resyncSession || resyncSession.generation !== generation || !task) {
                            return;
                        }
                        try {
                            const messages = await get().loadHistoryFromHttp();
                            if (!resyncSession || resyncSession.generation !== generation) {
                                return; // 迟到结果不写回
                            }
                            if (Array.isArray(messages) && messages.length === 0) {
                                useAppStore.setState({ received: [] });
                            }
                            settle('history'); // 成功（含空列表）
                        } catch (error) {
                            // loader 现在上抛错误：axios 错误带 response.status 可分类；
                            // 网络错误（无 response）按可重试处理；401 等确定性失败直接结束。
                            if (!isRetryableHttpError(error as RetryError)) {
                                settle('history');
                                return;
                            }
                            if (task.attempt >= RESYNC_RETRY_DELAYS_MS.length) {
                                console.warn('[paste] resync 历史补拉重试用尽，等待下一次 resync');
                                settle('history');
                                return;
                            }
                            const delay = RESYNC_RETRY_DELAYS_MS[task.attempt];
                            task.attempt += 1;
                            task.timer = setTimeout(() => { void pullHistory(); }, delay);
                        }
                    };
                    void pullHistory();
                }
                break;
            }
            // 保存归档后提醒时间线刷新：历史列表仍走 loadHistoryFromHttp 的合并去重，
            // 这里只负责「有人存了一条」这个信号（合并是幂等的，重复触发无害）。
            case 'history-appended': {
                get().loadHistoryFromHttp().catch((error) => console.error('取历史失败:', error));
                break;
            }
        }
    },
    disconnect: () => {
        set({ websocketConnecting: false });
        const socket = get().websocket;
        if (socket) {
            socket.onopen = null;
            socket.onmessage = null;
            socket.onerror = null;
            socket.onclose = null;
            socket.close();
            set({ websocket: null });
        }
        get().clearAuthRefreshTimer();
        // ⚠️ 退出/切换会话：取消进行中的 resync 补拉（草稿/历史重试全部停止）。
        // 迟到结果靠 generation 比对丢弃（见 pullDraft / pullHistory 里的守卫）。
        cancelResyncTasks();
        if (pingTimer) {
            clearInterval(pingTimer);
            pingTimer = null;
        }
        if (receiveFlushTimer) {
            clearTimeout(receiveFlushTimer);
            receiveFlushTimer = null;
        }
        pendingReceiveQueue = [];
        useAppStore.setState({ device: [] });
    },
    failure: () => {
        set({ websocket: null, latency: null });
        if (pingTimer) {
            clearInterval(pingTimer);
            pingTimer = null;
        }
        useAppStore.setState({ device: [] });
        const retry = get().retry;
        set({ retry: retry + 1 });
        if (retry < 3) {
            void get().connect();
        } else {
            // 连接暂不可达（服务器没拒绝认证）：不踢登录页，15s 后再试
            setTimeout(() => { void get().connect(); }, 15_000);
        }
    },
    handleHttpUnauthorized: (config = {}) => {
        // HTTP 401 = 服务器拒绝这条请求携带的令牌。⚠️★ 先做过期 401 守卫
        // （安全修复 2026-11-05 的竞态修复）：请求拦截器记下了 __sentAuthToken；
        // 它 ≠ 当前会话令牌 = 这是**旧会话的迟到响应**（重登成功后才返回）——
        // 丢弃即可，绝不能清掉/吊销刚换上的新令牌。
        const sent = (config as { __sentAuthToken?: string }).__sentAuthToken;
        if (sent) {
            const room = get().getRequestRoom(config);
            const current = get().getAuthTokenForRoom(room);
            if (sent !== current) {
                return;
            }
        }
        const room = get().getRequestRoom(config);
        get().clearAuthTokenForRoom(room);
        useAuthStore.getState().invalidate();
    },
    getRequestRoom: (config = {}) => {
        const params = config.params;
        if (params instanceof URLSearchParams) {
            return normalizeRoomName(params.get('room') || get().room);
        }
        if (params && typeof params === 'object' && (params as Record<string, unknown>).room !== undefined) {
            return normalizeRoomName(String((params as Record<string, unknown>).room));
        }
        return normalizeRoomName(get().room);
    },
    getRequestAuthToken: (config = {}) => {
        return get().getAuthTokenForRoom(get().getRequestRoom(config));
    },
}));

