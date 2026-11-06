// 第二轮复审的四个缺口。
//
//   P1-A  WS 握手凭 Cookie 通过（同站其它子域的页面可订阅实时草稿）
//         → 握手不再接受 Cookie：凭据只认 Authorization 头 / ?auth= / 子协议。
//   P1-B  DO 撤销回 500 时 logout 仍返回 200，旧连接继续收草稿
//         → 通知失败（非 2xx/超时）logout 回 503；广播对撤销目标一律跳过投递。
//   P1-C  并发退出读改写同一个纪元（两次都写回 1）
//         → 单条 UPSERT 原子递增 + RETURNING，每个 logout 拿到不同新值。
//   P2    被限流的请求也留记录，重试不断延长锁定
//         → 满额时不插入；窗口结束后名额自然恢复。
import { WebSocketRoom } from './.build/websocket-room.mjs';
import { issueRoomSessionToken, bumpSessionEpoch, getSessionEpoch, extractWebSocketToken, validateRoomSessionToken } from './.build/auth.mjs';
import worker from './.build/index.mjs';
import { makeEnv, makeChecker } from './harness.mjs';

const { check, summary } = makeChecker();

function upgradeRequest(env, { token = '', cookie = '', origin = 'http://app.example.com', room = 'default' } = {}) {
  const headers = {
    Upgrade: 'websocket',
    Connection: 'Upgrade',
    'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==',
    'Sec-WebSocket-Version': '13',
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (cookie) headers.Cookie = cookie;
  if (origin) headers.Origin = origin;
  return worker.fetch(new Request(`http://worker.local/push?room=${room}`, { headers }), env, {});
}

async function login(env, password = 'pw123') {
  const res = await worker.fetch(
    new Request('http://worker.local/auth/token?room=default', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password }),
    }),
    env,
    {},
  );
  const json = await res.json();
  return { token: json.token, cookie: (res.headers.get('Set-Cookie') || '').split(';')[0] };
}

function logoutRequest(env, token) {
  return worker.fetch(
    new Request('http://worker.local/auth/logout?room=default', {
      method: 'POST',
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    }),
    env,
    {},
  );
}

console.log('\n-- P1-A. WS 握手：Cookie 不是有效凭据 --');
{
  const { env } = makeEnv();
  env.AUTH_PASSWORD = 'pw123';
  const { token, cookie } = await login(env);
  check('Cookie 确实签出来了', Boolean(cookie), true);

  // 复审攻击形状：同站子域 Origin + 有效 Cookie，无显式令牌
  const res = await upgradeRequest(env, { cookie, origin: 'http://evil.app.example.com' });
  check('仅 Cookie 的跨子域握手 → 401', res.status, 401);

  // 同一 Cookie 用在 HTTP 读接口仍然有效（预览路径不受影响）
  const read = await worker.fetch(
    new Request('http://worker.local/draft', { headers: { Cookie: cookie } }),
    env,
    {},
  );
  check('GET /draft 用 Cookie → 200', read.status, 200);

  // 显式令牌的三种形态都放行。
  // 注：Node 里没有 WebSocketPair，鉴权通过后请求会落到 DO 桩（回 200）——
  // 这里断言的是「鉴权放行」，不是握手状态码本身。
  check('握手 + Authorization 头 → 放行', (await upgradeRequest(env, { token })).status, 200);
  check('握手 + ?auth= → 放行', (await worker.fetch(
    new Request(`http://worker.local/push?room=default&auth=${encodeURIComponent(token)}`, {
      headers: {
        Upgrade: 'websocket', Connection: 'Upgrade',
        'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==', 'Sec-WebSocket-Version': '13',
      },
    }), env, {},
  )).status, 200);
  check('握手 + 子协议 → 放行', (await worker.fetch(
    new Request('http://worker.local/push?room=default', {
      headers: {
        Upgrade: 'websocket', Connection: 'Upgrade',
        'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==', 'Sec-WebSocket-Version': '13',
        'Sec-WebSocket-Protocol': token,
      },
    }), env, {},
  )).status, 200);

  // extractWebSocketToken 单元级：Cookie 在也不看
  const reqWithCookie = new Request('http://worker.local/push?room=default', {
    headers: { Cookie: 'paste_session=sometoken' },
  });
  check('extractWebSocketToken 忽略 Cookie', extractWebSocketToken(reqWithCookie), '');
}

