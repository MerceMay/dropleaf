// 房间鉴权在 Worker 上的两条硬约束：
//
//  A. /file/ 按「文件自己记录的房间」鉴权，不看客户端传的 ?room=。
//     客户端可以随便写 ?room=，若被信任，`?room=default` 就能把受保护房间的文件读出来。
//     （Go 侧曾真的如此，见 cloud-clip/lib/auth.go 的 inferRequestRoom。）
//
//  B. 会话令牌的签名密钥材料必须包含房间密码。
//     parseRoomAuth 返回 {password, fileExpire} 对象，写成 normalizeAuthValue(roomAuth[room])
//     会 String() 成 '[object Object]' —— 只设房间密码时密钥完全可预测，
//     任何人都能自己签一个 scope=global 的令牌绕过所有房间密码。
//
//  C. 受保护房间下，客户端拿到的 url 必须能靠 ?auth= 自己取到 ——
//     Android 快捷指令的第二步下载就靠这个（第一次请求的凭据不会跟着走）。
import { FileHandler } from './.build/file.mjs';
import { ContentHandler } from './.build/content.mjs';
import { issueRoomSessionToken, validateRoomSessionToken, resolveRoomAuth, canAccessRoomAsync } from './.build/auth.mjs';
import { makeEnv, makeChecker, getJson } from './harness.mjs';

const { check, summary } = makeChecker();

const PNG = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
]);

async function uploadTo(env, db, room, filename, { auth }) {
  const form = new FormData();
  form.append('file', new Blob([PNG], { type: 'image/png' }), filename);
  const headers = {};
  if (auth) headers.Authorization = `Bearer ${auth}`;
  const res = await FileHandler.upload(
    new Request(`http://worker.local/upload?room=${encodeURIComponent(room)}`, {
      method: 'POST', headers, body: form,
    }),
    env,
  );
  const json = await res.json();
  // 注意 /upload 返回的 url 是 /content/<id>（和 Go 侧一致），拿不到文件 uuid —— 从库里读。
  const uuid = db.prepare('SELECT uuid FROM messages WHERE id = ?').get(Number(json.id))?.uuid;
  return { ...json, uuid };
}

// itty-router 的 params 由路由层塞进去，测试里手工挂上
function downloadRequest(url, params) {
  return Object.assign(new Request(url), { params });
}

console.log('\n── A. /file/ 的房间来自文件本身，?room= 伪造无效 ──');
{
  const { env, db } = makeEnv();
  env.AUTH_PASSWORD = '';                                   // 只设房间密码，逼出这条路径
  env.ROOM_AUTH_JSON = JSON.stringify({ vault: 'vaultpw' });

  // 密码先换**房间专属**会话令牌（安全修复：密码不再是 Bearer）
  const vaultToken = await issueRoomSessionToken(env, 'vault', 3600, '');
  const up = await uploadTo(env, db, 'vault', 'secret.png', { auth: vaultToken });
  const uuid = up.uuid;
  check('上传到 vault 成功', typeof uuid, 'string');

  const spoof = await FileHandler.download(
    downloadRequest(`http://worker.local/file/${uuid}/secret.png?room=default`, { uuid, filename: 'secret.png' }),
    env,
  );
  check('谎报 ?room=default 必须 401', spoof.status, 401);
  check('不得吐出字节', (await spoof.text()).includes('PNG'), false);

  const emptyRoom = await FileHandler.download(
    downloadRequest(`http://worker.local/file/${uuid}/secret.png?room=`, { uuid, filename: 'secret.png' }),
    env,
  );
  check('谎报空 room 必须 401', emptyRoom.status, 401);

  const noCreds = await FileHandler.download(
    downloadRequest(`http://worker.local/file/${uuid}/secret.png?room=vault`, { uuid, filename: 'secret.png' }),
    env,
  );
  check('不传凭据也必须 401', noCreds.status, 401);

  const ok = await FileHandler.download(
    downloadRequest(`http://worker.local/file/${uuid}/secret.png?room=vault&auth=${encodeURIComponent(vaultToken)}`, { uuid, filename: 'secret.png' }),
    env,
  );
  check('房间会话令牌正确才放行', ok.status, 200);
}

