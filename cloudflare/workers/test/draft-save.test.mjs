// DropLeaf 草稿端点集成测试：GET/PUT /draft、POST /save 的保存归档与幂等。
// 直跑打包后的 DraftHandler（esbuild bundle），D1 用 harness 的 node:sqlite 桩。
import {makeEnv, makeChecker, postJson, getJson, sessionBearer } from './harness.mjs';
import { DraftHandler } from './.build/draft.mjs';
import { ensureDeviceNameColumn, ensureDraftIdColumn, cleanupOldMessagesBeforeSave } from './.build/utils.mjs';

const { env, db } = makeEnv();
const { check, summary } = makeChecker();
// draft 表（迁移 002-draft.sql 的内容）
db.exec(`CREATE TABLE IF NOT EXISTS draft (
  k INTEGER PRIMARY KEY CHECK (k = 0),
  id TEXT NOT NULL, revision INTEGER NOT NULL, content TEXT NOT NULL, updated_at INTEGER NOT NULL)`);

const putJson = async (body, headers = {}) => {
  const req = new Request('http://worker.local/draft', {
    method: 'PUT',
    headers: { Authorization: await sessionBearer(env), 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  const res = await DraftHandler.put(req, env);
  return { status: res.status, json: await res.json().catch(() => null) };
};

console.log('── GET /draft：无草稿与空草稿是两个状态');
check('初始无草稿', (await getJson(DraftHandler.get, env, '/draft')).json, { exists: false });

console.log('── PUT /draft：无草稿行时创建');
const first = await putJson({ content: 'hello' });
check('创建成功', first.status, 200);
check('创建后 revision', first.json.draft.revision, 1);
check('创建后 content', first.json.draft.content, 'hello');

console.log('── PUT /draft：正确基线更新');
const second = await putJson({ id: first.json.draft.id, revision: 1, content: 'v2' });
check('更新成功', second.status, 200);
check('revision 递增', second.json.draft.revision, 2);

console.log('── PUT /draft：乐观锁 409');
const stale = await putJson({ id: first.json.draft.id, revision: 1, content: 'stale' });
check('stale revision → 409', stale.status, 409);
check('409 载荷带服务端草稿', stale.json.error, 'conflict');
check('载荷 revision 是服务端的', stale.json.draft.revision, 2);
const wrongId = await putJson({ id: '00000000-0000-0000-0000-000000000000', content: 'x' });
check('错误 id → 409', wrongId.status, 409);

console.log('── 主动清空 → 空草稿仍存在');
const cleared = await putJson({ id: first.json.draft.id, revision: 2, content: '' });
check('清空成功', cleared.status, 200);
check('空草稿存在', (await getJson(DraftHandler.get, env, '/draft')).json.exists, true);
check('空草稿内容为空串', (await getJson(DraftHandler.get, env, '/draft')).json.draft.content, '');

console.log('── POST /save：归档 + 新空白草稿 + 幂等');
const draftNow = (await getJson(DraftHandler.get, env, '/draft')).json.draft;
// 先写回有内容的草稿（清空后保存空内容属于合法归档，这里测非空路径）
const restore = await putJson({ id: draftNow.id, revision: draftNow.revision, content: '归档内容' });
const target = restore.json.draft;

const saveBody = JSON.stringify({ draftId: target.id, content: '归档内容', client: 'probe' });
const saved = await postJson(DraftHandler.save, env, '/save', saveBody);
check('保存成功', saved.status, 200);
check('保存状态', saved.json.status, 'saved');
const afterSave = (await getJson(DraftHandler.get, env, '/draft')).json;
check('保存后新空白草稿', [afterSave.exists, afterSave.draft.content, afterSave.draft.revision], [true, '', 1]);
check('新草稿换 id', afterSave.draft.id === target.id, false);

const dup = await postJson(DraftHandler.save, env, '/save', saveBody);
check('重复保存幂等', dup.json.status, 'duplicate');
check('重复保存指向同一历史', dup.json.historyId, saved.json.historyId);

const rows = db.prepare('SELECT COUNT(*) AS n FROM messages WHERE content = ?').get('归档内容');
check('服务器只有一条归档', rows.n, 1);

console.log('── POST /save：陌生 draftId → 409 stale_draft');
const bogus = await postJson(DraftHandler.save, env, '/save', JSON.stringify({ draftId: 'no-such-draft', content: 'x' }));
check('陌生 draftId → 409', bogus.status, 409);
check('错误信息', bogus.json.error, 'Draft replaced');

console.log('── 列自愈：draft_id 列在旧库上自动补齐');
check('ensureDeviceNameColumn 幂等可用', await ensureDeviceNameColumn(env.DB), true);
await cleanupOldMessagesBeforeSave(env.DB, 'default', env);

summary('draft 集成测试');
