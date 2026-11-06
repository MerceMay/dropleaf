/**
 * 草稿 / 保存归档的 HTTP 层 —— 单人剪贴板 DropLeaf 的三条新接口（契约见
 * PASTE-FRONTEND-CONTRACT.md「后端已就绪的 API」）：
 *
 *   · GET /draft  → { exists:false } 或 { exists:true, draft }
 *   · PUT /draft  → 乐观锁写；409 { error:'conflict', draft }（带服务端当前草稿）
 *   · POST /save  → 归档；{ status:'saved' | 'duplicate', … }；409 stale_draft
 *
 * ⚠️★ 这一层**不抛业务错误**（409 / stale 都翻译成结果对象）：调用方是同步状态机
 * （stores/draftStore.ts），它要的是「每一种结局都有一个分支」，而不是 try/catch。
 * 网络级失败（断网 / 5xx）同样返回 `{ ok:false, kind:'error' }` —— 引擎据此进离线重试，
 * 别在这里替它做重试决策。
 *
 * ⚠️ 鉴权走 axios 拦截器（services/http.ts 自动带 Bearer），无需 `?room=`：
 * 服务端对这三条路由硬编码房间 'default'。
 */
import axios from 'axios';
import { errorMessage, getClientId } from '@/lib/util';

export interface Draft {
    id: string;
    revision: number;
    content: string;
    /** 毫秒。⚠️ 历史条目的 timestamp 是**秒** —— 上游约定，别混着比。 */
    updatedAt?: number;
}

export interface DraftSnapshot {
    exists: boolean;
    draft?: Draft;
}

export interface PutDraftOptions {
    /** 不带 = 无条件写（首次 / 服务器还没有草稿行时）；带上 = 乐观锁。 */
    id?: string | null;
    revision?: number | null;
    content: string;
}

export type PutDraftResult =
    | { ok: true; draft: Draft }
    | { ok: false; kind: 'conflict'; draft: Draft }
    | { ok: false; kind: 'error'; message: string };

export interface SaveDraftOptions {
    draftId: string;
    /** 点击保存瞬间的完整快照（**不 trim**，与编辑器里的值一字不差）。 */
    content: string;
    /** 服务端拿它填 senderClientID（「这条是不是我发的」全靠它）。 */
    client?: string;
    name?: string;
}

export type SaveDraftResult =
    | { ok: true; status: 'saved'; historyId: number; nextDraft: Draft }
    | { ok: true; status: 'duplicate'; historyId: number; currentDraft: Draft | null }
    | { ok: false; kind: 'stale' }
    | { ok: false; kind: 'error'; message: string };

export async function getDraft(): Promise<DraftSnapshot> {
    const response = await axios.get('draft');
    return response.data as DraftSnapshot;
}

export async function putDraft({ id, revision, content }: PutDraftOptions): Promise<PutDraftResult> {
    try {
        const response = await axios.put('draft', {
            // ⚠️ undefined（不是 null）：null 会被 JSON 序列化成字面量 null，
            // 服务端 `typeof body.id === 'string'` 固然会挡掉，但「没带」才是契约形状。
            id: id ?? undefined,
            revision: revision ?? undefined,
            content,
        });
        return { ok: true, draft: response.data.draft as Draft };
    } catch (error) {
        const status = axios.isAxiosError(error) ? error.response?.status ?? 0 : 0;
        const data = axios.isAxiosError(error) ? error.response?.data as Record<string, unknown> | undefined : undefined;
        // 409 且带服务端当前草稿 → 冲突分支（引擎拿它对账 / 弹冲突横幅）。
        // ⚠️ 后端 409 有**两种形状**：乐观锁冲突是手写的 `{ error:'conflict', draft }`，
        // 归档竞态窗口走 errorResponse（`{ code:'conflict', … }`，**没有** draft 字段）。
        // 判据只认「有合法 draft」—— 没有草稿可对账的 409 当普通错误走，
        // 引擎的离线重试会先 GET 对账再补发，自愈。
        if (status === 409 && data && typeof data.draft === 'object' && data.draft !== null) {
            const conflictDraft = data.draft as Draft;
            if (typeof conflictDraft.id === 'string' && typeof conflictDraft.revision === 'number') {
                return { ok: false, kind: 'conflict', draft: conflictDraft };
            }
        }
        return { ok: false, kind: 'error', message: errorMessage(error) };
    }
}

export async function saveDraft({ draftId, content, client = getClientId(), name }: SaveDraftOptions): Promise<SaveDraftResult> {
    try {
        const response = await axios.post('save', {
            draftId,
            content,
            client,
            name,
        });
        const data = response.data as Record<string, unknown>;
        if (data.status === 'duplicate') {
            return {
                ok: true,
                status: 'duplicate',
                historyId: Number(data.historyId) || 0,
                currentDraft: (data.currentDraft as Draft | null) ?? null,
            };
        }
        return {
            ok: true,
            status: 'saved',
            historyId: Number(data.historyId) || 0,
            nextDraft: data.nextDraft as Draft,
        };
    } catch (error) {
        const status = axios.isAxiosError(error) ? error.response?.status ?? 0 : 0;
        if (status === 409) {
            return { ok: false, kind: 'stale' };
        }
        return { ok: false, kind: 'error', message: errorMessage(error) };
    }
}
