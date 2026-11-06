// D1 故障时**不能**把「读不到纪元」当成纪元 0（第三轮复审 P1）。
//
// 复审的复现：签发 ver=0 的令牌 → 退出把纪元推到 1（旧令牌被拒）→ 只让
// `SELECT value FROM app_state` 抛错 → 旧令牌重新通过鉴权，旧 WS 也收到新草稿。
// 根因：catch 里 `env.__sessionEpoch = 0`，而 0 恰好是「从未退出过」的合法值。
//
// 修法（三态）：
//   · ok          —— 有效；
//   · stale       —— 确定失效（签名/exp/房间/纪元不符）；
//   · epoch_unavailable —— **判不了**，由调用方处置：
//       HTTP 业务接口 → 503（保留令牌、可重试），不是 401（不踢人）；
//       WS 广播       → 本次不投递、连接保留；读库恢复后下一轮自然重新验证。
import { WebSocketRoom } from './.build/websocket-room.mjs';
import {
  issueRoomSessionToken,
  bumpSessionEpoch,
  getSessionEpoch,
  validateRoomSessionToken,
  SESSION_OK,
  SESSION_STALE,
  EPOCH_UNAVAILABLE,
} from './.build/auth.mjs';
import worker from './.build/index.mjs';
import { makeEnv, makeChecker } from './harness.mjs';

const { check, summary } = makeChecker();

/**
 * 故障注入：只让「读 app_state 的 SELECT」失败（可选：让 auth_attempts 相关
 * 语句也失败）。其余 SQL 正常 —— 这样才能证明症状只由纪元读取引起。
 */
function injectDbFaults(env) {
  const original = env.DB;
  env.__faults = { epochSelect: false, authAttempts: false };
  env.DB = {
    prepare(sql) {
      if (env.__faults.epochSelect && /^\s*SELECT\s+value\s+FROM\s+app_state/i.test(sql)) {
        throw new Error('injected D1 failure: app_state select');
      }
      if (env.__faults.authAttempts && /auth_attempts/i.test(sql)) {
        throw new Error('injected D1 failure: auth_attempts');
      }
      return original.prepare(sql);
    },
    batch: original.batch.bind(original),
  };
  return env;
}

function freshEnv(base) {
  const e = { ...base };
  delete e.__sessionEpoch;
  delete e.__sessionEpochAt;
  return e;
}

async function getDraft(env, token) {
  return worker.fetch(
    new Request('http://worker.local/draft', {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    }),
    env,
    {},
  );
}

function makeRoom(env) {
  const room = Object.create(WebSocketRoom.prototype);
  room.env = env;
  room.sessions = new Map();
  room.revokingSessions = new Set();
  room.missedEvents = [];
  room.missedBroadcasts = false;
  room.maxMissedEvents = 500;
  room.state = {
    storage: {
      _alarm: null,
      async getAlarm() { return this._alarm; },
      async setAlarm(t) { this._alarm = t; },
    },
  };
  return room;
}

function addSession(room, sessionId, token) {
  const sent = [];
  const socket = {
    readyState: 1,
    send: (p) => sent.push(JSON.parse(p)),
    close: () => { socket.closed = true; socket.readyState = 3; },
  };
  room.sessions.set(sessionId, {
    webSocket: socket, sessionId, room: 'default', token,
    tokenCheckedAt: 0, connectedAt: Date.now(), lastPresenceTouchedAt: 0,
  });
  return { sent, socket };
}

console.log('\n-- A. 读纪元失败：三态是 epoch_unavailable，不是 false/0 --');
{
  const { env } = makeEnv();
  env.AUTH_PASSWORD = 'pw123';
  const staleToken = await issueRoomSessionToken(env, 'default', 3600, 'global');
  await bumpSessionEpoch(freshEnv(env));

  const healthy = freshEnv(env);
  check('正常时旧令牌 = stale', await validateRoomSessionToken(healthy, 'default', staleToken), SESSION_STALE);

  injectDbFaults(env);
  env.__faults.epochSelect = true;
  const faulty = freshEnv(env);
  check('故障时返回 epoch_unavailable', await validateRoomSessionToken(faulty, 'default', staleToken), EPOCH_UNAVAILABLE);
  let threw = false;
  try {
    await getSessionEpoch(freshEnv(env), { fresh: true });
  } catch {
    threw = true;
  }
  check('getSessionEpoch 故障时上抛（不再返回 0）', threw, true);
}

