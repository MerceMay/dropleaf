// 附件字节出口的**响应头**回归（V2 复审 P1）。
//
// 背景：上一轮只给 `/file/:uuid` 换上了安全响应头，`/content/:id` 与 `/content/latest`
// 的 raw 文件分支仍按上传时声明的 MIME 原样 inline 返回 —— 用户在 DropLeaf 同源打开
// HTML 附件，脚本照跑，可以读 localStorage 里的会话令牌。
//
// 现在三个出口共用 `src/file-response.js` 一份实现。本文件对**每一个出口**各钉一遍：
//   · HTML / SVG → octet-stream + attachment + nosniff + CSP sandbox + private no-store；
//   · PNG → 保持 image/png + inline（预览不能坏）。
import { ContentHandler } from './.build/content.mjs';
import worker from './.build/index.mjs';
import { makeEnv, makeChecker, sessionBearer } from './harness.mjs';

const { check, summary } = makeChecker();

const HTML = new TextEncoder().encode('<html><body><script>alert(document.cookie)</script></body></html>');
const SVG = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01]);

async function upload(env, bytes, filename, type) {
  const form = new FormData();
  form.append('file', new Blob([bytes], { type }), filename);
  const res = await worker.fetch(
    new Request('http://worker.local/upload?room=default&client=t', {
      method: 'POST',
      headers: { Authorization: await sessionBearer(env) },
      body: form,
    }),
    env,
    {},
  );
  const json = await res.json();
  const row = await env.DB.prepare('SELECT uuid FROM messages WHERE id = ?').bind(Number(json.id)).first();
  return { id: String(json.id), uuid: row?.uuid };
}

/** 三个出口的响应（都走真 router，顺带钉住「路由真的注册了」）。 */
async function responsesFor(env, { id, uuid }, filename) {
  const auth = await sessionBearer(env);
  const get = path => worker.fetch(
    new Request(`http://worker.local${path}`, { headers: { Authorization: auth } }),
    env,
    {},
  );

  const byId = await get(`/content/${id}?format=raw`);
  const latest = await get('/content/latest?format=raw');
  const byFile = await get(`/file/${uuid}/${encodeURIComponent(filename)}`);
  return { byId, latest, byFile };
}

function assertSafe(headers, label) {
  check(`${label}: Content-Type 降到 octet-stream`, headers.get('Content-Type'), 'application/octet-stream');
  check(
    `${label}: 强制 attachment`,
    String(headers.get('Content-Disposition') || '').startsWith('attachment'),
    true,
  );
  check(`${label}: X-Content-Type-Options`, headers.get('X-Content-Type-Options'), 'nosniff');
  check(`${label}: CSP sandbox`, headers.get('Content-Security-Policy'), 'sandbox');
  check(`${label}: 私有不缓存`, headers.get('Cache-Control'), 'private, no-store');
}

console.log('\n-- A. HTML 附件：三个出口一律不可内联执行 --');
{
  const { env } = makeEnv();
  env.AUTH_PASSWORD = 'pw123';
  const record = await upload(env, HTML, 'evil.html', 'text/html');
  check('上传拿到 uuid', typeof record.uuid, 'string');

  const { byId, latest, byFile } = await responsesFor(env, record, 'evil.html');
  check('/content/:id 200', byId.status, 200);
  check('/content/latest 200', latest.status, 200);
  check('/file 200', byFile.status, 200);

  assertSafe(byId.headers, '/content/:id');
  assertSafe(latest.headers, '/content/latest');
  assertSafe(byFile.headers, '/file');

  // 字节没被改写（只是不让浏览器执行）
  check('/content/:id 正文仍是原字节', (await byId.text()).includes('<script>'), true);
}

console.log('\n-- B. SVG 同样按 HTML 处理（可内嵌脚本） --');
{
  const { env } = makeEnv();
  env.AUTH_PASSWORD = 'pw123';
  const record = await upload(env, SVG, 'evil.svg', 'image/svg+xml');

  const { byId, latest, byFile } = await responsesFor(env, record, 'evil.svg');
  assertSafe(byId.headers, '/content/:id svg');
  assertSafe(latest.headers, '/content/latest svg');
  assertSafe(byFile.headers, '/file svg');
}

console.log('\n-- C. PNG 仍然 inline 预览（安全类型不能被一起降级） --');
{
  const { env } = makeEnv();
  env.AUTH_PASSWORD = 'pw123';
  const record = await upload(env, PNG, 'shot.png', 'image/png');

  const { byId, latest, byFile } = await responsesFor(env, record, 'shot.png');
  for (const [label, res] of [['/content/:id png', byId], ['/content/latest png', latest], ['/file png', byFile]]) {
    check(`${label}: Content-Type`, res.headers.get('Content-Type'), 'image/png');
    check(
      `${label}: inline`,
      String(res.headers.get('Content-Disposition') || '').startsWith('inline'),
      true,
    );
    check(`${label}: 仍带 nosniff`, res.headers.get('X-Content-Type-Options'), 'nosniff');
  }
}

console.log('\n-- D. download=true 时安全类型也变附件 --');
{
  const { env } = makeEnv();
  env.AUTH_PASSWORD = 'pw123';
  const record = await upload(env, PNG, 'shot.png', 'image/png');
  const auth = await sessionBearer(env);

  const asDownload = await worker.fetch(
    new Request(`http://worker.local/content/${record.id}?format=raw&download=true`, {
      headers: { Authorization: auth },
    }),
    env,
    {},
  );
  check(
    'content + download=true → attachment',
    String(asDownload.headers.get('Content-Disposition') || '').startsWith('attachment'),
    true,
  );

  const fileDownload = await worker.fetch(
    new Request(`http://worker.local/file/${record.uuid}/shot.png?download=true`, {
      headers: { Authorization: auth },
    }),
    env,
    {},
  );
  check(
    '/file + download=true → attachment',
    String(fileDownload.headers.get('Content-Disposition') || '').startsWith('attachment'),
    true,
  );
}

console.log('\n-- E. 未登录时三个出口都拿不到字节 --');
{
  const { env } = makeEnv();
  env.AUTH_PASSWORD = 'pw123';
  const record = await upload(env, HTML, 'evil.html', 'text/html');

  const anon = path => worker.fetch(new Request(`http://worker.local${path}`), env, {});
  check('/content/:id 401', (await anon(`/content/${record.id}?format=raw`)).status, 401);
  check('/content/latest 401', (await anon('/content/latest?format=raw')).status, 401);
  check('/file 401', (await anon(`/file/${record.uuid}/evil.html`)).status, 401);
}

// 直接调处理器也要走同一套头（防止有人绕过 router 另起一条路）
console.log('\n-- F. 直接调 ContentHandler.buildFileResponse 仍是安全头 --');
{
  const { env } = makeEnv();
  env.AUTH_PASSWORD = 'pw123';
  const record = await upload(env, HTML, 'evil.html', 'text/html');
  const row = await env.DB.prepare('SELECT * FROM messages WHERE id = ?').bind(Number(record.id)).first();
  const res = await ContentHandler.buildFileResponse(env, row, { forceDownload: false });
  assertSafe(res.headers, 'buildFileResponse');
}

summary('附件响应头（三个出口）');
