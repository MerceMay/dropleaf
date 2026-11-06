import { corsHeaders } from '../cors';
import { ensureRoomAccess } from '../auth';
import { broadcastMessage, cleanupOldMessagesBeforeSave, ensureDeviceNameColumn } from '../utils';
import { errorResponse } from '../errors';

/**
 * 草稿端点：单人剪贴板的「当前草稿」。
 *
 * 语义（与最终产品实测过的上一版 DropLeaf 一致）：
 *   · GET  /draft        → { exists: false } 或 { exists: true, draft }
 *     「无行」和「content='' 的行」是两个状态（用户主动清空 ≠ 从没写过）。
 *   · PUT  /draft        → 乐观锁：请求带 { id, revision, content }。
 *     id 不匹配（草稿已被保存归档替换）或 revision 落后 → 409 + 服务端当前草稿。
 *     无草稿行时创建（revision 从 1 开始）。
 *   · POST /save         → 归档：以 { draftId, content } 原子批次
 *     INSERT history(messages) + DELETE draft(旧 id) + INSERT draft(新空白)。
 *     同一 draftId 重复保存 → 幂等返回 duplicate（不再归档）。
 *
 * 广播：草稿每次落库都推 WS { event: 'draft', data }，
 * 客户端靠「自己 PUT 的指纹比对」识别回声、靠 revision 守卫丢迟到帧。
 */

const MAX_DRAFT_CHARS = 200000;

// ── 懒建表（与上游 deviceName/boardColumn 列同一套自愈策略）──────────────────
// 本地 dev 的 wrangler 会随配置指纹换 D1 持久化文件，d1 execute 建的表不一定在
// worker 眼里；线上部署跑 d1/schema.sql + 002-draft.sql。两边幂等，谁先到都能用。
const draftSchemaReady = new WeakMap();

async function ensureDraftSchema(db) {
  if (draftSchemaReady.has(db)) return draftSchemaReady.get(db);
  let ready = true;
  try {
    await db
      .prepare(`CREATE TABLE IF NOT EXISTS draft (
        k INTEGER PRIMARY KEY CHECK (k = 0),
        id TEXT NOT NULL, revision INTEGER NOT NULL, content TEXT NOT NULL, updated_at INTEGER NOT NULL)`)
      .run();
  } catch (error) {
    ready = false;
    console.error('draft 表不可用:', error);
  }
  if (ready) {
    try {
      await db.prepare('ALTER TABLE messages ADD COLUMN draft_id TEXT').run();
    } catch (error) {
      ready = /duplicate column/i.test(String(error?.message));
    }
    try {
      await db.prepare('CREATE INDEX IF NOT EXISTS idx_messages_draft_id ON messages(draft_id)').run();
    } catch { /* 索引失败只影响幂等查询性能 */ }
  }
  draftSchemaReady.set(db, ready);
  return ready;
}

function rowToDraft(row) {
  return { id: row.id, revision: row.revision, content: row.content, updatedAt: row.updated_at };
}

async function readDraftRow(db) {
  return db
    .prepare('SELECT id, revision, content, updated_at FROM draft WHERE k = 0')
    .first();
}

async function readDraftByArchivedId(db, draftId) {
  // 保存幂等：按归档时的草稿 id 查历史（messages 表 id 为 INTEGER，
  // 用 draft_id 关联需要在 messages 上留痕 —— 见 /save 的写入）
  return db
    .prepare('SELECT id FROM messages WHERE draft_id = ? LIMIT 1')
    .bind(draftId)
    .first();
}

export class DraftHandler {
  static async get(request, env) {
    const authResult = await ensureRoomAccess(request, env, 'default');
    if (!authResult.ok) return authResult.response;
    if (!(await ensureDraftSchema(env.DB))) {
      return errorResponse(503, 'database_unavailable', 'Database not available', '数据库服务不可用');
    }
    const row = await readDraftRow(env.DB);
    if (!row) {
      return new Response(JSON.stringify({ exists: false }), {
        headers: { 'Content-Type': 'application/json', ...corsHeaders },
      });
    }
    return new Response(JSON.stringify({ exists: true, draft: rowToDraft(row) }), {
      headers: { 'Content-Type': 'application/json', ...corsHeaders },
    });
  }

  static async put(request, env) {
    const authResult = await ensureRoomAccess(request, env, 'default');
    if (!authResult.ok) return authResult.response;
    if (!(await ensureDraftSchema(env.DB))) {
      return errorResponse(503, 'database_unavailable', 'Database not available', '数据库服务不可用');
    }

    let body;
    try {
      body = await request.json();
    } catch {
      return errorResponse(400, 'invalid_body', 'Cannot parse request body', '请求体无法解析');
    }
    const content = typeof body.content === 'string' ? body.content : '';
    const id = typeof body.id === 'string' ? body.id : null;
    const revision = typeof body.revision === 'number' ? body.revision : null;

    if (content.length > MAX_DRAFT_CHARS) {
      return errorResponse(413, 'draft_too_long', 'Draft too long', `草稿超过上限 ${MAX_DRAFT_CHARS} 字`);
    }

    const row = await readDraftRow(env.DB);
    if (!row) {
      const draft = {
        id: crypto.randomUUID(),
        revision: 1,
        content,
        updatedAt: Date.now(),
      };
      await env.DB
        .prepare('INSERT INTO draft (k, id, revision, content, updated_at) VALUES (0, ?, ?, ?, ?)')
        .bind(draft.id, draft.revision, draft.content, draft.updatedAt)
        .run();
      await broadcastMessage(env, 'default', { event: 'draft', data: { ...draft } });
      return new Response(JSON.stringify({ draft }), {
        headers: { 'Content-Type': 'application/json', ...corsHeaders },
      });
    }

    const idMatches = id === null || id === row.id;
    const revMatches = revision === null || revision === row.revision;
    if (!idMatches || !revMatches) {
      // 409 载荷带服务端当前草稿：客户端进冲突流程或对账
      return new Response(
        JSON.stringify({ error: 'conflict', draft: rowToDraft(row) }),
        { status: 409, headers: { 'Content-Type': 'application/json', ...corsHeaders } },
      );
    }

    const result = await env.DB
      .prepare(
        'UPDATE draft SET revision = revision + 1, content = ?, updated_at = ? WHERE k = 0 AND id = ? AND revision = ?',
      )
      .bind(content, Date.now(), row.id, row.revision)
      .run();
    if (result.meta.changes !== 1) {
      // 并发窗口竞态：重读后按冲突返回
      const fresh = await readDraftRow(env.DB);
      if (!fresh) {
        return errorResponse(409, 'conflict', 'Draft archived', '草稿已被归档');
      }
      return new Response(
        JSON.stringify({ error: 'conflict', draft: rowToDraft(fresh) }),
        { status: 409, headers: { 'Content-Type': 'application/json', ...corsHeaders } },
      );
    }

    const updated = await readDraftRow(env.DB);
    await broadcastMessage(env, 'default', { event: 'draft', data: rowToDraft(updated) });
    return new Response(JSON.stringify({ draft: rowToDraft(updated) }), {
      headers: { 'Content-Type': 'application/json', ...corsHeaders },
    });
  }

