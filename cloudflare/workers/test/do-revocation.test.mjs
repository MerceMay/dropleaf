// 退出登录后，**已建立**的 WebSocket 不能继续收到新草稿（V2 复审 P1）。
//
// 复审的两个洞：
//   1. `broadcast()` 先 fire-and-forget 复验、再立即投递 —— 撤销结论还没回来，
//      消息已经发出去了；
//   2. 会话纪元缓存在 DO **长期持有**的 env 上（`env.__sessionEpoch` 永不过期），
//      DO 内的复验一直读到退出前的旧纪元，旧连接永远「有效」。
//
// 修法：
//   · 纪元缓存加上界（5s），退出登录另有**即时**通知：Worker 抬纪元后同步调
//     DO 的 `/revoke-sessions`，DO 按 claims.ver < 新纪元直接 close(1008)；
//   · `broadcast()` 改成 async 且 await 复验，撤销先落地再投递。
//
// 这里用 DO 测试替身（借原型，绕开 Node 里造不出来的 WebSocketPair）。
import { WebSocketRoom } from './.build/websocket-room.mjs';
import { issueRoomSessionToken, bumpSessionEpoch, getSessionEpoch } from './.build/auth.mjs';
import { makeEnv, makeChecker } from './harness.mjs';

const { check, summary } = makeChecker();

function makeRoom(env) {
  const room = Object.create(WebSocketRoom.prototype);
  room.env = env;
  room.sessions = new Map();
  room.revokingSessions = new Set();
  room.missedEvents = [];
  room.missedBroadcasts = false;
  room.maxMissedEvents = 500;
  room.state = { storage: { getAlarm: async () => null, setAlarm: async () => {} } };
  return room;
}

function addSession(room, sessionId, token, roomName = 'default') {
  const sent = [];
  const socket = {
    readyState: 1, // WebSocket.OPEN
    send: (payload) => sent.push(JSON.parse(payload)),
    close: (code, reason) => {
      socket.closed = { code, reason };
      socket.readyState = 3; // CLOSED
    },
  };
  room.sessions.set(sessionId, {
    webSocket: socket,
    sessionId,
    room: roomName,
    token,
    tokenCheckedAt: 0,
    connectedAt: Date.now(),
    lastPresenceTouchedAt: 0,
  });
  return { sent, socket };
}

function doRequest(room, path, body) {
  return room.fetch(new Request(`https://internal${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  }));
}

console.log('\n-- A. 广播前先复验：被撤销的连接收不到这一条 --');
{
  const { env } = makeEnv();
  env.AUTH_PASSWORD = 'pw123';
  const token = await issueRoomSessionToken(env, 'default', 3600, 'global');
  const room = makeRoom(env);
  const { sent, socket } = addSession(room, 's1', token);

  // 模拟「另一台设备退出登录」：纪元已推进（DAO 层直接改库）
  await bumpSessionEpoch(env);

  await room.broadcast({ event: 'draft', data: { content: '退出之后的新草稿' } }, 'default');

  check('旧连接没有收到这条广播', sent.length, 0);
  check('旧连接被关闭', socket.closed?.code, 1008);
  check('会话已从表里移除', room.sessions.has('s1'), false);
}

console.log('\n-- B. 退出通知：/revoke-sessions 立即关闭旧纪元连接 --');
{
  const { env } = makeEnv();
  env.AUTH_PASSWORD = 'pw123';
  const oldToken = await issueRoomSessionToken(env, 'default', 3600, 'global');
  const room = makeRoom(env);
  const oldConn = addSession(room, 'old', oldToken);

  const epoch = await bumpSessionEpoch(env);
  const newToken = await issueRoomSessionToken(env, 'default', 3600, 'global');
  const newConn = addSession(room, 'new', newToken);

  const res = await doRequest(room, '/revoke-sessions', { epoch });
  const body = await res.json();

  check('通知返回关闭数 1', body.closed, 1);
  check('旧连接被关闭', oldConn.socket.closed?.code, 1008);
  check('新令牌的连接保持', room.sessions.has('new'), true);
  check('新连接未被关闭', newConn.socket.closed, undefined);

  await room.broadcast({ event: 'draft', data: { content: '新草稿' } }, 'default');
  check('新连接收到广播', newConn.sent.length, 1);
  check('旧连接一条也没收到', oldConn.sent.length, 0);
}

console.log('\n-- C. 纪元缓存有上界（DO env 不再永远读旧值） --');
{
  const { env } = makeEnv();
  env.AUTH_PASSWORD = 'pw123';
  check('DO env 首次读取 = 0', await getSessionEpoch(env), 0);

  // 另一个请求（另一份 env，共享同一 D1）推进纪元
  const { env: writerEnv } = { env: { ...env } };
  delete writerEnv.__sessionEpoch;
  delete writerEnv.__sessionEpochAt;
  await bumpSessionEpoch(writerEnv);

  // 缓存未过期：DO 仍读旧值（这是允许的 5s 窗口）
  check('5s 内仍读缓存', await getSessionEpoch(env), 0);

  // 把缓存时间戳拨到过期，模拟窗口过去
  env.__sessionEpochAt = Date.now() - 10_000;
  check('缓存过期后读到新纪元', await getSessionEpoch(env), 1);
}

console.log('\n-- D. 无令牌的会话（开放实例）不受撤销影响 --');
{
  const { env } = makeEnv();
  env.AUTH_PASSWORD = 'pw123';
  const room = makeRoom(env);
  const open = addSession(room, 'open', '');
  const epoch = await bumpSessionEpoch(env);

  const res = await doRequest(room, '/revoke-sessions', { epoch });
  const body = await res.json();
  check('没有关闭任何会话', body.closed, 0);
  check('开放会话仍在', room.sessions.has('open'), true);
  check('未被关闭', open.socket.closed, undefined);
}

console.log('\n-- E. 在线状态：清理后心跳会补插（长时间后台/休眠） --');
{
  const { env } = makeEnv();
  env.AUTH_PASSWORD = 'pw123';
  await env.DB.prepare('CREATE TABLE IF NOT EXISTS room_presence (sessionId TEXT PRIMARY KEY, room TEXT, connectedAt INTEGER, userAgent TEXT, updatedAt INTEGER)').run();

  const room = makeRoom(env);
  const token = await issueRoomSessionToken(env, 'default', 3600, 'global');
  addSession(room, 's1', token);
  const session = room.sessions.get('s1');

  await room.persistSessionPresence(session);
  const row1 = await env.DB.prepare('SELECT COUNT(*) AS n FROM room_presence').first();
  check('连接时写入 presence', Number(row1.n), 1);

  // 模拟清理任务删掉行（长时间后台/休眠后 TTL 到期）
  await env.DB.prepare('DELETE FROM room_presence').run();
  check('行已删除', Number((await env.DB.prepare('SELECT COUNT(*) AS n FROM room_presence').first()).n), 0);

  // 下一次心跳（ping 帧走同一条路径）应当补插，而不是静默消失
  await room.touchSessionPresence(session, Date.now());
  const row2 = await env.DB.prepare('SELECT COUNT(*) AS n FROM room_presence').first();
  check('心跳把行补插回来', Number(row2.n), 1);
}

summary('退出登录撤销 WebSocket');
