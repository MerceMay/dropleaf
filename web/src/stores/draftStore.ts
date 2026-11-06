/**
 * 草稿同步引擎 —— DropLeaf 单人剪贴板的核心状态机（契约 7 条规则的唯一实现处）。
 *
 * 结构：一个纯逻辑引擎类（可单测，定时器注入）+ zustand 壳（React 订阅面）。
 * 引擎直接写 `appStore.send.text`（编辑器的受控值），并通过本 store 发布
 * status / conflict / saveInFlight 供 UI（保存按钮、冲突横幅）订阅。
 *
 * 7 条规则（PASTE-FRONTEND-CONTRACT.md「客户端同步引擎规则」）的落点：
 *   1. 输入停顿 500ms → PUT（onInput → scheduleFlush）
 *   2. 自回声识别 → applyServerDraft 的 echo 指纹分支
 *   3. 迟到帧守卫 → applyServerDraft 的 revision 守卫
 *   4. 未同步输入 + 他机草稿 → setConflict（编辑器内容不动）
 *   5. 保存快照语义 + typed-during-save 保字 → clickSave
 *   6. 离线对账 → reconcile（由 WS 断开 / flush 失败触发）
 *   7. 冷启动 GET /draft → start（无草稿时载最近历史第一条）
 */
import { create } from 'zustand';
import axios from 'axios';
import i18n from '@/i18n';
import { getDraft, putDraft, saveDraft, type Draft } from '@/services/draft';
import { useAppStore } from '@/stores/appStore';
import { toast } from '@/stores/toastStore';

export type DraftStatus = 'boot' | 'synced' | 'syncing' | 'offline' | 'conflict';

export interface ConflictInfo {
    /** 本机编辑器里的值（用户没丢的输入）。 */
    local: string;
    /** 服务器当前草稿。 */
    remote: Draft;
    /** remote-save = 他机保存归档换了草稿行；remote-update = 同行更新。 */
    reason: 'remote-save' | 'remote-update';
}

interface DraftState {
    status: DraftStatus;
    conflict: ConflictInfo | null;
    saveInFlight: boolean;
    resolveConflict: (keepLocal: boolean) => void;
}

export const useDraftStore = create<DraftState>(() => ({
    status: 'boot',
    conflict: null,
    saveInFlight: false,
    resolveConflict: (keepLocal: boolean) => engine.resolveConflict(keepLocal),
}));

const DEBOUNCE_MS = 500;
const RETRY_MS = 3000;
/** 已归档草稿的迟到广播最多记多少条 —— 防止长期运行的 tab 无限涨内存。 */
const ARCHIVED_IDS_MAX = 64;



class DraftEngine {
    /** 服务端视角的草稿基线；null = 服务器无草稿行（或还没对过账）。 */
    private draft: Draft | null = null;
    private content = '';
    private syncedContent = '';
    /** 冷启动后本机是否有过输入 —— 区分「服务器有旧内容」与「真冲突」。 */
    private hasLocalEdits = false;
    /** 每次引擎改编辑器内容时 +1（受控组件值回写 appStore）。 */
    private contentVersion = 0;
    /** 最近一次成功 PUT 的 (id, baseRevision, content) —— 自回声指纹。 */
    private lastPutEcho: { id: string | null; baseRevision: number | null; content: string } | null = null;
    private putInFlight: { id: string | null; baseRevision: number | null; content: string } | null = null;
    private deferredFrames: Draft[] = [];
    private archivedIds = new Set<string>();
    private saveInFlight = false;
    private saveGen = 0;
    private status: DraftStatus = 'boot';
    private conflict: ConflictInfo | null = null;
    private flushTimer: number | undefined;
    private retryTimer: number | undefined;
    /** 会话守卫：resync 补拉的迟到结果不得写回（wsStore 注册）。 */
    private sessionGuard: (() => boolean) | null = null;
    private started = false;

    // ---------- 对外 API ----------

    /** 冷启动：恢复服务器草稿；无草稿则载最近历史第一条（规则 7）。幂等。 */
    async start(): Promise<void> {
        if (this.started) return;
        this.started = true;
        await this.reconcile();
        // 规则 7 后半：无草稿行 → 载最近保存的文字做**显示基线**
        // （不标 hasLocalEdits：用户一输入才走正常同步；他机草稿帧来了直接采用）。
        if (!this.draft && this.content === '') {
            const latest = await this.fetchLatestText();
            if (latest !== null) {
                this.syncedContent = latest;
                this.hasLocalEdits = false;
                this.pushToEditor(latest);
            }
        }
        this.setStatus(this.contentPending ? 'syncing' : 'synced');
        this.publish();
    }