console.log('\n-- P1-B. DO 撤销失败：logout 必须不返回成功 --');
{
  const { env } = makeEnv();
  env.AUTH_PASSWORD = 'pw123';
  const token = await issueRoomSessionToken(env, 'default', 3600, 'global');

  // 注入 DO 500（复审的注入方式）：撤销通知失败
  env.WEBSOCKET_ROOM = {
    idFromName: (name) => name,
    get: () => ({
      async fetch() {
        return new Response('Revoke Error', { status: 500 });
      },
    }),
  };

  const res = await logoutRequest(env, token);
  const body = await res.json();
  check('DO 500 → logout 503（不谎报成功）', res.status, 503);
  check('错误码 logout_incomplete', body.code, 'logout_incomplete');

  // 恢复正常 DO 后重试：令牌已被第一次退出作废 → **不再抬纪元**，但必须
  // **重新通知 DO**（补救上次失败的通知）。这正是 503 提示用户重试的意义。
  const notified = [];
  env.WEBSOCKET_ROOM = {
    idFromName: (name) => name,
    get: () => ({
      async fetch(request) {
        notified.push(await request.json());
        return new Response('OK');
      },
    }),
  };
  const epochAfterFirst = await getSessionEpoch({ ...env, __sessionEpoch: undefined, __sessionEpochAt: undefined });
  const retry = await logoutRequest(env, token);
  check('重试成功（补救通知落地）', retry.status, 200);
  check('重试确实又通知了 DO', notified.length, 1);
  check('重试不再抬纪元', await getSessionEpoch({ ...env, __sessionEpoch: undefined, __sessionEpochAt: undefined }), epochAfterFirst);
}

console.log('\n-- P1-B2. 广播兜底：通知失败 + 刚验过的会话也挡得住 --');
{
  const { env } = makeEnv();
  env.AUTH_PASSWORD = 'pw123';
  const token = await issueRoomSessionToken(env, 'default', 3600, 'global');
  const room = Object.create(WebSocketRoom.prototype);
  room.env = env;
  room.sessions = new Map();
  room.revokingSessions = new Set();

  const sent = [];
  const socket = {
    readyState: 1,
    send: (p) => sent.push(JSON.parse(p)),
    close: () => { socket.readyState = 3; },
  };
  // 复审的漏网窗口：这个会话「刚刚验过」（旧实现 60s 内跳过复验）
  room.sessions.set('fresh', {
    webSocket: socket, sessionId: 'fresh', room: 'default',
    token, tokenCheckedAt: Date.now(), connectedAt: Date.now(), lastPresenceTouchedAt: 0,
  });

  // 另一台设备退出（纪元推进），**通知没有到达 DO**（这里不调 /revoke-sessions）
  await bumpSessionEpoch(env);

  await room.broadcast({ event: 'draft', data: { content: '退出之后的新草稿' } }, 'default');
  check('刚验过的旧会话也收不到广播', sent.length, 0);
  check('并且被关闭', socket.readyState, 3);
  check('会话已移除', room.sessions.has('fresh'), false);

  // 新纪元之后签发的令牌照常收到
  const freshEnv = { ...env };
  delete freshEnv.__sessionEpoch;
  delete freshEnv.__sessionEpochAt;
  const newToken = await issueRoomSessionToken(freshEnv, 'default', 3600, 'global');
  const sent2 = [];
  room.sessions.set('new', {
    webSocket: { readyState: 1, send: (p) => sent2.push(p), close: () => {} },
    sessionId: 'new', room: 'default', token: newToken,
    tokenCheckedAt: 0, connectedAt: Date.now(), lastPresenceTouchedAt: 0,
  });
  await room.broadcast({ event: 'draft', data: { content: '新草稿' } }, 'default');
  check('新纪元令牌收到广播', sent2.length, 1);
}