console.log('\n-- B. HTTP：故障期间 503，旧令牌**不会**复活 --');
{
  const { env } = makeEnv();
  env.AUTH_PASSWORD = 'pw123';
  const staleToken = await issueRoomSessionToken(env, 'default', 3600, 'global');
  const validToken = await issueRoomSessionToken(env, 'default', 3600, 'global');
  await bumpSessionEpoch(freshEnv(env));
  const currentToken = await issueRoomSessionToken(freshEnv(env), 'default', 3600, 'global');

  injectDbFaults(env);
  env.__faults.epochSelect = true;

  // ⚠️ 每个请求拿一份新的 env（与 Worker 运行时一致）：5s 纪元缓存只活在一个
  // 请求里，这里若复用同一个 env，缓存会掩盖故障、测不到真实路径。
  const staleDuring = await getDraft(freshEnv(env), staleToken);
  check('故障期间旧令牌 → 503（不是 200）', staleDuring.status, 503);
  check('错误码 epoch_unavailable', (await staleDuring.json()).code, 'epoch_unavailable');
  check('故障期间有效令牌 → 也 503（判不了就拒，不误判为有效）', (await getDraft(freshEnv(env), currentToken)).status, 503);

  // 恢复
  env.__faults.epochSelect = false;
  check('恢复后旧令牌 → 401', (await getDraft(freshEnv(env), staleToken)).status, 401);
  check('恢复后当前令牌 → 200', (await getDraft(freshEnv(env), currentToken)).status, 200);
  check('（控制组）退出前签发的另一张令牌同样失效', (await getDraft(freshEnv(env), validToken)).status, 401);
}

console.log('\n-- C. WS：故障期间广播暂缓、连接保留；恢复后旧连接被关 --');
{
  const { env } = makeEnv();
  env.AUTH_PASSWORD = 'pw123';
  const staleToken = await issueRoomSessionToken(env, 'default', 3600, 'global');
  await bumpSessionEpoch(freshEnv(env));

  const room = makeRoom(env);
  const staleConn = addSession(room, 'stale', staleToken);

  injectDbFaults(env);
  env.__faults.epochSelect = true;

  await room.broadcast({ event: 'draft', data: { content: '故障期间' } }, 'default');
  check('故障期间不投递（旧连接收不到）', staleConn.sent.length, 0);
  check('但连接被保留（不因一次抖动踢人）', room.sessions.has('stale'), true);

  // 恢复后：同一连接在下一次广播时被复验为 stale → 关闭，且不收这条
  env.__faults.epochSelect = false;
  await room.broadcast({ event: 'draft', data: { content: '恢复后' } }, 'default');
  check('恢复后旧连接仍未收到任何草稿', staleConn.sent.length, 0);
  check('恢复后旧连接被关闭', staleConn.socket.closed, true);
  check('会话已移除', room.sessions.has('stale'), false);
}