    /**
     * 会话被确认失效（回登录页）时暂停：清防抖/重试定时器，**内容与基线全保留**。
     * 重新登录后 start() 可再进（started 已复位）—— 未同步的输入走对账/冲突流程，不丢。
     */
    stop(): void {
        clearTimeout(this.flushTimer);
        clearTimeout(this.retryTimer);
        this.flushTimer = undefined;
        this.retryTimer = undefined;
        this.started = false;
    }

    /** 用户输入：只记内容，短防抖后同步（规则 1）。冲突期间不动（等用户选）。 */
    onInput(content: string): void {
        this.content = content;
        this.hasLocalEdits = true;
        if (this.conflict !== null) return;
        this.scheduleFlush(DEBOUNCE_MS);
    }

    /** 保存归档：以点击瞬间的完整快照为准（规则 5）。 */
    async clickSave(): Promise<void> {
        if (this.saveInFlight || this.conflict !== null) return;
        const snapshot = this.content;
        if (snapshot === '') return; // 空草稿无可归档（双击/误点）

        this.saveInFlight = true;
        this.saveGen += 1;
        const gen = this.saveGen;
        this.setStatus('syncing');
        this.publish();

        // 5a. 编辑器 ≠ 基线（或基线还没有服务器草稿行）：先落盘拿 draftId（即使防抖未触发）
        const flushed = await this.flushNow('save');
        if (gen !== this.saveGen) return; // 被更新的操作取代
        if (this.conflict !== null) {
            // flush 撞上他机并发更新：横幅已弹出，等用户选择后再保存
            this.saveInFlight = false;
            this.publish();
            return;
        }
        const draftId = flushed?.id;
        if (!draftId) {
            this.saveInFlight = false;
            this.publish();
            toast(i18n.t('draftSaveNoSync'));
            this.setStatus('offline');
            this.publish();
            return;
        }

        // 5b. POST /save，content 用点击瞬间的完整快照
        const result = await saveDraft({ draftId, content: snapshot });

        if (gen !== this.saveGen) return; // 被更新的操作取代（入口有 saveInFlight 门禁，防御性）
        this.saveInFlight = false;
        this.publish();

        if (!result.ok) {
            if (result.kind === 'stale') {
                await this.reconcile();
                toast(i18n.t('draftStaleToast'));
            } else {
                this.setStatus('offline');
                toast(i18n.t('draftSaveFailedMsg', { msg: result.message }));
                this.scheduleRetry();
            }
            this.drainDeferred();
            this.publish();
            return;
        }

        this.rememberArchived(draftId);
        // 5c. 保存期间用户又输入的字符：不得被空白基线覆盖
        const typedDuringSave = this.content !== snapshot;
        // （saved 用 nextDraft；duplicate 用服务器当前草稿 —— 都把基线切到「保存后的世界」）
        if (result.status === 'saved') {
            this.applyDraftInternal(result.nextDraft, typedDuringSave);
            toast(i18n.t('draftSavedToast'));
        } else {
            if (result.currentDraft) {
                this.applyDraftInternal(result.currentDraft, typedDuringSave);
            } else {
                this.draft = null;
                this.syncedContent = '';
            }
            toast(i18n.t('draftDuplicateToast'));
        }
        this.setStatus(this.contentPending ? 'syncing' : 'synced');
        this.publish();
        this.drainDeferred();
        // typed-during-save 的输入走正常防抖同步
        if (this.contentPending) this.scheduleFlush(DEBOUNCE_MS);
    }

    /** 冲突横幅的两个按钮（规则 4）。 */
    async resolveConflict(keepLocal: boolean): Promise<void> {
        const c = this.conflict;
        if (c === null) return;
        this.conflict = null;
        if (keepLocal) {
            // 保留我的输入：服务器草稿做基线，内容立刻补发
            this.applyDraftInternal(c.remote, true);
            this.setStatus('syncing');
            this.publish();
            this.scheduleFlush(0);
            return;
        }
        // 采用服务器版本
        this.applyDraftInternal(c.remote, false);
        this.setStatus('synced');
        this.publish();
    }

    /** WS 上线（或重连）：先对账再补发（规则 6）。 */
    async onOnline(): Promise<void> {
        clearTimeout(this.retryTimer);
        this.retryTimer = undefined;
        await this.reconcile();
        if (this.contentPending && this.conflict === null) this.scheduleFlush(0);
        this.publish();
    }

    /**
     * 服务器通知「可能错过了实时事件」（第四轮复审 P2）：DO 在纪元故障期间
     * 跳过过广播，恢复后补一条 `resync`。对账逻辑与重连完全相同 ——
     * `reconcile()` 幂等：以服务器当前草稿为准，本机未同步输入照常保留。
     */
    async onServerResync(): Promise<{ ok: boolean; retryable: boolean }> {
        // 结果给 wsStore 的重试调度：ok = 成功；retryable = 失败是否值得再试
        // （网络错误 / 429 / 5xx）。草稿与历史在调度器里**分别**判断。
        const result = await this.reconcile();
        if (result.ok && this.contentPending && this.conflict === null) this.scheduleFlush(0);
        this.publish();
        return result;
    }

