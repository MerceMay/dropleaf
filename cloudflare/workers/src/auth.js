import { errorResponse } from './errors';

/**
 * 会话 Cookie 名。签发/续签响应会 Set 这个 Cookie（HttpOnly、SameSite=Lax），
 * 让 <img>/<video> 这类浏览器自发请求在**同源部署**下无需 URL 令牌即可通过鉴权。
 */
export const SESSION_COOKIE_NAME = 'paste_session';

/**
 * 构造会话 Cookie 的 Set-Cookie 头值。http（本地 dev）不带 Secure —— 带了浏览器会拒收。
 * maxAge 为 0 时表示清除（登出/会话确认失效时把 Cookie 也抹掉）。
 */
export function buildSessionCookie(token, { maxAgeSeconds, request } = {}) {
  const secure = request && new URL(request.url).protocol === 'https:' ? ' Secure;' : '';
  const maxAge = Number.isFinite(maxAgeSeconds) && maxAgeSeconds >= 0 ? Math.floor(maxAgeSeconds) : 0;
  return `${SESSION_COOKIE_NAME}=${token || ''}; Path=/; HttpOnly; SameSite=Lax;${secure} Max-Age=${maxAge}`;
}
function textToBytes(text) {
  return new TextEncoder().encode(text);
}

function bytesToBase64Url(bytes) {
  return btoa(String.fromCharCode.apply(null, bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '');
}

function base64UrlToBytes(str) {
  const padded = str + '==='.slice(0, (4 - str.length % 4) % 4);
  const binary = atob(padded.replace(/-/g, '+').replace(/_/g, '/'));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

async function sha256(data) {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', data));
}

export function normalizeRoomName(room = '') {
  const normalized = String(room || '').trim();
  return normalized === '' || normalized === 'default' ? 'default' : normalized;
}

/**
 * 提取请求凭据。解析顺序：Authorization 头 → Cookie → ?auth=（query 兜底）。
 *
 * ⚠️★ `allowCookie`（安全修复 2026-11-05 复审）：会话 Cookie 是**环境凭据** ——
 * 浏览器对同站（含其它子域）的请求会自动带上它，而 `SameSite=Lax` 只拦跨站，
 * 拦不住 `evil.example.com` 用表单 POST 打 `api.example.com`。所以 Cookie 只允许
 * 用于**安全方法**（GET/HEAD：图片预览、下载、列表读取）；写操作必须用
 * Authorization 头（跨站表单设不了）或显式 `?auth=` 令牌。
 * 写路径的调用方传 `{ allowCookie: false }`。
 */
export function extractAuthToken(request, { allowCookie = true } = {}) {
  const authHeader = request.headers.get('Authorization');
  if (authHeader) {
    const parts = authHeader.split(' ');
    if (parts.length === 2 && parts[0].toLowerCase() === 'bearer') {
      return parts[1];
    }
    return authHeader;
  }

  // 会话 Cookie（HttpOnly）：同源部署下 <img>/<video>/<a download> 这些**浏览器自发**
  // 的请求带不了 Authorization 头，靠它通过鉴权 —— 预览地址因此不再需要 ?auth= 令牌。
  if (allowCookie) {
    const cookie = request.headers.get('Cookie');
    if (cookie) {
      for (const part of cookie.split(';')) {
        const eq = part.indexOf('=');
        if (eq > 0 && part.slice(0, eq).trim() === SESSION_COOKIE_NAME) {
          const value = part.slice(eq + 1).trim();
          if (value) return value;
        }
      }
    }
  }

  return new URL(request.url).searchParams.get('auth') || '';
}

/** 方法是否属于「安全方法」（不改服务端状态）。 */
export function isSafeMethod(method = 'GET') {
  const normalized = String(method || 'GET').toUpperCase();
  return normalized === 'GET' || normalized === 'HEAD';
}

// 提取 WebSocket 握手使用的 token。
//
// ⚠️★ **握手不接受 Cookie**（安全修复 2026-11-05 第二轮复审）：WS 升级是 GET 请求，
// 浏览器对同站（含**其它子域**）发起的连接会自动带上会话 Cookie —— 那样任何同站
// 子域的页面都能凭环境凭据订阅实时草稿。凭据来源因此只留**显式**的三种：
// Authorization 头 → ?auth= → Sec-WebSocket-Protocol 子协议（前端 connect() 用的
// 就是子协议，见 wsStore.ts）。跨 Origin 的 Cookie 握手在鉴权层直接 401。
export function extractWebSocketToken(request) {
  const token = extractAuthToken(request, { allowCookie: false });
  if (token) {
    return token;
  }

  const protocols = request.headers.get('Sec-WebSocket-Protocol') || '';
  for (const protocol of protocols.split(',')) {
    const normalized = protocol.trim();
    if (normalized) {
      return normalized;
    }
  }
  return '';
}

export function extractAuthTokens(request) {
  const tokens = [];
  const pushToken = value => {
    const normalized = normalizeAuthValue(value);
    if (normalized && !tokens.includes(normalized)) {
      tokens.push(normalized);
    }
  };

  pushToken(extractAuthToken(request));

  const extraHeader = request.headers.get('X-Room-Auth-Tokens');
  if (!extraHeader) {
    return tokens;
  }

  try {
    const parsed = JSON.parse(extraHeader);
    if (Array.isArray(parsed)) {
      parsed.forEach(pushToken);
    }
  } catch {
    extraHeader.split(',').forEach(pushToken);
  }

  return tokens;
}

export function normalizeAuthValue(value) {
  if (value === undefined || value === null || value === false) {
    return '';
  }

  if (typeof value === 'string') {
    return value.trim();
  }

  if (typeof value === 'number' && !Number.isFinite(value)) {
    return '';
  }

  return String(value);
}

// 解析房间配置里的 fileExpire 字段：
//   未定义 -> undefined（使用全局 FILE_EXPIRE）
//   0      -> 0（该房间文件永不过期）
//   >0     -> 覆盖全局过期秒数
//   其它    -> 视为非法配置，回退全局值并告警
function parseFileExpireValue(room, value) {
  if (value === undefined || value === null || value === false) {
    return undefined;
  }
  const numeric = typeof value === 'number' ? value : Number(String(value).trim());
  if (Number.isFinite(numeric) && numeric >= 0) {
    return Math.floor(numeric);
  }
  console.warn(`ROOM_AUTH_JSON 配置警告: 房间 '${room}' 的 fileExpire 非法 (${JSON.stringify(value)})，已回退为全局 FILE_EXPIRE`);
  return undefined;
}

// 单个房间的 ROOM_AUTH_JSON 值支持三种形式：
//   字符串/数字                    -> 仅密码（旧格式，完全兼容）
//   对象 {password, fileExpire}    -> 密码 + 文件过期覆盖策略
//   对象 {open: true, fileExpire}  -> **开放房间**：不要密码，即使全局 AUTH_PASSWORD 设了也一样
//
// `open` 单独一个字段、而不是拿「空密码」当信号：空字符串在这份配置里**已经有含义**
// （只接受全局密码，见 config.md），改掉它会静默改变现有配置 —— 某个房间会悄悄敞开。
// 与 Go 侧 RoomAuthEntry 同一套语义，改一边记得改另一边。
function parseRoomAuthEntry(room, value) {
  if (value !== null && typeof value === 'object') {
    return {
      password: normalizeAuthValue(value.password),
      fileExpire: parseFileExpireValue(room, value.fileExpire),
      open: value.open === true,
    };
  }
  return { password: normalizeAuthValue(value), fileExpire: undefined, open: false };
}

export function parseRoomAuth(env) {
  const roomAuth = env.ROOM_AUTH_JSON;
  if (!roomAuth) {
    return {};
  }

  const reduce = entries => entries.reduce((acc, [room, value]) => {
    acc[normalizeRoomName(room)] = parseRoomAuthEntry(room, value);
    return acc;
  }, {});

  if (typeof roomAuth === 'object') {
    return reduce(Object.entries(roomAuth));
  }

  try {
    const parsed = JSON.parse(roomAuth);
    if (!parsed || typeof parsed !== 'object') {
      return {};
    }

    return reduce(Object.entries(parsed));
  } catch (error) {
    console.error('ROOM_AUTH_JSON 解析失败:', error);
    return {};
  }
}

export function resolveRoomAuth(env, room) {
  const normalizedRoom = normalizeRoomName(room);
  const globalPassword = normalizeAuthValue(env.AUTH_PASSWORD);
  const roomAuth = parseRoomAuth(env);
  const hasRoomEntry = Object.prototype.hasOwnProperty.call(roomAuth, normalizedRoom);
  const entry = hasRoomEntry ? roomAuth[normalizedRoom] : { password: '', fileExpire: undefined, open: false };
  const roomPassword = entry.password;

  // 房间自己带密码 → 用它。全局密码**仍然有效**（见 tokenMatchesRoom），
  // 所以 ROOM_AUTH_JSON 是「多给一把钥匙」，不是「换锁」。
  // ⚠️ 同时写了 open 和 password 是配置写错了：**密码优先** —— 宁可多要一次密码，
  // 也不能因为配置里多打了一个字段就把房间敞开。
  if (roomPassword) {
    return { room: normalizedRoom, required: true, password: roomPassword, fileExpire: entry.fileExpire };
  }

  // 显式开放：**不**回落 AUTH_PASSWORD。这就是「全局加密 + 个别房间开放」的表达方式。
  if (hasRoomEntry && entry.open) {
    return { room: normalizedRoom, required: false, password: '', fileExpire: entry.fileExpire };
  }

  // 没配过、或配了个空密码 → 回落全局密码（旧行为，别改回去）。
  if (globalPassword) {
    return { room: normalizedRoom, required: true, password: globalPassword, fileExpire: entry.fileExpire };
  }

  return { room: normalizedRoom, required: false, password: '', fileExpire: entry.fileExpire };
}

export function tokenMatchesRoom(env, room, token) {
  const normalizedToken = normalizeAuthValue(token);
  if (!normalizedToken) {
    return false;
  }

  const globalPassword = normalizeAuthValue(env.AUTH_PASSWORD);
  if (globalPassword && normalizedToken === globalPassword) {
    return true;
  }

  const normalizedRoom = normalizeRoomName(room);
  const roomAuth = parseRoomAuth(env);
  const roomPassword = Object.prototype.hasOwnProperty.call(roomAuth, normalizedRoom)
    ? roomAuth[normalizedRoom].password
    : '';

  return !!roomPassword && normalizedToken === roomPassword;
}

export function canAccessRoom(env, room, token) {
  const requirement = resolveRoomAuth(env, room);
  if (!requirement.required) {
    return true;
  }

  return tokenMatchesRoom(env, room, token);
}

export async function canAccessRoomAsync(env, room, token) {
  const requirement = resolveRoomAuth(env, room);
  if (!requirement.required) {
    return true;
  }

  // ⚠️★ 只认**签名会话令牌**（2026-11-05 安全修复）：密码本身不再是有效 Bearer。
  // 旧行为（tokenMatchesRoom 兜底）= 示例密码写在公开模板里、直接当 Bearer 就能读
  // 草稿/附件 —— 密码只应在 POST /auth/token 换会话令牌那一条路上被接受。
  // 同步版 canAccessRoom 保留密码比对：它只有 /auth/token 一个调用方（登录端点本身）。
  // ⚠️ 三态：这里（/server 的 authorized 探测）把「判不了」折成 false ——
  // 探测语义是「现在能不能进」，判不了就不该进；UI 会显示离线/需要重新验证。
  const result = await validateRoomSessionToken(env, room, token);
  return result === SESSION_OK;
}

// ⚠️ 这里曾经有个 hasRoomAuthEntry（「配置里有没有这一项」）。它和「这个房间要不要密码」
// **不是一回事**：显式 `{open: true}` 的房间在配置里有这一项，但**不要**密码。
// 两个调用点（/server 的 roomProtected、/rooms 的 isProtected）都改成
// resolveRoomAuth(...).required 之后它就没人用了，删掉。

export async function ensureRoomAccess(request, env, room, tokenOverride, { allowCookie } = {}) {
  const normalizedRoom = normalizeRoomName(room);
  const requirement = resolveRoomAuth(env, normalizedRoom);
  // ⚠️★ Cookie 只对安全方法生效（安全修复 2026-11-05 复审）：写操作（POST/PUT/DELETE）
  // 必须带 Authorization 头或显式 ?auth= —— 同站其它子域的表单请求带不了头，
  // 于是 `POST /revoke/all` 这类「清空历史」的跨子域 CSRF 直接被挡在鉴权这一层。
  //
  // ⚠️★ WebSocket 握手虽然也是 GET，但**必须显式传 allowCookie: false**
  // （第二轮复审 P1）：Cookie 是环境凭据，同站任意子域的页面都能自动带上它去订阅
  // 实时草稿；WS 的凭据只认显式令牌（头 / ?auth= / 子协议）。
  const cookieAllowed = allowCookie === undefined
    ? isSafeMethod(request.method)
    : allowCookie === true && isSafeMethod(request.method);
  const token = tokenOverride || extractAuthToken(request, { allowCookie: cookieAllowed });

  if (!requirement.required) {
    return { ok: true, room: normalizedRoom, token, requirement };
  }

  if (!token) {
    return {
      ok: false,
      room: normalizedRoom,
      token,
      requirement,
      response: errorResponse(401, 'unauthorized', 'Unauthorized', '需要认证令牌'),
    };
  }

  // ⚠️★ 同上：业务 API 只认签名会话令牌，密码不是 Bearer（安全修复 2026-11-05）
  const verdict = await validateRoomSessionToken(env, normalizedRoom, token);
  if (verdict === EPOCH_UNAVAILABLE) {
    // ⚠️★ 第三轮复审 P1：纪元读不出来 = **无法判定**，必须拒绝但不是 401 ——
    // 401 会把用户踢回登录页（他们手里的是有效令牌，只是服务器暂时判不了）。
    // 503：客户端保留状态稍后重试；令牌没有因此失效。
    return {
      ok: false,
      room: normalizedRoom,
      token,
      requirement,
      response: errorResponse(503, 'epoch_unavailable', 'Session state unavailable, retry', '会话状态暂不可用，请稍后重试'),
    };
  }
  if (verdict === SESSION_OK) {
    return { ok: true, room: normalizedRoom, token, requirement };
  }

  return {
    ok: false,
    room: normalizedRoom,
    token,
    requirement,
    response: errorResponse(401, 'unauthorized_invalid_token', 'Unauthorized', '无效的认证令牌'),
  };
}


/**
 * 会话纪元（session epoch）——「退出登录」能真正生效的最小服务端状态。
 *
 * ⚠️ 令牌是**无状态 HMAC**（签名载荷 + 过期时间），服务端默认没有「作废某张令牌」
 * 的能力：用户退出后，那张被抄走的令牌仍能用满 7 天。这在单人剪贴板上是实打实的
 * 缺口 —— 退出应当**让所有已发出的令牌一起失效**。
 *
 * 做法：D1 里存一个整数（`app_state` 表，key=session_epoch）。签发时把当前值写进
 * claims.ver；校验时要求 claims.ver === 当前值。退出登录 = 把该值 +1，于是所有
 * 旧令牌立刻作废，不需要逐张存表（也就没有「令牌表无限增长」）。
 *
 * 降级语义：没有 D1（单元测试的极简 env）或读表失败时按 0 处理 —— 行为退回到
 * 「只靠过期时间」，而不是把所有人锁在门外。
 */
/**
 * 纪元校验的三态结果（第三轮复审 P1）：
 *   · SESSION_OK       —— 令牌有效；
 *   · SESSION_STALE    —— 签名/exp/纪元不匹配：**确定**已失效；
 *   · EPOCH_UNAVAILABLE —— 纪元读不出来（D1 故障）：**无法判定**。
 *
 * ⚠️★ 为什么不能用「读失败 = 0」：0 只对「开放实例 / 尚无记录」成立。对**已有**
 * 撤销历史的实例，读失败时把纪元当 0 会让所有 ver ≥ 0 的旧令牌「重新有效」
 * —— 复审实测：已退出的令牌重新通过鉴权、旧 WS 收到新草稿。
 * 读不出来 = 判不了，必须显式上抛，由调用方决定「拒」还是「暂缓」。
 */
export const SESSION_OK = 'ok';
export const SESSION_STALE = 'stale';
export const EPOCH_UNAVAILABLE = 'epoch_unavailable';

const SESSION_EPOCH_KEY = 'session_epoch';

async function ensureAppStateTable(db) {
  try {
    await db
      .prepare('CREATE TABLE IF NOT EXISTS app_state (key TEXT PRIMARY KEY, value TEXT NOT NULL)')
      .run();
  } catch {
    /* 只读/无权限：跳过纪元，退化为纯过期时间 */
  }
}

// 纪元缓存的存活时间。
//
// ⚠️★ 复审教训（2026-11-05）：最初把纪元缓存在 `env.__sessionEpoch` 上**永不过期**。
// Worker 里 env 是**每请求**一份，没问题；但 Durable Object 的 env 是**长期持有**的 ——
// DO 内的令牌复验会一直读到退出登录之前的旧纪元，旧连接永远有效。所以缓存必须有
// 上界：正常请求里一份 env 只活一个请求（照样只读一次库），DO 里最多陈旧这么久。
// 退出登录的**即时**失效不靠这里：logout 会直接通知 DO 关闭旧连接（见 index.js）。
const SESSION_EPOCH_CACHE_MS = 5000;

export async function getSessionEpoch(env, { fresh = false } = {}) {
  if (!env || !env.DB) {
    return 0;
  }
  // 单次请求内多处校验（WS 转发 + 业务接口）没必要各读一次库。
  // ⚠️ DO 的广播复验传 fresh: true —— DO 的 env 长期持有，缓存会让撤销晚 5s 生效；
  // 通知失败时那 5s 就是「旧连接又收到一条草稿」的窗口。
  if (
    !fresh
    && env.__sessionEpoch !== undefined
    && Date.now() - (env.__sessionEpochAt || 0) < SESSION_EPOCH_CACHE_MS
  ) {
    return env.__sessionEpoch;
  }
  await ensureAppStateTable(env.DB);
  let row;
  try {
    row = await env.DB.prepare('SELECT value FROM app_state WHERE key = ?')
      .bind(SESSION_EPOCH_KEY)
      .first();
  } catch (error) {
    // ⚠️★ 第三轮复审 P1：读失败**不能**当 0 —— 那会让已撤销的令牌重新有效
    // （ver ≥ 0 全部匹配）。必须上抛，让调用方「拒（HTTP）/ 暂缓（广播）」。
    // 同步清掉缓存：此刻缓存里的值也未必可信（比如表还没建出来的窗口）。
    delete env.__sessionEpoch;
    delete env.__sessionEpochAt;
    throw error;
  }
  // row 为 null = 查询**成功**但尚无记录 —— 这是合法状态（从未退出过），纪元就是 0。
  env.__sessionEpoch = row ? Number(row.value) || 0 : 0;
  env.__sessionEpochAt = Date.now();
  return env.__sessionEpoch;
}

/**
 * 纪元 **原子** +1（第二轮复审 P1）。
 *
 * ⚠️★ 旧实现是「读缓存 → +1 → 写回绝对值」：两个并发 logout 都读到同一个旧值、
 * 都写回 1 —— 第二个请求等于没推进，其间签发的令牌在第二次退出后仍然有效。
 * 现在用单条 UPSERT 原子递增（`value = value + 1`，D1 支持 RETURNING），
 * 并发下每个请求拿到**不同的**新值；读写都**绕过缓存**（缓存只用于校验路径的
 * 快速读，绝不参与读改写）。
 *
 * 失败（写不进 D1）时 throw：调用方（logout）据此回 503，**不能**静默返回旧值
 * —— 那样客户端会以为退出成功而纪元根本没动。
 */
export async function bumpSessionEpoch(env) {
  if (!env || !env.DB) {
    return 0;
  }
  await ensureAppStateTable(env.DB);
  const result = await env.DB.prepare(
    `INSERT INTO app_state (key, value) VALUES (?, '1')
     ON CONFLICT(key) DO UPDATE SET value = CAST(CAST(value AS INTEGER) + 1 AS TEXT)
     RETURNING value`,
  )
    .bind(SESSION_EPOCH_KEY)
    .first();
  const next = Number(result?.value || 0);
  if (!next) {
    throw new Error('session epoch bump failed');
  }
  // 同步刷新本 env 的校验缓存（不是读改写的一部分，只是让后续校验立即生效）
  env.__sessionEpoch = next;
  env.__sessionEpochAt = Date.now();
  return next;
}

async function getRoomSessionSigningKey(env) {
  const material = [];
  material.push('clip9-room-session-v1');
  
  const globalPassword = normalizeAuthValue(env.AUTH_PASSWORD);
  if (globalPassword) {
    material.push(globalPassword);
  }

  const roomAuth = parseRoomAuth(env);
  const rooms = Object.keys(roomAuth).sort();
  for (const room of rooms) {
    material.push(room);
    // parseRoomAuth 给的是 {password, fileExpire} 对象，不是字符串。
    // 直接 normalizeAuthValue(roomAuth[room]) 会 String() 成 '[object Object]'，
    // 房间密码等于没进密钥材料 —— 只设房间密码（没设 AUTH_PASSWORD / ROOM_SESSION_SECRET）时
    // 密钥就完全可预测，任何人都能自己签一个 scope=global 的会话令牌绕过所有房间密码。
    material.push(normalizeAuthValue(roomAuth[room].password));
  }

  if (env.ROOM_SESSION_SECRET) {
    material.push(String(env.ROOM_SESSION_SECRET));
  }

  const keyMaterial = textToBytes(material.join('\x00'));
  const keyHash = await sha256(keyMaterial);

  return crypto.subtle.importKey(
    'raw',
    keyHash,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify'],
  );
}

export async function issueRoomSessionToken(env, room, ttlSeconds = 7 * 24 * 60 * 60, scope = '') {
  const normalizedRoom = normalizeRoomName(room);

  // 夹一次 TTL。⚠️ 上限（30 天）比默认值（7 天）宽，理由与自建服务端
  // `clip9_core::clamp_session_ttl` 完全一致：默认值决定「不特别说明时签多久」，
  // 上限只拦「把天数当秒数传进来」那一类手滑。别把两个数合并成一个。
  const validTtl = Math.max(60, Math.min(ttlSeconds, 30 * 24 * 60 * 60));

  const now = Math.floor(Date.now() / 1000);
  // ver = 签发时的会话纪元。退出登录会把纪元 +1，于是**所有**旧令牌一起失效。
  const epoch = await getSessionEpoch(env);
  const claims = {
    typ: 'room_session',
    room: normalizedRoom,
    exp: now + validTtl,
    ver: epoch,
  };
  // scope: ""=房间专属, "global"=全局所有房间
  if (scope === 'global') {
    claims.scope = 'global';
  }

  const payload = bytesToBase64Url(textToBytes(JSON.stringify(claims)));
  const key = await getRoomSessionSigningKey(env);
  const signature = await crypto.subtle.sign('HMAC', key, textToBytes(payload));
  
  return `${payload}.${bytesToBase64Url(new Uint8Array(signature))}`;
}

// 解析并校验会话令牌（不含房间匹配），返回 claims；无效返回 null
export async function parseRoomSessionToken(env, token) {
  const normalized = String(token || '').trim();
  if (!normalized) {
    return null;
  }

  const parts = normalized.split('.');
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    return null;
  }

  try {
    const key = await getRoomSessionSigningKey(env);
    const valid = await crypto.subtle.verify(
      'HMAC',
      key,
      base64UrlToBytes(parts[1]),
      textToBytes(parts[0]),
    );

    if (!valid) {
      return null;
    }

    const claimsBytes = base64UrlToBytes(parts[0]);
    const claimsText = new TextDecoder().decode(claimsBytes);
    const claims = JSON.parse(claimsText);

    if (claims.typ !== 'room_session') {
      return null;
    }

    if (!claims.exp || claims.exp < Math.floor(Date.now() / 1000)) {
      return null;
    }

    return claims;
  } catch (error) {
    console.error('Failed to parse room session token:', error);
    return null;
  }
}

/**
 * 会话令牌校验 —— **三态**（第三轮复审 P1）。
 *
 * 返回值：
 *   · SESSION_OK          令牌有效；
 *   · SESSION_STALE       签名/exp/房间/纪元任一不成立 —— **确定**失效；
 *   · EPOCH_UNAVAILABLE   纪元读不出来（D1 故障）—— **无法判定**。
 *
 * ⚠️ 三态是安全语义的核心：把「读不到」折进 false（拒绝）会误伤 —— D1 抖一下，
 * 所有在线设备被踢回登录页；折进 true（放行）就是复审的洞 —— 已撤销令牌复活。
 * 唯一正确的方向是**显式区分**，由调用方按各自的风险模型处置：
 *   · HTTP 业务接口：拒（503，可重试）—— 单次请求失败无状态损伤；
 *   · WebSocket 复验：暂缓本次广播、保留连接 —— 连接是长生命周期资产，
 *     因一次抖动关掉它代价不对称；读库恢复后下一次广播自然重新验证。
 */
export async function validateRoomSessionToken(env, room, token, { epoch } = {}) {
  const claims = await parseRoomSessionToken(env, token);
  if (!claims) {
    return SESSION_STALE;
  }
  // 退出登录 = 纪元 +1：旧令牌（ver 更小）立刻作废，不必等到期。
  // 没带 ver 的令牌来自更早的构建，同样按「已退出」处理。
  //
  // ⚠️ 可以传入**已读好的** epoch（DO 广播复验：一次广播只读一次库，
  // 再分给每个会话），没传就按常规（带 5s 缓存）读。
  let currentEpoch;
  if (epoch === undefined) {
    try {
      currentEpoch = await getSessionEpoch(env);
    } catch {
      // D1 读失败：无法判定，显式上抛 sentinel（不是布尔！）
      return EPOCH_UNAVAILABLE;
    }
  } else {
    currentEpoch = Number(epoch);
  }
  if (Number(claims.ver) !== currentEpoch) {
    return SESSION_STALE;
  }

  const normalizedRoom = normalizeRoomName(room);
  // 全局会话令牌对所有房间有效
  if (claims.scope === 'global') {
    return SESSION_OK;
  }

  if (!claims.room || normalizeRoomName(claims.room) !== normalizedRoom) {
    return SESSION_STALE;
  }

  return SESSION_OK;
}