console.log('\n-- D. 组合：撤销通知失败 + 随后纪元读取失败 --');
{
  const { env } = makeEnv();
  env.AUTH_PASSWORD = 'pw123';
  const token = await issueRoomSessionToken(env, 'default', 3600, 'global');

  // 1) 撤销通知失败（DO 500）→ logout 503
  env.WEBSOCKET_ROOM = {
    idFromName: (name) => name,
    get: () => ({ async fetch() { return new Response('boom', { status: 500 }); } }),
  };
  injectDbFaults(env);
  const logout = await worker.fetch(
    new Request('http://worker.local/auth/logout?room=default', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
    }),
    env,
    {},
  );
  check('撤销通知失败 → 503', logout.status, 503);

  // 2) 紧接着纪元读取也失败：旧令牌**读不到数据**（503 而不是 200）
  env.__faults.epochSelect = true;
  const during = await getDraft(freshEnv(env), token);
  check('纪元读取失败期间旧令牌 → 503', during.status, 503);
  check('没有返回草稿内容', (await during.json()).code, 'epoch_unavailable');

  // 3) 旧 WS 在这段时间广播：不投递
  const room = makeRoom(env);
  const conn = addSession(room, 'old', token);
  await room.broadcast({ event: 'draft', data: { content: '组合故障期间' } }, 'default');
  check('旧连接收不到广播', conn.sent.length, 0);
  check('连接保留（等恢复）', room.sessions.has('old'), true);

  // 4) 恢复：旧令牌 401，旧连接关闭且没有收到任何草稿
  env.__faults.epochSelect = false;
  check('恢复后旧令牌 401', (await getDraft(freshEnv(env), token)).status, 401);
  await room.broadcast({ event: 'draft', data: { content: '恢复后' } }, 'default');
  check('恢复后旧连接仍 0 条', conn.sent.length, 0);
  check('恢复后旧连接被关闭', conn.socket.closed, true);
}

console.log('\n-- E. 限流存储故障：503 而不是放行 --');
{
  const { env } = makeEnv();
  env.AUTH_PASSWORD = 'pw123';
  injectDbFaults(env);
  env.__faults.authAttempts = true;

  const res = await worker.fetch(
    new Request('http://worker.local/auth/token?room=default', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '7.7.7.7' },
      body: JSON.stringify({ password: 'pw123' }),
    }),
    env,
    {},
  );
  check('限流存储故障 → 503', res.status, 503);
  check('错误码 rate_limit_unavailable', (await res.json()).code, 'rate_limit_unavailable');
  check('没有签发令牌', res.headers.get('Set-Cookie'), null);

  env.__faults.authAttempts = false;
  const ok = await worker.fetch(
    new Request('http://worker.local/auth/token?room=default', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '7.7.7.7' },
      body: JSON.stringify({ password: 'pw123' }),
    }),
    env,
    {},
  );
  check('恢复后正常登录 200', ok.status, 200);
}

console.log('\n-- E2. 纪元故障时登录/续签：503（不是 500，也不是签出坏令牌） --');
{
  const { env } = makeEnv();
  env.AUTH_PASSWORD = 'pw123';
  injectDbFaults(env);
  env.__faults.epochSelect = true;

  const login = await worker.fetch(
    new Request('http://worker.local/auth/token?room=default', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '8.8.8.8' },
      body: JSON.stringify({ password: 'pw123' }),
    }),
    env,
    {},
  );
  check('登录签发失败 → 503', login.status, 503);
  check('登录错误码 epoch_unavailable', (await login.json()).code, 'epoch_unavailable');
  check('没有 Set-Cookie（没签出半成品）', login.headers.get('Set-Cookie'), null);
}

console.log('\n-- F. 查询成功但无记录 = 纪元 0（合法状态，不能被当成故障） --');
{
  const { env } = makeEnv();
  env.AUTH_PASSWORD = 'pw123';
  const token = await issueRoomSessionToken(env, 'default', 3600, 'global');
  check('从未退出过：epoch=0', await getSessionEpoch(freshEnv(env), { fresh: true }), 0);
  check('对应令牌有效', await validateRoomSessionToken(freshEnv(env), 'default', token), SESSION_OK);
}