console.log('\n-- P1-C. 并发退出：纪元严格递增 --');
{
  const { env } = makeEnv();
  env.AUTH_PASSWORD = 'pw123';

  const epochBefore = await getSessionEpoch(env);
  // 两个独立 env（两个并发请求各持一份）同时推进
  const envA = { ...env };
  const envB = { ...env };
  delete envA.__sessionEpoch; delete envA.__sessionEpochAt;
  delete envB.__sessionEpoch; delete envB.__sessionEpochAt;

  const [a, b] = await Promise.all([bumpSessionEpoch(envA), bumpSessionEpoch(envB)]);
  // Worker 里每个请求是**一份新的 env**；缓存只活在一个请求内。
  const freshEnv = () => {
    const e = { ...env };
    delete e.__sessionEpoch;
    delete e.__sessionEpochAt;
    return e;
  };
  check('两次推进拿到**不同**新值', a !== b, true);
  check('终值 = 旧值 + 2', await getSessionEpoch(freshEnv()), epochBefore + 2);
  check('较大值 = 终值', Math.max(a, b), epochBefore + 2);

  // 其间签发的令牌在第二次退出后必须失效（复审的时序）
  const mid = await issueRoomSessionToken(freshEnv(), 'default', 3600, 'global');
  check('两次推进之后签发的令牌用终值校验 → 有效（终值就是最新纪元）', await validateRoomSessionToken(freshEnv(), 'default', mid), 'ok');
  const stale = await issueRoomSessionToken(freshEnv(), 'default', 3600, 'global');
  await bumpSessionEpoch(freshEnv());
  check('再来一次退出后，上一纪元签发的令牌失效', await validateRoomSessionToken(freshEnv(), 'default', stale), 'stale');
}

console.log('\n-- P2. 限流：满额不新增记录，到点恢复 --');
{
  const { env } = makeEnv();
  env.AUTH_PASSWORD = 'pw123';

  async function attempt(password) {
    return worker.fetch(
      new Request('http://worker.local/auth/token?room=default', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '9.9.9.9' },
        body: JSON.stringify({ password }),
      }),
      env,
      {},
    );
  }
  const countRows = () => env.DB.prepare('SELECT COUNT(*) AS n FROM auth_attempts WHERE ip = ?').bind('9.9.9.9').first().then(r => Number(r?.n || 0));

  // 5 次失败占满名额
  const statuses = [];
  for (let i = 0; i < 5; i += 1) statuses.push((await attempt(`bad-${i}`)).status);
  check('前 5 次 401', statuses, [401, 401, 401, 401, 401]);
  check('记录数 = 5', await countRows(), 5);

  // 再来 7 个：全部 429 且**不新增记录**
  const burst = await Promise.all(Array.from({ length: 7 }, () => attempt('flood')));
  check('7 个请求全 429', burst.every(r => r.status === 429), true);
  check('记录数仍 = 5（没有被 429 撑大）', await countRows(), 5);

  // 名额耗尽后**按时恢复**：把 5 条记录的 ts 拨回窗口外，正确密码立即放行
  const old = Math.floor(Date.now() / 1000) - 16 * 60;
  await env.DB.prepare('UPDATE auth_attempts SET ts = ? WHERE ip = ?').bind(old, '9.9.9.9').run();
  check('窗口过后正确密码 → 200', (await attempt('pw123')).status, 200);
  check('成功登录清空名额', await countRows(), 0);
}

summary('第二轮复审缺口');
