/**
 * 登录门状态机 —— DropLeaf 唯一入口的会话判定与登录提交。
 *
 * 三个相位：
 *   · checking —— 冷启动/刷新时探测已有会话（避免闪出密码框）；
 *   · login    —— 无有效会话：只渲染全页登录页，工作区（编辑器/时间线/看板/工具栏）不挂载；
 *   · ready    —— 会话有效：挂载工作区并启动实时连接。
 *
 * 「踢回登录页」只有一个入口 `invalidate()`，且只在**服务端确认**会话失效时调用
 * （HTTP 401 / 令牌续签被明确拒绝 / WS 重试耗尽后服务器确认令牌无效）。
 * 短暂断网、WS 重连、续签暂时的网络失败都不踢 —— 草稿留在 draftStore 引擎的内存里。
 *
 * 密码/会话机制完全复用上游：POST /auth/token 签发 7 天令牌（localStorage 缓存 +
 * 到期前自动续签；服务端同时 Set HttpOnly Cookie 供媒体预览用），Worker 侧零改动。
 */
import { create } from 'zustand';
import { useWebSocketStore, GLOBAL_ROOM_KEY } from '@/stores/wsStore';
import { engine } from '@/stores/draftStore';
import { resetRealtime } from '@/services/bootstrap';
import axios from 'axios';
import i18n from '@/i18n';
import { toast } from '@/stores/toastStore';

export type AuthPhase = 'checking' | 'login' | 'ready';

/** 密码框旁的错误：invalid = 服务端判定密码不对（网络故障单独走 networkError）。 */
export type LoginError = '' | 'invalid';

interface AuthState {
    phase: AuthPhase;
    loginError: LoginError;
    /** 网络/服务器不可达（与密码错误分开提示，可重试）。 */
    networkError: boolean;
    /** 会话被确认失效后回到登录页：给一条「请重新登录」的提示。 */
    expired: boolean;
    submitting: boolean;
    /** 冷启动/刷新/登录页重试：探测服务器与已有会话，决定进工作区还是登录页。 */
    probe: () => Promise<void>;
    /** 登录页提交密码：签发会话令牌，成功后相位切 ready（由门挂载工作区）。 */
    login: (password: string) => Promise<void>;
    /** 主动退出：让服务端作废所有令牌（纪元 +1），清本机缓存，回登录页。 */
    logout: () => Promise<void>;
    invalidate: () => void;
}

export const useAuthStore = create<AuthState>((set, get) => ({
    phase: 'checking',
    loginError: '',
    networkError: false,
    expired: false,
    submitting: false,

    logout: async () => {
        const ws = useWebSocketStore.getState();
        const room = 'default';
        // 服务端作废：会话纪元 +1 → 所有旧令牌（含别的设备上的）立即失效。
        try {
            await axios.post('auth/logout', null, {
                params: new URLSearchParams([['room', room]]),
                __skipRoomAuthHandling: true,
            });
        } catch (error) {
            const status = (error as { response?: { status?: number } })?.response?.status ?? 0;
            if (status === 503) {
                // ⚠️★ 第二轮复审 P1：503 = 纪元已推进但 **DO 没收到撤销通知**。
                // 此时**必须保留本地令牌**：重试时服务端要用它认人（幂等分支会
                // 重新通知 DO）。清掉它就永远补不上那一次撤销。
                toast.error(i18n.t('logoutIncomplete'));
                return;
            }
            // 网络故障等：本机照样退出（令牌会在 7 天内过期，或由下一次 401 收口）。
            console.warn('[paste] 服务端退出请求失败（本机会话仍会清除）:', error);
        }
        // 全局令牌与房间令牌都要清：登录时缓存的是 `__global__` 键（scope=global），
        // 只清 default 会留下那条真正被所有请求用着的令牌。
        ws.clearAuthTokenForRoom(GLOBAL_ROOM_KEY);
        ws.clearAuthTokenForRoom(room);
        get().invalidate();
    },

    probe: async () => {
        set({ phase: 'checking', networkError: false });
        const ws = useWebSocketStore.getState();
        // DropLeaf：房间恒 default（单人剪贴板），与 bootstrap/写请求同一约定。
        const room = 'default';
        try {
            // 无论有没有缓存令牌，都先问一次 /server：开放实例（AUTH_PASSWORD 为空）
            // 的 auth=false 直接进工作区，不需要登录。
            const info = await ws.fetchServerInfo(room);
            if (!info.auth) {
                set({ phase: 'ready' });
                return;
            }
            const token = ws.getAuthTokenForRoom(room);
            if (token && await ws.verifyRoomAccess(room, token)) {
                set({ phase: 'ready' });
                return;
            }
            if (token) {
                // 令牌存在但已失效（过期/吊销）：清掉再请密码
                ws.clearAuthTokenForRoom(room);
            }
            set({ phase: 'login', loginError: '', expired: false });
        } catch {
            // 服务器探测不到：登录页 + 网络提示（可点重试）。会话是否有效无从判断，
            // 不进工作区 —— 工作区在没有后端的情况下没有意义。
            set({ phase: 'login', networkError: true });
        }
    },

    login: async (password) => {
        const trimmed = password.trim();
        if (get().submitting || !trimmed) {
            return;
        }
        set({ submitting: true, loginError: '', networkError: false });
        const ws = useWebSocketStore.getState();
        const room = 'default';
        try {
            // ⚠️★ 密码**只**走 POST /auth/token 这一条路（安全修复 2026-11-05）：
            // 服务端已不再把密码当有效 Bearer，「先 verify 再签发」的第一步必然失败。
            // 直接签发：密码错误 → 401（unauthorized:true）；网络故障 → unauthorized:false。
            const session = await ws.obtainRoomSessionToken(room, trimmed);
            if (!session) {
                // obtainRoomSessionToken 捕获非 401 错误后返回 null：视为网络故障
                set({ submitting: false, networkError: true });
                return;
            }
            if (!session.token) {
                set({
                    submitting: false,
                    loginError: session.unauthorized ? 'invalid' : '',
                    networkError: !session.unauthorized,
                });
                return;
            }
            // 与上游一致：全局密码签的是 scope=global 令牌（对全部房间有效），
            // 缓存键也用同一个 —— getEffectiveAuthEntry 按房间键回退到全局键。
            const cacheKey = session.scope === 'global' ? GLOBAL_ROOM_KEY : room;
            ws.cacheAuthTokenForRoom(cacheKey, session.token, session.expiresAt);
            // ⚠️ cacheAuthTokenForRoom 内部的 scheduleAuthRefresh 对 '__global__' 键
            // 不生效（键名与当前房间不匹配会提前返回），这里显式按房间排一次续签。
            ws.scheduleAuthRefresh(room);
            set({ submitting: false, phase: 'ready', expired: false });
        } catch {
            set({ submitting: false, networkError: true });
        }
    },

    invalidate: () => {
        if (get().phase === 'login') {
            return;
        }
        // 令牌的清除由调用方（handleHttpUnauthorized / 续签失败分支）先做 ——
        // 这里只负责收尾：断 WS、暂停草稿引擎的定时器（内容不动）、切回登录页。
        resetRealtime();
        useWebSocketStore.getState().disconnect();
        engine.stop();
        set({ phase: 'login', submitting: false, loginError: '', networkError: false, expired: true });
    },
}));