console.log('\n-- G. P2：故障期间跳过的广播，恢复后无新编辑也会补 resync --');
{
  const { env } = makeEnv();
  env.AUTH_PASSWORD = 'pw123';
  const token = await issueRoomSessionToken(env, 'default', 3600, 'global');

  const room = makeRoom(env);
  const conn = addSession(room, 'd1', token);

  injectDbFaults(env);
  env.__faults.epochSelect = true;

  // 故障期间发生一次草稿广播（另一台设备在打字）
  const skipped = await room.broadcast({ event: 'draft', data: { content: '故障期间的草稿' } }, 'default');
  check('广播被推迟（如实返回 deferred）', skipped?.deferred, true);
  check('连接没有收到这条', conn.sent.length, 0);
  check('已标记待补送', room.missedBroadcasts, true);
  check('已安排 ~5s 后的复查 alarm', Boolean(room.state.storage._alarm), true);

  // 恢复：没有任何新编辑、没有重连 —— 只靠 alarm 复查
  env.__faults.epochSelect = false;
  room.state.storage._alarm = null;
  await room.alarm();

  const resync = conn.sent.find((m) => m.event === 'resync');
  check('恢复后收到 resync 信号', Boolean(resync), true);
  check('resync 带原因', resync?.data?.reason, 'epoch_outage_recovery');
  check('待补送标记已清', room.missedBroadcasts, false);

  // 恢复时先按序重放跳过的事件，再补 resync
  check('重放了故障期间的 draft', conn.sent.filter((m) => m.event === 'draft').length, 1);
  check('重放顺序：draft 在 resync 之前', conn.sent.map((m) => m.event), ['draft', 'resync']);
  check('重放队列已清空', room.missedEvents.length, 0);

  // resync 之后照常投递新消息
  conn.sent.length = 0;
  await room.broadcast({ event: 'draft', data: { content: '恢复后新草稿' } }, 'default');
  check('恢复后正常投递', conn.sent.map((m) => m.event), ['draft']);
}

console.log('\n-- H. 故障期间的多次跳过只补一条 resync（去重） --');
{
  const { env } = makeEnv();
  env.AUTH_PASSWORD = 'pw123';
  const token = await issueRoomSessionToken(env, 'default', 3600, 'global');
  const room = makeRoom(env);
  const conn = addSession(room, 'd1', token);

  injectDbFaults(env);
  env.__faults.epochSelect = true;
  await room.broadcast({ event: 'draft', data: { content: 'a' } }, 'default');
  await room.broadcast({ event: 'history-appended', data: null }, 'default');
  await room.broadcast({ event: 'pong', data: 1 }, 'default'); // 非内容事件：不标记
  check('多次跳过仍只标记一次', room.missedBroadcasts, true);

  env.__faults.epochSelect = false;
  await room.alarm();
  check('只补一条 resync', conn.sent.filter((m) => m.event === 'resync').length, 1);
  check('内容事件按序重放（pong 不入队）', conn.sent.filter((m) => m.event !== 'resync').map((m) => m.event), ['draft', 'history-appended']);
}

console.log('\n-- I. 必修：故障期间删一条 / 清空，恢复后 B 精确收到 --');
{
  const { env } = makeEnv();
  env.AUTH_PASSWORD = 'pw123';
  const token = await issueRoomSessionToken(env, 'default', 3600, 'global');
  const room = makeRoom(env);
  const b = addSession(room, 'b', token);

  injectDbFaults(env);
  env.__faults.epochSelect = true;

  // A 的删除请求：D1 写入已经发生（复审场景），只是广播被暂缓
  await room.broadcast({ event: 'revoke', data: { id: 2 } }, 'default');
  await room.broadcast({ event: 'clearAll', data: { room: 'default' } }, 'default');
  check('B 故障期间什么都收不到', b.sent.length, 0);
  check('两条事件都已入队', room.missedEvents.map((e) => e.message.event), ['revoke', 'clearAll']);

  // 恢复（无新编辑、无重连）：alarm 复查即可
  env.__faults.epochSelect = false;
  await room.alarm();

  check('B 收到：revoke → clearAll → resync', b.sent.map((m) => m.event), ['revoke', 'clearAll', 'resync']);
  check('revoke 的 id 原样保留', b.sent[0].data.id, 2);
  check('clearAll 的房间保留', b.sent[1].data.room, 'default');
  check('队列已清空', room.missedEvents.length, 0);
}

