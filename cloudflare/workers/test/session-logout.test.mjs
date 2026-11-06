// 退出登录 = 会话真的失效（安全修复 2026-11-05）。
//
// 背景：令牌是**无状态 HMAC**（签名载荷 + exp）。这类令牌默认无法作废 ——
// 用户点「退出」后，被抄走的那份仍能用满 7 天。修法是服务端存一个会话纪元
// （app_state.session_epoch）：签发时把 ver 写进令牌，校验时比对；退出 = 纪元 +1，
// 于是所有旧令牌立刻作废。
//
// 这里钉住四件事：
//   1. 退出后旧令牌 401；
//   2. 退出前签的**其它设备**令牌也一起 401（单人剪贴板要的就是这个语义）；
//   3. 退出后重新登录签的新令牌可用（纪元推进不会把新会话也弄死）；
//   4. 垃圾令牌 POST /auth/logout 不得抬纪元（否则任何人都能把主人踢下线）。
import { issueRoomSessionToken, validateRoomSessionToken, getSessionEpoch } from './.build/auth.mjs';
import worker from './.build/index.mjs';
import { makeEnv, makeChecker } from './harness.mjs';

const { check, summary } = makeChecker();

function logoutRequest(env, token) {
  const headers = token ? { Authorization: `Bearer ${token}` } : {};
  return worker.fetch(
    new Request('http://worker.local/auth/logout?room=default', { method: 'POST', headers }),
    env,
    {},
  );
}

function draftRequest(env, token) {
  const headers = token ? { Authorization: `Bearer ${token}` } : {};
  return worker.fetch(new Request('http://worker.local/draft', { headers }), env, {});
}

console.log('\n-- A. 退出后旧令牌立即失效 --');
{
  const { env, broadcasts } = makeEnv();
  env.AUTH_PASSWORD = 'pw123';

  const token = await issueRoomSessionToken(env, 'default', 3600, 'global');
  check('退出前令牌可用', await validateRoomSessionToken(env, 'default', token), 'ok');
  check('退出前 /draft 200', (await draftRequest(env, token)).status, 200);

  const res = await logoutRequest(env, token);
  const body = await res.json();
  check('退出请求 200', res.status, 200);
  check('服务端确认作废', body.revoked, true);
  check('响应里清了 Cookie', (res.headers.get('Set-Cookie') || '').includes('Max-Age=0'), true);

  // 退出还必须**通知房间 DO** 关闭旧连接（复审 P1）：控制消息带上新纪元，
  // 由 DO 按 claims.ver < epoch 立即 close(1008)，不等 5s 的纪元缓存。
  const revoked = (broadcasts || []).find((b) => b.control === 'revoke-sessions');
  check('通知了 DO 撤销会话', Boolean(revoked), true);
  check('通知携带新纪元', Number(revoked?.body?.epoch) >= 1, true);
  check('退出后令牌不再有效', await validateRoomSessionToken(env, 'default', token), 'stale');
  check('退出后 /draft 401', (await draftRequest(env, token)).status, 401);
}

console.log('\n-- B. 其它设备上的令牌同样作废 --');
{
  const { env } = makeEnv();
  env.AUTH_PASSWORD = 'pw123';

  // 两台设备各签一张（同一纪元）
  const phone = await issueRoomSessionToken(env, 'default', 3600, 'global');
  const laptop = await issueRoomSessionToken(env, 'default', 3600, 'global');
  check('两台设备令牌各自有效', [
    await validateRoomSessionToken(env, 'default', phone),
    await validateRoomSessionToken(env, 'default', laptop),
  ], ['ok', 'ok']);

  await logoutRequest(env, phone);

  check('退出设备的令牌失效', await validateRoomSessionToken(env, 'default', phone), 'stale');
  check('另一台设备也失效（单人剪贴板语义）', await validateRoomSessionToken(env, 'default', laptop), 'stale');

  // 纪元推进后重新登录：新令牌必须能用，否则退出就成了「锁死自己」
  const afterLogin = await issueRoomSessionToken(env, 'default', 3600, 'global');
  check('退出后重新签的令牌可用', await validateRoomSessionToken(env, 'default', afterLogin), 'ok');
}

console.log('\n-- C. 垃圾令牌不得抬纪元（拒绝服务防护）--');
{
  const { env } = makeEnv();
  env.AUTH_PASSWORD = 'pw123';

  const token = await issueRoomSessionToken(env, 'default', 3600, 'global');
  const epochBefore = await getSessionEpoch(env);

  const junk = await logoutRequest(env, 'not-a-real-token');
  const junkBody = await junk.json();
  check('垃圾令牌退出请求 200（幂等语义）', junk.status, 200);
  check('垃圾令牌不触发作废', junkBody.revoked, false);
  check('纪元未变', await getSessionEpoch(env), epochBefore);
  check('主人令牌仍然可用（没被踢下线）', await validateRoomSessionToken(env, 'default', token), 'ok');
}

console.log('\n-- D. 无凭据退出只清 Cookie，不动会话 --');
{
  const { env } = makeEnv();
  env.AUTH_PASSWORD = 'pw123';
  const token = await issueRoomSessionToken(env, 'default', 3600, 'global');

  const res = await logoutRequest(env, '');
  check('无凭据退出 200', res.status, 200);
  check('响应清 Cookie', (res.headers.get('Set-Cookie') || '').includes('Max-Age=0'), true);
  check('其他人令牌不受影响', await validateRoomSessionToken(env, 'default', token), 'ok');
}

console.log('\n-- E. 退出只认 POST --');
{
  const { env } = makeEnv();
  env.AUTH_PASSWORD = 'pw123';
  const token = await issueRoomSessionToken(env, 'default', 3600, 'global');

  const res = await worker.fetch(
    new Request(`http://worker.local/auth/logout?room=default&auth=${encodeURIComponent(token)}`),
    env,
    {},
  );
  check('GET /auth/logout → 405', res.status, 405);
  check('GET 没有把人踢下线', await validateRoomSessionToken(env, 'default', token), 'ok');
}

summary('退出登录与会话纪元');