  /**
   * 保存归档：draftId 必须匹配当前草稿（点击保存前客户端先 flush 草稿拿到 id）。
   * 归档 = 单个 D1 batch：历史入 messages（带 draft_id 痕迹）+ 旧草稿删除 + 新空白草稿。
   */
  static async save(request, env) {
    const authResult = await ensureRoomAccess(request, env, 'default');
    if (!authResult.ok) return authResult.response;
    if (!(await ensureDraftSchema(env.DB))) {
      return errorResponse(503, 'database_unavailable', 'Database not available', '数据库服务不可用');
    }

    let body;
    try {
      body = await request.json();
    } catch {
      return errorResponse(400, 'invalid_body', 'Cannot parse request body', '请求体无法解析');
    }
    const draftId = typeof body.draftId === 'string' ? body.draftId : '';
    const content = typeof body.content === 'string' ? body.content : '';
    const textLimit = env.TEXT_LIMIT ? parseInt(env.TEXT_LIMIT) : 40960;
    if (content.length > textLimit) {
      return errorResponse(413, 'text_too_long', 'Text too long', `文本长度超出限制 (最大 ${textLimit} 字符)`);
    }
    if (!draftId) {
      return errorResponse(400, 'missing_draft_id', 'draftId required', '缺少 draftId');
    }

    const row = await readDraftRow(env.DB);
    if (!row || row.id !== draftId) {
      // 目标草稿已被归档（或不存在）：按 draft_id 查历史实现幂等
      const existing = await readDraftByArchivedId(env.DB, draftId);
      if (existing) {
        const current = await readDraftRow(env.DB);
        return new Response(
          JSON.stringify({
            status: 'duplicate',
            historyId: existing.id,
            currentDraft: current ? rowToDraft(current) : null,
          }),
          { headers: { 'Content-Type': 'application/json', ...corsHeaders } },
        );
      }
      return errorResponse(409, 'stale_draft', 'Draft replaced', '草稿已被替换，请同步后再保存');
    }

    // 列自愈（幂等 ALTER，结果缓存）——必须在 batch 之前，让归档插入与草稿翻转同批原子完成。
    // 中途崩溃不再出现「历史已插入、草稿还在」的双重归档窗口。
    const deviceOk = await ensureDeviceNameColumn(env.DB);
    await cleanupOldMessagesBeforeSave(env.DB, 'default', env);

    const insertColumns = ['type', 'content', 'name', 'size', 'room', 'timestamp', 'senderIP', 'senderClientID', 'userAgent'];
    const insertValues = [
      'text',
      content,
      null,
      null,
      'default',
      Math.floor(Date.now() / 1000),
      request.headers.get('CF-Connecting-IP') || 'unknown',
      String(body.client || '').trim(),
      request.headers.get('User-Agent') || 'unknown',
    ];
    if (deviceOk) {
      insertColumns.push('deviceName');
      insertValues.push(String(body.name || ''));
    }
    insertColumns.push('draft_id');
    insertValues.push(draftId);

    const newDraftId = crypto.randomUUID();
    const batchResults = await env.DB.batch([
      env.DB
        .prepare(`INSERT INTO messages (${insertColumns.join(', ')}) VALUES (${insertColumns.map(() => '?').join(', ')})`)
        .bind(...insertValues),
      env.DB.prepare('DELETE FROM draft WHERE k = 0 AND id = ?').bind(draftId),
      env.DB
        .prepare("INSERT INTO draft (k, id, revision, content, updated_at) VALUES (0, ?, 1, '', ?)")
        .bind(newDraftId, Date.now()),
    ]);
    const historyId = batchResults[0].meta.last_row_id;

    // 广播：新空白草稿 + 新历史条目（前端 WS 事件驱动刷新时间线）
    await broadcastMessage(env, 'default', {
      event: 'draft',
      data: { id: newDraftId, revision: 1, content: '', updatedAt: Date.now() },
    });
    await broadcastMessage(env, 'default', { event: 'history-appended', data: { id: historyId } });

    return new Response(
      JSON.stringify({ status: 'saved', historyId, nextDraft: { id: newDraftId, revision: 1, content: '' } }),
      { headers: { 'Content-Type': 'application/json', ...corsHeaders } },
    );
  }
}