console.log('\n-- J. 队列上限：溢出时仍保留 resync 兜底 --');
{
  const { env } = makeEnv();
  env.AUTH_PASSWORD = 'pw123';
  const token = await issueRoomSessionToken(env, 'default', 3600, 'global');
  const room = makeRoom(env);
  room.maxMissedEvents = 3;
  const b = addSession(room, 'b', token);

  injectDbFaults(env);
  env.__faults.epochSelect = true;
  for (let i = 0; i < 5; i += 1) {
    await room.broadcast({ event: 'revoke', data: { id: i } }, 'default');
  }
  check('队列被上限截断', room.missedEvents.length, 3);
  check('仍标记待补送', room.missedBroadcasts, true);

  env.__faults.epochSelect = false;
  await room.alarm();
  const events = b.sent.map((m) => m.event);
  check('重放上限内的事件 + resync', events, ['revoke', 'revoke', 'revoke', 'resync']);
}

console.log('\n-- K. 端到端：A 删除/清空（HTTP 处理器）→ DO 队列 → 恢复重放 --');
{
  const { env } = makeEnv();
  env.AUTH_PASSWORD = 'pw123';
  const token = await issueRoomSessionToken(env, 'default', 3600, 'global');

  // 先造 3 条历史
  for (const t of ['one', 'two', 'three']) {
    await worker.fetch(
      new Request('http://worker.local/text?room=default&client=t', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: t }),
      }),
      env,
      {},
    );
  }
  const ids = [1, 2, 3];

  const room = makeRoom(env);
  const b = addSession(room, 'b', token);

  // ⚠️ 真实故障是「DO 的纪元读取失败」而处理器的写入成功 —— 用两份 env 建模：
  //    处理器用健康 DB，DO 用自己的 env（可注入故障）。
  const doEnv = { ...env };
  injectDbFaults(doEnv);
  room.env = doEnv;
  env.WEBSOCKET_ROOM = {
    idFromName: () => 'room',
    get: () => ({ fetch: (req) => room.fetch(req) }),
  };

  doEnv.__faults.epochSelect = true;

  // A 删除 id=2，然后清空全部
  const del = await worker.fetch(
    new Request('http://worker.local/revoke/2?room=default&client=a', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
    }),
    env,
    {},
  );
  check('删除接口成功（写入已落库）', del.status, 200);
  const remainingAfterDelete = (await env.DB.prepare('SELECT id FROM messages ORDER BY id').all()).results.map((r) => r.id);
  check('服务器已删掉 id=2', remainingAfterDelete, [1, 3]);
  check('B 暂未收到（广播被暂缓）', b.sent.length, 0);
  check('DO 已把 revoke 入队', room.missedEvents.map((e) => e.message.event), ['revoke']);

  const clear = await worker.fetch(
    new Request('http://worker.local/revoke/all?room=default&client=a', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
    }),
    env,
    {},
  );
  check('清空接口成功', clear.status, 200);
  check('服务器历史已清空', Number((await env.DB.prepare('SELECT COUNT(*) AS n FROM messages').first()).n), 0);
  check('B 仍什么都没收到', b.sent.length, 0);
  check('队列里是 revoke → clearAll', room.missedEvents.map((e) => e.message.event), ['revoke', 'clearAll']);

  // 恢复：无刷新、无重连、无新编辑，仅 alarm
  doEnv.__faults.epochSelect = false;
  await room.alarm();

  check('B 收到 revoke → clearAll → resync', b.sent.map((m) => m.event), ['revoke', 'clearAll', 'resync']);

  // 模拟 B 的客户端状态机（与 web/src/stores/wsStore.ts 的 switch 一致）：
  // revoke 删一条；clearAll 清空。最终必须与服务器一致。
  let clientList = [...ids];
  let afterRevokeOnly = null;
  for (const frame of b.sent) {
    if (frame.event === 'revoke') {
      clientList = clientList.filter((id) => id !== Number(frame.data.id));
      afterRevokeOnly = [...clientList];
    }
    if (frame.event === 'clearAll') clientList = [];
  }
  // 只应用 revoke 后的 B，与服务器「删掉一条」时的状态一致；
  check('单删场景：B 与服务器一致', afterRevokeOnly, remainingAfterDelete);
  check('清空场景：B 的历史与服务器一致（都是空）', clientList, []);
}

summary('纪元读取故障（三态 + 恢复重放）');