    /**
     * 会话守卫（最终收尾）：resync 补拉的迟到结果不得写回。
     * wsStore 注册一个「当前会话是否仍然有效」的判据；reconcile 在**拿到服务器
     * 响应之后、写入本地状态之前**检查它 —— 退出/换会话期间返回的草稿直接丢弃。
     */
    setSessionGuard(guard: (() => boolean) | null): void {
        this.sessionGuard = guard;
    }

    onOffline(): void {
        if (this.conflict === null && this.status !== 'boot') this.setStatus('offline');
        this.publish();
        this.scheduleRetry();
    }

    /** WS draft 帧（含自己 PUT 的回声，规则 2/3/4/5e）。 */
    applyRemoteDraft(remote: unknown): void {
        const d = remote as Partial<Draft> | null;
        if (!d || typeof d.id !== 'string' || typeof d.revision !== 'number' || typeof d.content !== 'string') {
            return;
        }
        if (this.saveInFlight) {
            this.deferredFrames.push(d as Draft); // 规则 5e：保存完成后按规则处理
            return;
        }
        this.applyServerDraft(d as Draft);
        this.publish();
    }

    // ---------- 内部 ----------

    private get contentPending(): boolean {
        return this.content !== this.syncedContent;
    }

    private setStatus(next: DraftStatus): void {
        this.status = next;
        useDraftStore.setState({ status: next });
    }

    private publish(): void {
        useDraftStore.setState({ status: this.status, conflict: this.conflict, saveInFlight: this.saveInFlight });
    }

    /** 引擎改编辑器内容（区别于用户输入）：回写 appStore 并计数。 */
    private pushToEditor(content: string): void {
        this.content = content;
        this.contentVersion += 1;
        useAppStore.setState({ send: { ...useAppStore.getState().send, text: content } });
    }

    /** 采用服务端草稿为基线；preserve=true 时编辑器内容不动（typed-during-save / 保留输入）。 */
    private applyDraftInternal(draft: Draft, preserveContent: boolean): void {
        this.draft = draft;
        this.syncedContent = draft.content;
        if (preserveContent) return;
        this.hasLocalEdits = false;
        this.pushToEditor(draft.content);
    }

    /**
     * 一台服务器草稿进到本机的总闸（WS 帧 / PUT 409 / GET 对账共用）。
     */
    private applyServerDraft(draft: Draft): void {
        // 自己刚保存归档的旧草稿行：迟到广播，忽略
        if (this.archivedIds.has(draft.id)) return;
        // 规则 3：迟到帧守卫 —— 同 id 且 revision 不超前于本地基线 → 丢弃
        const known = this.draft;
        if (known !== null && draft.id === known.id && draft.revision <= known.revision) return;

        // 规则 2：自回声识别 —— 本机刚 PUT 成功的 (id, revision, content) 与帧一致 → 只更新基线
        const echo = this.putInFlight ?? this.lastPutEcho;
        if (
            echo !== null
            && (echo.id === null || echo.id === draft.id)
            && draft.revision === (echo.baseRevision ?? 0) + 1
            && draft.content === echo.content
        ) {
            this.draft = draft;
            this.syncedContent = draft.content;
            return;
        }

        // 冷启动（本机无基线、无本地输入）→ 直接采用
        const coldStart = known === null && this.syncedContent === '' && !this.hasLocalEdits;
        if (this.contentPending && !coldStart) {
            // 规则 4：本机有未同步输入 → 冲突横幅，编辑器内容不动
            this.conflict = {
                local: this.content,
                remote: draft,
                reason: known !== null && draft.id !== known.id ? 'remote-save' : 'remote-update',
            };
            this.setStatus('conflict');
            return;
        }

        this.applyDraftInternal(draft, false);
        this.setStatus('synced');
    }