console.log('\n── B. 会话令牌的签名密钥必须含房间密码 ──');
{
  const { env: env1 } = makeEnv();
  env1.AUTH_PASSWORD = '';
  env1.ROOM_AUTH_JSON = JSON.stringify({ vault: 'pw-one' });

  const { env: env2 } = makeEnv();
  env2.AUTH_PASSWORD = '';
  env2.ROOM_AUTH_JSON = JSON.stringify({ vault: 'pw-two' });

  const token = await issueRoomSessionToken(env1, 'vault');
  check('同配置下令牌有效', await validateRoomSessionToken(env1, 'vault', token), 'ok');
  // 房间密码变了 → 密钥材料变了 → 旧令牌必须失效。
  // 若这里仍是 true，说明房间密码根本没参与派生（'[object Object]' 的老毛病）。
  check('换掉房间密码后旧令牌失效', await validateRoomSessionToken(env2, 'vault', token), 'stale');
}

console.log('\n── C. 受保护房间：/content/latest 的 url 能靠 ?auth= 自己取到 ──');
{
  const { env, db } = makeEnv();
  env.AUTH_PASSWORD = 'pw123';
  env.ROOM_AUTH_JSON = '{}';

  const sessionToken = await issueRoomSessionToken(env, 'default', 3600, 'global');
  const up = await uploadTo(env, db, 'default', 'shot.png', { auth: sessionToken });

  const noAuth = await getJson(ContentHandler.getLatest, env, '/content/latest?json=1&room=default', { auth: 'Bearer not-a-valid-token' });
  check('无效令牌读元数据 401', noAuth.status, 401);

  const withAuth = await getJson(ContentHandler.getLatest, env, `/content/latest?json=1&room=default&auth=${encodeURIComponent(sessionToken)}`, { auth: null });
  check('带 ?auth=<会话令牌> 读元数据 200', withAuth.status, 200);
  check('url 形态完好（不能出现 http:/ 这种少一个斜杠）', withAuth.json.url.startsWith('http://worker.local/file/'), true);
  check('url 带上了文件名', withAuth.json.url.endsWith('/shot.png'), true);

  // 第二步：客户端照 url 去取。Android 快捷指令就是在这里漏了 auth。
  const uuid = up.uuid;
  const step2NoAuth = await FileHandler.download(
    downloadRequest(`http://worker.local/file/${uuid}/shot.png`, { uuid, filename: 'shot.png' }),
    env,
  );
  check('第二步不带凭据 → 401（这就是用户报的现象）', step2NoAuth.status, 401);

  const step2WithAuth = await FileHandler.download(
    downloadRequest(`http://worker.local/file/${uuid}/shot.png?auth=${encodeURIComponent(sessionToken)}`, { uuid, filename: 'shot.png' }),
    env,
  );
  check('第二步补上 ?auth=<会话令牌> → 200', step2WithAuth.status, 200);
}

