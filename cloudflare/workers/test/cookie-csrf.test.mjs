// Cookie 只用于安全读取（V2 复审 P1：同站子域 CSRF）。
//
// 背景：登录会 Set 一个 HttpOnly 会话 Cookie 给媒体预览用。但 Cookie 是**环境凭据**：
// `evil.example.com` 用表单 POST 打 `api.example.com`，浏览器照样带上它，而
// `SameSite=Lax` 只拦跨站、拦不住同站子域 —— 复审实测：带外域 Origin + 有效 Cookie
// 调 `POST /revoke/all` 返回 200，历史被清空。
//
// 修法：Cookie 只对安全方法（GET/HEAD）生效；写操作必须显式 Authorization 头
// （跨站表单设不了）。本文件钉住：写路径拒绝 Cookie，读路径保留 Cookie。
import worker from './.build/index.mjs';
import { makeEnv, makeChecker } from './harness.mjs';

const { check, summary } = makeChecker();

async function login(env) {
  const res = await worker.fetch(
    new Request('http://worker.local/auth/token?room=default', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: 'pw123' }),
    }),
    env,
    {},
  );
  const json = await res.json();
  return { token: json.token, cookie: (res.headers.get('Set-Cookie') || '').split(';')[0] };
}

async function seedHistory(env, text) {
  const { token } = await login(env);
  await worker.fetch(
    new Request('http://worker.local/text?room=default&client=t', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: text }),
    }),
    env,
    {},
  );
}

// makeEnv 返回的是**裸** node:sqlite 句柄（同步 API），与 env.DB 的 D1 形状不同
const countRows = (db) => db.prepare('SELECT COUNT(*) AS n FROM messages').get().n;

console.log('\n-- A. 同站其它子域的表单请求：Cookie 不能清空历史 --');
{
  const { env, db } = makeEnv();
  env.AUTH_PASSWORD = 'pw123';
  await seedHistory(env, '不该被清掉');
  check('先有 1 条历史', countRows(db), 1);

  const { cookie } = await login(env);

  // 复现复审的请求形状：外域 Origin + 有效 Cookie + 无 Authorization 头、无请求体
  const attack = await worker.fetch(
    new Request('http://worker.local/revoke/all?room=default', {
      method: 'POST',
      headers: {
        Origin: 'http://evil.example.com',
        Cookie: cookie,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: '',
    }),
    env,
    {},
  );
  check('跨子域表单 POST /revoke/all → 401', attack.status, 401);
  check('历史仍在', countRows(db), 1);

  // 同一份 Cookie 用在读接口上仍然是允许的（媒体预览靠它）
  const readWithCookie = await worker.fetch(
    new Request('http://worker.local/content?room=default&limit=5', { headers: { Cookie: cookie } }),
    env,
    {},
  );
  check('GET /content 用 Cookie → 200', readWithCookie.status, 200);
}

console.log('\n-- B. 写草稿：Cookie 不放行，令牌头放行 --');
{
  const { env } = makeEnv();
  env.AUTH_PASSWORD = 'pw123';
  const { token, cookie } = await login(env);

  const body = JSON.stringify({ draftId: null, revision: null, content: 'cookie 写入' });
  const withCookie = await worker.fetch(
    new Request('http://worker.local/draft', {
      method: 'PUT',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body,
    }),
    env,
    {},
  );
  check('PUT /draft 仅 Cookie → 401', withCookie.status, 401);

  const withHeader = await worker.fetch(
    new Request('http://worker.local/draft', {
      method: 'PUT',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body,
    }),
    env,
    {},
  );
  check('PUT /draft 带令牌头 → 200', withHeader.status, 200);

  // GET 读草稿：Cookie 可以（同源页面的读取）
  const readWithCookie = await worker.fetch(
    new Request('http://worker.local/draft', { headers: { Cookie: cookie } }),
    env,
    {},
  );
  check('GET /draft 用 Cookie → 200', readWithCookie.status, 200);
}

console.log('\n-- C. 附件/历史读取保留 Cookie（预览不能坏） --');
{
  const { env } = makeEnv();
  env.AUTH_PASSWORD = 'pw123';
  const { token, cookie } = await login(env);

  const form = new FormData();
  form.append('file', new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' }), 'p.png');
  const uploaded = await worker.fetch(
    new Request('http://worker.local/upload?room=default&client=t', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      body: form,
    }),
    env,
    {},
  );
  const upJson = await uploaded.json();
  const row = await env.DB.prepare('SELECT uuid FROM messages WHERE id = ?').bind(Number(upJson.id)).first();

  const fileWithCookie = await worker.fetch(
    new Request(`http://worker.local/file/${row.uuid}/p.png`, { headers: { Cookie: cookie } }),
    env,
    {},
  );
  check('GET /file 用 Cookie → 200（img 预览路径）', fileWithCookie.status, 200);

  const fileAnon = await worker.fetch(
    new Request(`http://worker.local/file/${row.uuid}/p.png`),
    env,
    {},
  );
  check('GET /file 无凭据 → 401', fileAnon.status, 401);
}

console.log('\n-- D. 退出登录不接受 Cookie（否则子域可把人踢下线） --');
{
  const { env } = makeEnv();
  env.AUTH_PASSWORD = 'pw123';
  const { token, cookie } = await login(env);

  const res = await worker.fetch(
    new Request('http://worker.local/auth/logout?room=default', {
      method: 'POST',
      headers: { Origin: 'http://evil.example.com', Cookie: cookie },
    }),
    env,
    {},
  );
  const body = await res.json();
  check('仅 Cookie 的退出请求 → 200（幂等）', res.status, 200);
  check('但不会作废会话', body.revoked, false);

  // 原令牌仍然可用
  const stillValid = await worker.fetch(
    new Request('http://worker.local/draft', { headers: { Authorization: `Bearer ${token}` } }),
    env,
    {},
  );
  check('主人令牌仍然有效', stillValid.status, 200);
}

console.log('\n-- E. ?auth= 显式令牌仍然可以用于写（非环境凭据） --');
{
  const { env } = makeEnv();
  env.AUTH_PASSWORD = 'pw123';
  const { token } = await login(env);

  const res = await worker.fetch(
    new Request(`http://worker.local/text?room=default&client=t&auth=${encodeURIComponent(token)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: 'query 令牌' }),
    }),
    env,
    {},
  );
  check('POST /text + ?auth= → 200', res.status, 200);
  check('历史里出现这条', (await env.DB.prepare("SELECT COUNT(*) AS n FROM messages WHERE content = 'query 令牌'").first()).n, 1);
}

summary('Cookie 写操作防护');