    /** GET /draft 对账（规则 6）。 */
    private async reconcile(): Promise<{ ok: boolean; retryable: boolean }> {
        try {
            const snapshot = await getDraft();
            // ⚠️ 会话守卫：退出/切换会话后返回的结果不得写回（迟到结果）。
            if (this.sessionGuard && !this.sessionGuard()) {
                return { ok: false, retryable: false };
            }
            if (snapshot.exists && snapshot.draft) {
                this.applyServerDraft(snapshot.draft);
            } else if (this.contentPending) {
                // 服务器无草稿行但本机有未同步输入：按新草稿补发，不判冲突
                this.draft = null;
                this.setStatus('syncing');
                this.scheduleFlush(0);
                return { ok: true, retryable: false };
            } else {
                // 服务器无草稿行、本机也没有未同步输入：清基线行引用即可
                // （syncedContent 保留为显示基线，下一次输入的 PUT 是无条件写，自会建行）。
                this.draft = null;
            }
            if (this.status !== 'conflict') {
                this.setStatus(this.contentPending ? 'syncing' : 'synced');
            }
            return { ok: true, retryable: false };
        } catch (error) {
            this.setStatus('offline');
            // 429 / 5xx / 网络错误（无 response）才值得重试；其余 4xx 是确定性失败。
            const status = (error as { response?: { status?: number } })?.response?.status ?? 0;
            const retryable = !status || status === 429 || status >= 500;
            // 不抛：其它调用方（start / onOnline / scheduleRetry / 保存流程）都不需要
            // 处理异常，返回值已经足够表达结果。
            return { ok: false, retryable };
        }
    }

    /** 冷启动无草稿时载最近历史第一条文字（规则 7 的兜底：草稿优先，其次最近保存的文字）。 */
    private async fetchLatestText(): Promise<string | null> {
        try {
            // 与 loadHistoryFromHttp 同一条接口（`?room=` 空串 = default 房间）；
            // `/content/latest` 的响应形状随 Accept 协商变化，这里要的是「列表第一条」。
            const response = await axios.get('content', { params: new URLSearchParams([['room', '']]) });
            const messages = Array.isArray(response.data?.messages) ? response.data.messages as Array<{ type?: unknown; content?: unknown }> : [];
            const latest = messages[0];
            if (latest && latest.type === 'text' && typeof latest.content === 'string' && latest.content) {
                return latest.content;
            }
            return null;
        } catch {
            return null;
        }
    }

    private scheduleFlush(ms: number): void {
        clearTimeout(this.flushTimer);
        if (this.status === 'synced') this.setStatus('syncing');
        this.publish();
        this.flushTimer = setTimeout(() => {
            this.flushTimer = undefined;
            void this.flushNow().then(() => {
                if (this.contentPending) this.scheduleFlush(DEBOUNCE_MS);
                else this.publish();
            });
        }, ms);
    }

    private scheduleRetry(): void {
        if (this.retryTimer !== undefined) return;
        this.retryTimer = setTimeout(() => {
            this.retryTimer = undefined;
            void this.reconcile().then(() => {
                if (this.contentPending && this.conflict === null) this.scheduleFlush(0);
                this.publish();
            });
        }, RETRY_MS);
    }

    /**
     * 立即 PUT。ctx='save'：保存流程自己调（不受 saveInFlight 门禁）；
     * ctx='debounce'：防抖触发（保存期间让位）。
     */
    private async flushNow(ctx: 'debounce' | 'save' = 'debounce'): Promise<Draft | null> {
        // 规则 5a 的另一半：基线没有服务器草稿行（冷启动从历史恢复的显示值）时，
        // 保存前也要先无条件写一条草稿行出来。
        const needsRow = ctx === 'save' && this.draft === null && this.content !== '';
        if (this.conflict !== null || (!this.contentPending && !needsRow)) return this.draft;
        if (ctx === 'debounce' && this.saveInFlight) return this.draft;
        const content = this.content;
        const id = this.draft?.id ?? null;
        const baseRevision = this.draft?.revision ?? null;
        this.putInFlight = { id, baseRevision, content };
        const saveGen = this.saveGen;
        const result = await putDraft({ id, revision: baseRevision, content });
        if (ctx === 'debounce' && (saveGen !== this.saveGen || this.saveInFlight)) {
            this.putInFlight = null; // 保存已接管：丢弃旧响应
            return this.draft;
        }
        this.putInFlight = null;
        if (result.ok) {
            this.draft = result.draft;
            this.syncedContent = result.draft.content;
            this.lastPutEcho = { id, baseRevision, content };
            if (this.content === result.draft.content) this.setStatus('synced');
            this.publish();
            return this.draft;
        }
        if (result.kind === 'conflict') {
            this.applyServerDraft(result.draft);
            this.publish();
            return this.draft;
        }
        this.setStatus('offline');
        this.publish();
        this.scheduleRetry();
        return null;
    }

    private drainDeferred(): void {
        const frames = this.deferredFrames;
        this.deferredFrames = [];
        for (const frame of frames) {
            this.applyServerDraft(frame);
        }
    }

    private rememberArchived(id: string): void {
        this.archivedIds.add(id);
        if (this.archivedIds.size > ARCHIVED_IDS_MAX) {
            const oldest = this.archivedIds.values().next().value;
            if (oldest !== undefined) this.archivedIds.delete(oldest);
        }
    }
}

export const engine = new DraftEngine();