console.log('\n── C2. 网页端现在拼的是 /file/<uuid>（不带文件名）+ ?room=&auth= ──');
{
  // ⚠️★ 2026-10-26：网页端把「预览」从「签一条分享令牌（?t=）」改成「直接拼 /file/<uuid>」，
  //    地址里**不带文件名**（MIME 与 Content-Disposition 都由服务端按登记的文件名给）。
  //    这条路依赖两件事，两件都不会报错、只会「图片变成一份 index.html」：
  //      ① 路由器那条 `/file/:uuid/:filename?` 的 `?`（少了它 `/file/<uuid>` 会掉进 SPA 兜底）；
  //      ② `extractAuthToken` 认 `?auth=`。
  //    所以在这里把**网页端真正发出的那个形状**钉住。
  const { env, db } = makeEnv();
  env.AUTH_PASSWORD = 'pw123';
  env.ROOM_AUTH_JSON = '{}';

  const sessionToken = await issueRoomSessionToken(env, 'default', 3600, 'global');
  const up = await uploadTo(env, db, 'default', 'shot.png', { auth: sessionToken });
  const uuid = up.uuid;

  const noAuth = await FileHandler.download(
    downloadRequest(`http://worker.local/file/${uuid}`, { uuid }),
    env,
  );
  check('不带文件名、不带凭据 → 401（缺文件名不等于「公开」）', noAuth.status, 401);

  const withAuth = await FileHandler.download(
    downloadRequest(`http://worker.local/file/${uuid}?room=default&auth=${encodeURIComponent(sessionToken)}`, { uuid }),
    env,
  );
  check('不带文件名 + ?auth=<会话令牌> → 200', withAuth.status, 200);
  check('Content-Type 仍按登记的文件名给（png）', withAuth.headers.get('Content-Type'), 'image/png');
  check(
    '默认 inline（图片要能就地显示）',
    String(withAuth.headers.get('Content-Disposition') || '').startsWith('inline'),
    true,
  );

  const asDownload = await FileHandler.download(
    downloadRequest(`http://worker.local/file/${uuid}?room=default&auth=${encodeURIComponent(sessionToken)}&download=true`, { uuid }),
    env,
  );
  check(
    'download=true → attachment',
    String(asDownload.headers.get('Content-Disposition') || '').startsWith('attachment'),
    true,
  );
  check(
    'attachment 里带上了原文件名',
    String(asDownload.headers.get('Content-Disposition') || '').includes('shot.png'),
    true,
  );
}

console.log('\n── D. {"open": true} = 全局加密时仍然开放的房间 ──');
{
  const { env } = makeEnv();
  env.AUTH_PASSWORD = 'global-pw';
  env.ROOM_AUTH_JSON = JSON.stringify({
    public: { open: true },
    vault: 'vaultpw',
    'legacy-empty': '',
    contradiction: { open: true, password: 'both' },
  });

  // 显式开放：不要密码，也**不**回落全局密码
  check('open 房间 required=false', resolveRoomAuth(env, 'public').required, false);
  check('open 房间不带凭据也放行', await canAccessRoomAsync(env, 'public', ''), true);

  // 房间自己的密码生效；⚠️ 安全修复后密码**本身不再放行** —— 必须先经
  // /auth/token 翻译成签名会话令牌（旧「直接当 Bearer」就是评审指出的那个洞）。
  check('房间密码 required=true', resolveRoomAuth(env, 'vault').required, true);
  const vaultSession = await issueRoomSessionToken(env, 'vault', 3600, '');
  check('房间密码换的会话令牌放行', await canAccessRoomAsync(env, 'vault', vaultSession), true);
  check('全局密码换的会话令牌对房间有效', await canAccessRoomAsync(env, 'vault', await issueRoomSessionToken(env, 'vault', 3600, 'global')), true);
  check('密码本身不再放行（安全修复）', await canAccessRoomAsync(env, 'vault', 'vaultpw'), false);
  check('错密码换不到令牌 → 无凭据不放行', await canAccessRoomAsync(env, 'vault', 'nope'), false);

  // 空字符串 = 只接受全局密码（旧语义，没变）
  check('空字符串回落全局密码', resolveRoomAuth(env, 'legacy-empty').password, 'global-pw');

  // 没配过的房间也回落全局密码
  check('没配过的房间继承全局密码', resolveRoomAuth(env, 'never-configured').password, 'global-pw');

  // open + password 同时给 = 配置写错 → 按**需要密码**处理（不能因为多打一个字段把房间敞开）
  check('open+password 按需要密码处理', resolveRoomAuth(env, 'contradiction').required, true);
  check('open+password 空凭据不放行', await canAccessRoomAsync(env, 'contradiction', ''), false);
}


summary('房间鉴权在 Worker 上成立');
