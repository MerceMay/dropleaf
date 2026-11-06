import { EPOCH_UNAVAILABLE, SESSION_STALE, getSessionEpoch, normalizeRoomName, parseRoomSessionToken, resolveRoomAuth, validateRoomSessionToken } from '../auth';
import { historyLimit, parseUserAgent, sanitizeDeviceName } from '../utils';

function isRoomListEnabled(env) {
  return ['1', 'true', 'yes', 'on'].includes(String(env.ROOM_LIST || '').toLowerCase());
}

// 在线会话视为活跃的最大间隔（超过则视为离开），与前端 30s 心跳配合
const PRESENCE_TTL_MS = 120 * 1000;
// 清理任务的调度间隔
const PRESENCE_CLEAN_INTERVAL_MS = 60 * 1000;
// 同一会话写 D1 的最小间隔（节流心跳 30s 带来的频繁写入）
const PRESENCE_WRITE_INTERVAL_MS = 120 * 1000;

export class WebSocketRoom {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.sessions = new Map();
    // 复验已判定失效、但 close 还没落地的会话：广播对它们一律跳过
    // （第二轮复审 P1 —— 60s 节流不能盖住「刚验过就退出」的窗口）。
    this.revokingSessions = new Set();
    console.log('WebSocketRoom 实例创建');
    // 安排周期性的残留在线状态清理
    this.state.blockConcurrencyWhile(() => this.schedulePresenceCleanup());
  }

  async fetch(request) {
    const url = new URL(request.url);
    
    console.log(`WebSocketRoom fetch: ${url.pathname}`);
    
    // 处理广播消息的内部请求
    if (url.pathname === '/broadcast') {
      try {
        const message = await request.json();
        // ⚠️ 复验要**等**完再投递（安全修复 2026-11-05 复审）：以前是
        // `this.broadcast()` 内部 fire-and-forget，撤销决定还没回来就已经 send 出去了。
        const result = await this.broadcast(message);
        // ⚠️★ 第四轮复审 P2：被推迟的广播要如实告知（以前一律回 "OK"，调用方
        // 以为已投递）。客户端不重试也没关系 —— 恢复后 DO 会主动补一条 resync。
        return Response.json({ ok: true, deferred: Boolean(result?.deferred) });
      } catch (error) {
        console.error('广播消息处理错误:', error);
        return new Response('Broadcast Error', { status: 500 });
      }
    }

    // 退出登录的即时通知（安全修复 2026-11-05 复审）：Worker 把纪元 +1 之后
    // 直接喊这里，**同步**关掉所有 ver 小于新纪元的连接 —— 不等 5s 的纪元缓存过期，
    // 也不等下一次广播的周期性复验。DO 的输入门保证：这条处理完之前后续广播排队。
    if (url.pathname === '/revoke-sessions') {
      try {
        const body = await request.json().catch(() => ({}));
        const closed = await this.revokeSessionsBefore(Number(body.epoch) || 0);
        return Response.json({ closed });
      } catch (error) {
        console.error('撤销会话失败:', error);
        return new Response('Revoke Error', { status: 500 });
      }
    }

    if (url.pathname === '/stats') {
      return Response.json(this.getRoomStats());
    }

    // 处理 WebSocket 升级请求
    const upgradeHeader = request.headers.get('Upgrade');
    if (upgradeHeader && upgradeHeader.toLowerCase() === 'websocket') {
      return this.handleWebSocket(request);
    }

    return new Response('Expected WebSocket', { status: 400 });
  }

  async handleWebSocket(request) {
    try {
      console.log('开始处理 WebSocket 升级');
      
      // 创建 WebSocket 对
      const webSocketPair = new WebSocketPair();
      const [client, server] = Object.values(webSocketPair);
      
      const url = new URL(request.url);
      const sessionId = this.generateSessionId();
      const userAgent = request.headers.get('User-Agent') || '';
      const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
      const room = normalizeRoomName(url.searchParams.get('room'));
      this.roomName = this.roomName || room;

      console.log(`创建 WebSocket 会话: ${sessionId}, room: ${room}, ip: ${ip}`);

      const session = {
        webSocket: server,
        sessionId,
        userAgent,
        ip,
        room: room,
        connectedAt: Date.now(),
        lastPresenceTouchedAt: 0,
        // 会话令牌（安全修复 2026-11-05）：升级握手时 Worker 已验证过一次，
        // 这里留存用于**周期性复验**——过期/改密码（签名密钥派生自密码）后广播
        // 时不再向该连接投递，并主动关闭。见 validateSessionTokens()。
        token: url.searchParams.get('session') || '',
        tokenCheckedAt: 0,
      };

      this.sessions.set(sessionId, session);
      await this.persistSessionPresence(session);

      // 接受 WebSocket 连接
      server.accept();
      
      console.log(`WebSocket 连接已建立: ${sessionId}`);
      
      // 设置事件监听器
      server.addEventListener('message', (event) => {
        this.handleMessage(sessionId, event);
      });

      server.addEventListener('close', (event) => {
        this.handleClose(sessionId, event);
      });

      server.addEventListener('error', (event) => {
        this.handleError(sessionId, event);
      });

      // 握手载荷的发送顺序抽在 sendHandshake 里（历史不再由 WS 推，见那里的注释）。
      await this.sendHandshake(server, room, sessionId);

      // 广播新设备连接
      this.broadcastDeviceConnect(sessionId, userAgent, room);

      console.log(`WebSocket 会话 ${sessionId} 初始化完成`);

      // 回显客户端通过 Sec-WebSocket-Protocol 子协议提供的 token，避免 token 出现在 URL/访问日志中。
      // 浏览器要求服务端必须回选一个子协议，否则握手会被判定失败。
      const response = new Response(null, {
        status: 101,
        webSocket: client,
      });
      const requestedProtocols = request.headers.get('Sec-WebSocket-Protocol');
      if (requestedProtocols) {
        const subprotocol = requestedProtocols.split(',')[0].trim();
        if (subprotocol) {
          response.headers.set('Sec-WebSocket-Protocol', subprotocol);
        }
      }
      return response;

    } catch (error) {
      console.error('WebSocket 升级失败:', error);
      return new Response('WebSocket Upgrade Failed', { 
        status: 500 
      });
    }
  }

  // 握手时依次发：config → 房间里已有的设备。
  //
  // ⚠️★ **顺序是契约，不是碰巧**（`dev-docs/specs/ws-live-only.md` §2.2）：
  // `config` 事件**必须**在实时之前发 —— 客户端在拿到 `config.latestId` 之前
  // **一条都不该写剪贴板**（它要用那个 id 对齐「HTTP 取回的历史」与「WS 推来的实时」）。
  // 别为了首屏快一点把 config 挪到后面去。
  //
  // ⚠️★ **握手不再推历史**（Jonny 2026-09-26：「没有老客户端，不用考虑老客户端」）。
  // 历史改由客户端自己去 `GET /content` 拿；原来那个 `?history=0` 开关也一并删掉
  // （默认就是不推，它与默认同义，留着只会是一处会漂的冗余）。
  //
  // ⚠️ 抽成独立方法（而不是写在 handleWebSocket 里）是为了**能测**：handleWebSocket
  // 需要真的 `WebSocketPair`，Node 里造不出来；而这一段的全部输入只是
  // 「一个能 send 的对象 + 一个房间名」。
  async sendHandshake(webSocket, room, sessionId) {
    // ⚠️ 水印要在**发 config 之前**取：它是「连接时刻」的快照，客户端拿它对齐
    // 「HTTP 取回的历史」与「WS 推来的实时」的边界。晚于 config 就已经没意义了。
    const latestId = await this.latestMessageId(room);

    await this.sendConfigMessage(webSocket, room, latestId);
    await this.sendExistingDevices(webSocket, room, sessionId);
  }

  // 连接时刻该房间的**最大消息 id**（没有消息时 `0`）—— 客户端拿它对边界。
  //
  // ⚠️★ **它现在的职责**：客户端是**自己去 `GET /content` 拿历史**的，而「HTTP 取历史」
  // 与「WS 收实时」之间有个**时序窗口** —— 请求返回之前可能已经推来几条实时消息。
  // 有了 `latestId`，客户端才能对齐那条边界：`id <= latestId` 只当历史认领（**不写剪贴板**），
  // `id > latestId` 才是实时。少了它，边界上的消息会被处理两次（或把历史灌进剪贴板）。
  // 它**兼作能力探测信号**：老后端（没有 `/content`、也就没这个字段）不下发它，
  // 新客户端据此退回「靠 WS 推历史」的老路（`dev-docs/specs/ws-live-only.md` §0.4）。
  //
  // ⚠️ 用 `MAX(id)`，不是「取最新那条的 id」：最新那条是按 `timestamp DESC, id DESC` 挑的，
  // 而 `POST /text?id=` **原地改正文**会把 timestamp 往前刷、id 不变 —— 于是它可能给出一个
  // **偏小**的值，而偏小是**不安全**的方向（历史消息会被当成实时、写进剪贴板）。
  async latestMessageId(room) {
    if (!this.env.DB) {
      return 0;
    }
    try {
      const row = await this.env.DB.prepare(
        'SELECT MAX(id) AS latestId FROM messages WHERE room = ?'
      ).bind(normalizeRoomName(room)).first();
      return Number(row?.latestId) || 0;
    } catch (error) {
      // 取不到水印**不是**致命错误：回 `0` 等于告诉客户端「这个后端没法区分历史与实时」，
      // 而客户端对那种后端的行为是**拒绝自动写剪贴板**（fail-safe，见 spec §0.4 / §7 第 11 条）。
      console.error('取水印失败:', error);
      return 0;
    }
  }

  async sendConfigMessage(webSocket, room, latestId = 0) {
    try {
      const fileLimit = parseInt(this.env.FILE_LIMIT) || 104857600;
      // ⚠️★ 这个值会作为 `file.chunk` 下发给客户端，网页端**和桌面端**都按它切片。
      //    R2 的 multipart 要求「除最后一片外每片至少 5 MiB」—— 这里不能回 1 MiB
      //    （桌面端 2026-10-26 之前写死 1 MiB，大文件在 R2 上 500，小文件却正常）。
      //    文件上限 ≤5 MiB 时回 `limit + 1`，让所有能上传的文件都走整份 POST。
      const multipartPartSize = fileLimit > 5 * 1024 * 1024
        ? Math.min(fileLimit, 8 * 1024 * 1024)
        : fileLimit + 1;
      const configMessage = {
        event: 'config',
        data: {
          version: 'cloudflare-worker-v1.0.0',
          server: {
            // ⚠️ 与 WS 推历史、落库裁剪、`GET /content` 的上限是**同一个数**
            // （utils.js 的 historyLimit 一处定义）—— 别在这里手写 parseInt(env.HISTORY_LIMIT)。
            history: historyLimit(this.env),
            prefix: '',
            roomList: isRoomListEnabled(this.env)
          },
          text: {
            limit: parseInt(this.env.TEXT_LIMIT) || 4096
          },
          file: {
            expire: parseInt(this.env.FILE_EXPIRE) || 3600,
            chunk: multipartPartSize,
            limit: fileLimit
          },
          auth: resolveRoomAuth(this.env, room).required,
          // 连接时刻该房间的**最大消息 id**（没有消息时 0）—— 客户端拿它对齐
          // 「HTTP 取回的历史」与「WS 推来的实时」的边界（理由见上面 latestMessageId 那段）。
          // ⚠️★ 它**必须在 WebSocket 握手载荷里**，**不是** `/server` 的 HTTP 响应 ——
          // 前端读的 `app.config` 就是**这条 `config` 事件**（这个坑踩过两次：
          // `automation.enabled`、`prefix`）。加错地方会得到一个永远 `undefined` 的字段。
          latestId,
          // 定时自动化：Worker 侧**没有实现**这一族接口（没有 /tasks、没有 /automation，
          // 也没有进程内调度器）。显式声明 enabled:false，而不是让这个字段干脆缺失 ——
          // SPA 工具栏那个入口正是按它决定渲不渲染（PageToolbar.vue 的 automationEnabled），
          // 而前端读的 `app.config` 就是**这条 config 事件**的载荷（不是 /server 的响应）。
          // 缺失的话，前端分不清「这个后端不支持」和「字段还没送到」。
          // ⚠️ 哪天 Worker 侧真的实现了，记得连同 dev-docs/api*.md §8 的「仅 Go 实现」一起改。
          automation: { enabled: false }
        }
      };
      
      if (webSocket.readyState === WebSocket.OPEN) {
        webSocket.send(JSON.stringify(configMessage));
        console.log(`配置消息已发送`);
      }
      
    } catch (error) {
      console.error('发送配置消息失败:', error);
    }
  }

  async sendExistingDevices(webSocket, room, excludeSessionId) {
    try {
      // 发送房间内现有设备信息
      const existingDevices = [];
      for (const [sessionId, session] of this.sessions) {
        if (sessionId !== excludeSessionId && session.room === room) {
          const deviceInfo = parseUserAgent(session.userAgent);
          existingDevices.push({
            id: sessionId,
            type: deviceInfo.type,
            device: deviceInfo.device,
            os: deviceInfo.os,
            browser: deviceInfo.browser
          });
        }
      }

      for (const deviceMeta of existingDevices) {
        if (webSocket.readyState === WebSocket.OPEN) {
          webSocket.send(JSON.stringify({
            event: 'connect',
            data: deviceMeta
          }));
        }
      }

      console.log(`发送了 ${existingDevices.length} 个现有设备信息`);

    } catch (error) {
      console.error('发送现有设备信息失败:', error);
    }
  }

  handleMessage(sessionId, event) {
    try {
      const session = this.sessions.get(sessionId);
      if (session) {
        // 前端每 30s 发送一次 ping 帧（空心跳已合并进来）；任何消息都视为该会话仍活跃。
        const now = Date.now();
        session.connectedAt = now;
        // 节流：仅当距上次写 D1 超过间隔才落库，避免心跳带来的频繁写入
        if (now - session.lastPresenceTouchedAt >= PRESENCE_WRITE_INTERVAL_MS) {
          session.lastPresenceTouchedAt = now;
          void this.touchSessionPresence(session, now);
        }
      }
      if (event.data && event.data.trim()) {
        console.log(`WebSocket 消息 from ${sessionId}:`, event.data);

        // Web 端延迟测量: 客户端发送 {"event":"ping","data":<clientMs>},
        // 与 Go 后端行为一致，原样回显 data，客户端用 (Date.now()-data) 计算 RTT。
        let parsed;
        try {
          parsed = JSON.parse(event.data);
        } catch {}
        if (parsed && parsed.event === 'ping' && typeof parsed.data === 'number') {
          session.webSocket.send(JSON.stringify({ event: 'pong', data: parsed.data }));
        }
      }
    } catch (error) {
      console.error(`处理消息错误 (${sessionId}):`, error);
    }
  }

  handleClose(sessionId, event) {
    console.log(`WebSocket 会话关闭: ${sessionId}`);
    
    const session = this.sessions.get(sessionId);
    if (session) {
      this.sessions.delete(sessionId);
      void this.removeSessionPresence(sessionId);
      
      // 广播设备断开连接
      this.broadcast({
        event: 'disconnect',
        data: { id: sessionId }
      }, session.room);
    }
  }

  handleError(sessionId, event) {
    console.error(`WebSocket 错误 (${sessionId}):`, event);
    this.sessions.delete(sessionId);
    void this.removeSessionPresence(sessionId);
  }

  broadcastDeviceConnect(sessionId, userAgent, room, deviceName = '') {
    try {
      const deviceInfo = parseUserAgent(userAgent);
      
      const connectMessage = {
        event: 'connect',
        data: {
          id: sessionId,
          type: deviceInfo.type,
          name: sanitizeDeviceName(deviceName),
          device: deviceInfo.device,
          os: deviceInfo.os,
          browser: deviceInfo.browser
        }
      };
      
      void this.broadcast(connectMessage, room, sessionId);
      console.log(`设备连接广播: ${sessionId}`);
      
    } catch (error) {
      console.error('广播设备连接失败:', error);
    }
  }

  async broadcast(message, room = null, excludeSessionId = null) {
    if (!message || typeof message !== 'object') {
      console.error('无效的广播消息:', message);
      return;
    }

    const messageString = JSON.stringify(message);
    const disconnectedSessions = [];
    const targetRoom = room ? normalizeRoomName(room) : null;

    console.log(`广播消息给 ${this.sessions.size} 个会话: ${message.event}`);

    // 投递前复验会话令牌 ——
    // ⚠️ 必须 **await**：撤销结论要先落地，再投递（第一轮复审 P1）。
    //
    // ⚠️★ 第二轮复审 P1：复验判「待撤销」的会话记进 `revokingSessions`：
    // 这个集合里的会话一律不投递，与节流无关。
    //
    // ⚠️★ 第三轮复审 P1：纪元读不出来时**这次广播整条不投递**（连接不动）。
    // 放行 = 已撤销的连接可能收到草稿；拒绝/关闭 = 一次 D1 抖动踢掉所有人。
    //
    // ⚠️★ 第四轮复审 P2（本条）：跳过的消息必须**补送**。否则另一台设备会一直
    // 显示旧草稿，直到下一次更新/重连/刷新。做法：故障期间记下 `missedBroadcasts`，
    // 恢复后的**第一次成功复验**先给所有在线连接补一条 `resync` 信号 ——
    // 客户端收到后重新拉取当前草稿与历史（幂等合并），漏掉的事件由此补齐。
    const verdict = await this.validateSessionTokens();
    if (!verdict?.ok) {
      // 只记「值得补」的事件：实时事件（内容变了）才需要 resync；
      // connect/disconnect/pong/config 这类状态事件不需要。
      const RESYNC_EVENTS = new Set(['draft', 'history-appended', 'receive', 'receiveMulti', 'update', 'revoke', 'clearAll']);
      if (RESYNC_EVENTS.has(message?.event)) {
        this.missedBroadcasts = true;
        // 队列按原始顺序保存事件原文 —— 顺序不能乱（先建后删 vs 先删后建，
        // 客户端最终状态不同）。
        if (this.missedEvents.length < this.maxMissedEvents) {
          // 连房间一起记：重放要按原来的投递范围，不能变成全房间广播。
          this.missedEvents.push({ message, room: targetRoom });
        }
        // ⚠️★ 第四轮复审 P2：补送不能只指望「下一次广播」—— 可能根本没有下一次
        // 编辑。故障期间就把一次复查提前到 ~5s 后（alarm 里会重试复验并补 resync）。
        await this.scheduleResyncRetry();
        console.log(`跳过广播（${message.event}）：会话状态暂不可用；已标记待补送`);
      } else {
        console.log(`跳过广播（${message.event}）：会话状态暂不可用`);
      }
      return { deferred: true };
    }

    // 恢复后的第一条实时消息之前：先**按序重放**故障期间跳过的事件（删除/清空
    // 因此精确生效），再补一条 resync 做整体对账（草稿引擎 + 历史兜底）。
    this.flushMissedEvents(excludeSessionId);

    this.deliver(messageString, targetRoom, excludeSessionId);
    console.log(`广播完成（${message.event}）`);
    return { deferred: false };
  }

  /**
   * 故障恢复：按序重放跳过的事件，再补一条 resync。
   *
   * ⚠️★ 为什么必须重放而不是只 resync：`revoke`（删一条）与 `clearAll`（清空）
   * 是**增量**语义 —— 客户端补拉历史只做合并（只增不减），漏掉的删除用任何
   * 「重拉 + 合并」都补不回来。按序重放事件原文才是精确的。
   * resync 紧随其后：对账草稿引擎，并覆盖队列溢出 / DO 重启等无法重放的情况。
   *
   * @param {string|null} excludeSessionId 原广播的排除会话（重放同样排除，避免自回声）
   */
  flushMissedEvents(excludeSessionId = null) {
    if (!this.missedBroadcasts) {
      return;
    }
    const queued = this.missedEvents;
    this.missedEvents = [];
    this.missedBroadcasts = false;

    for (const entry of queued) {
      try {
        this.deliver(JSON.stringify(entry.message), entry.room ?? null, excludeSessionId);
      } catch (error) {
        console.error('重放跳过的事件失败:', error);
      }
    }
    this.deliver(JSON.stringify({ event: 'resync', data: { reason: 'epoch_outage_recovery' } }), null, excludeSessionId);
    console.log(`会话状态恢复：重放 ${queued.length} 条跳过的事件 + resync`);
  }

  /**
   * 把一条**已 JSON 化**的消息发给目标房间（或全部）会话。
   * 从 broadcast() 抽出来：正常广播、恢复后的 resync 补送共用同一套
   * 「跳过撤销目标 / 清理断开连接」的逻辑。
   */
  deliver(messageString, targetRoom = null, excludeSessionId = null) {
    const disconnectedSessions = [];
    for (const [sessionId, session] of this.sessions) {
      try {
        if (excludeSessionId && sessionId === excludeSessionId) {
          continue;
        }
        if (targetRoom && normalizeRoomName(session.room) !== targetRoom) {
          continue;
        }
        // ⚠️★ 复验已判定「待撤销」的会话：无论节流窗口如何，绝不投递（第二轮复审 P1）。
        if (this.revokingSessions.has(sessionId)) {
          continue;
        }
        if (session.webSocket.readyState === WebSocket.OPEN) {
          session.webSocket.send(messageString);
        } else {
          console.log(`会话 ${sessionId} 已断开，标记清理`);
          disconnectedSessions.push(sessionId);
        }
      } catch (error) {
        console.error(`广播到会话 ${sessionId} 失败:`, error);
        disconnectedSessions.push(sessionId);
      }
    }
    // 清理断开的连接
    for (const sessionId of disconnectedSessions) {
      this.sessions.delete(sessionId);
      void this.removeSessionPresence(sessionId);
    }
    return disconnectedSessions.length;
  }

  generateSessionId() {
    return Math.random().toString(36).substr(2, 9);
  }

  async persistSessionPresence(session) {
    if (!this.env.DB) {
      return;
    }

    try {
      const connectedAt = Math.floor(session.connectedAt / 1000);
      await this.env.DB.prepare(`
        INSERT OR REPLACE INTO room_presence (sessionId, room, connectedAt, userAgent, updatedAt)
        VALUES (?, ?, ?, ?, ?)
      `).bind(
        session.sessionId,
        normalizeRoomName(session.room),
        connectedAt,
        session.userAgent || '',
        connectedAt,
      ).run();
    } catch (error) {
      console.error(`持久化房间在线状态失败 (${session.sessionId}):`, error);
    }
  }

  async removeSessionPresence(sessionId) {
    if (!this.env.DB) {
      return;
    }

    try {
      await this.env.DB.prepare('DELETE FROM room_presence WHERE sessionId = ?').bind(sessionId).run();
    } catch (error) {
      console.error(`删除房间在线状态失败 (${sessionId}):`, error);
    }
  }

  async touchSessionPresence(session, updatedAt) {
    if (!this.env.DB) {
      return;
    }
    try {
      const result = await this.env.DB.prepare('UPDATE room_presence SET updatedAt = ? WHERE sessionId = ?')
        .bind(Math.floor(updatedAt / 1000), session.sessionId)
        .run();
      // ⚠️ 长时间后台/休眠时清理任务会删掉 presence 行；之后的心跳 UPDATE 影响 0 行，
      // 这个会话就在「在线设备」里永久消失（直到重连）。补插回来 —— 心跳降到 30s、
      // 并新增「回到前台立即补一拍」之后，这条路径会真的被走到。
      if (Number(result?.meta?.changes ?? 0) === 0) {
        await this.persistSessionPresence(session);
      }
    } catch (error) {
      console.error(`更新会话活跃时间失败 (${session.sessionId}):`, error);
    }
  }

  async schedulePresenceCleanup() {
    const now = Date.now();
    let existingAlarm = now;
    try {
      existingAlarm = (await this.state.storage.getAlarm()) ?? now;
    } catch (error) {
      console.error('读取已有清理任务失败，将按当前时间重新安排:', error);
    }
    await this.state.storage.setAlarm(Math.max(now, existingAlarm) + PRESENCE_CLEAN_INTERVAL_MS);
  }

  /**
   * 把一次复查提前到 ~5s 后（第四轮复审 P2）。
   *
   * ⚠️ 只在**没有更早的 alarm** 时才改：presence 清理也挂在同一个 alarm 上，
   * 不能因为一次广播把既定清理无限推迟，也不能反过来把复查推到 60s 后。
   */
  async scheduleResyncRetry() {
    try {
      const now = Date.now();
      const target = now + 5000;
      const existing = await this.state.storage.getAlarm();
      if (existing === null || existing > target) {
        await this.state.storage.setAlarm(target);
      }
    } catch (error) {
      console.error('安排 resync 复查失败:', error);
    }
  }

  async alarm() {
    let needsQuickRetry = false;
    // ⚠️ presence 清理失败**不能**连带跳过下面的复验/补送：这两件事曾绑在
    // 同一个 try 里，清理抛错（例如 room_presence 表还没建）就直接进 finally，
    // 于是 resync 永远补不出去。
    try {
      await this.cleanupStalePresence(this.roomName || '');
    } catch (error) {
      console.error('清理残留在线状态失败:', error);
    }
    try {
      // 周期性复验会话令牌：空闲（无广播）时已过期/被吊销的连接也能被及时关闭
      const verdict = await this.validateSessionTokens();
      // ⚠️★ 第四轮复审 P2：故障期间跳过的实时事件在这里补 —— 恢复后即使
      // **没有任何新编辑**，在线客户端也会收到 resync 并重拉草稿/历史。
      if (verdict?.ok && this.missedBroadcasts) {
        this.flushMissedEvents();
        console.log('会话状态恢复：已重放跳过的事件并发送 resync（alarm）');
      } else if (!verdict?.ok && this.missedBroadcasts) {
        // 还没恢复：5s 后再试（不能等满 60s 的 presence 周期）。
        needsQuickRetry = true;
      }
    } catch (error) {
      console.error('alarm 复验失败:', error);
    } finally {
      await this.schedulePresenceCleanup();
      // ⚠️ 必须放在 schedulePresenceCleanup**之后**：它会把 alarm 推到 +60s，
      // 先设 5s 会被覆盖。scheduleResyncRetry 只在「没有更早的 alarm」时才改。
      if (needsQuickRetry) {
        await this.scheduleResyncRetry();
      }
    }
  }

  /**
   * 复验所有会话的令牌（安全修复 2026-11-05，复审加强）。
   *
   * 每个会话至多每 60s 验一次 —— 广播频率高时也不会放大成本。验证失败 =
   * 令牌过期（exp）、签名失效（改密码）或**纪元已推进**（退出登录）→ 立即
   * close(1008) 并清理。
   *
   * ⚠️ 从「fire-and-forget」改成 **await 的 async**：调用方（broadcast）必须等
   * 撤销结论回来再投递，否则已退出的连接照样收得到这一条。
   * 验证异常（D1 抖动）时保守放行、下次再验 —— 不能因为读不到纪元就把所有人踢掉。
   */
  async validateSessionTokens() {
    if (this.sessions.size === 0) {
      return { ok: true, epochUnable: false };
    }
    // ⚠️★ 第二轮复审 P1：
    //   1. **不做 60s 节流** —— 旧实现在「刚验过 30s」的会话上会跳过复验，
    //      退出登录的通知若失败，这些会话就会照常收到下一条广播。
    //   2. **强制读库拿纪元**（fresh: true）—— DO 的 env 长期持有，普通缓存会让
    //      撤销晚 5s 生效；通知失败时这是最后一道闸，必须看到最新值。
    // 代价是每条广播一次 D1 点读 + 每会话一次 HMAC 校验（单用户场景可忽略）。
    // ⚠️★ 第三轮复审 P1：读不到纪元 = **判不了**。既不能放行（已撤销令牌会复活、
    // 旧连接收到新草稿），也不能据此把人踢掉。返回 "暂缓"：调用方（broadcast）
    // 这次**不投递**，连接原样保留；读库恢复后的下一次广播自然重新验证。
    let epoch;
    try {
      epoch = await getSessionEpoch(this.env, { fresh: true });
    } catch {
      console.error('无法读取会话纪元，暂停本次广播');
      return { ok: false, epochUnable: true };
    }
    const checks = [];
    for (const [sessionId, session] of this.sessions) {
      if (!session.token) {
        continue; // 开放实例（无密码）没有令牌可言
      }
      session.tokenCheckedAt = Date.now();
      checks.push(
        validateRoomSessionToken(this.env, session.room, session.token, { epoch })
          .then((verdict) => {
            if (verdict === SESSION_STALE) {
              // 先标记再关：close 的 client 侧事件是异步的，这中间来一条广播也不能投给它。
              this.revokingSessions.add(sessionId);
              this.closeSession(sessionId, 'session revoked');
              this.revokingSessions.delete(sessionId);
            }
          })
          .catch(() => { /* 验证异常时保守放行，下次再验 */ }),
      );
    }
    await Promise.all(checks);
    return { ok: true, epochUnable: false };
  }

  /**
   * 退出登录的即时撤销（复审 P1）：关掉所有 claims.ver < epoch 的连接。
   *
   * 只做签名/解析（parseRoomSessionToken，纯 HMAC，不读 D1）—— 新纪元由调用方
   * 明确传进来，因此不依赖 DO 里那份可能陈旧的 `env.__sessionEpoch`。
   * 无令牌的会话（开放实例）不受影响；解析失败的令牌按「已失效」处理。
   *
   * @returns {number} 被关闭的会话数
   */
  async revokeSessionsBefore(epoch) {
    if (!epoch) {
      return 0;
    }
    let closed = 0;
    for (const [sessionId, session] of this.sessions) {
      if (!session.token) {
        continue;
      }
      // parse 只验签名与 exp；epoch 比对由这里显式做（不读库）
      const claims = await parseRoomSessionToken(this.env, session.token).catch(() => null);
      const ver = claims ? Number(claims.ver) : -1;
      if (!(ver >= epoch)) {
        // 同上：先标记再关，close 落地前的广播也投不进去。
        this.revokingSessions.add(sessionId);
        this.closeSession(sessionId, 'session revoked');
        this.revokingSessions.delete(sessionId);
        closed += 1;
      }
    }
    if (closed > 0) {
      console.log(`退出登录撤销：关闭 ${closed} 个旧会话（epoch=${epoch}）`);
    }
    return closed;
  }

  closeSession(sessionId, reason = 'session revoked') {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return;
    }
    console.log(`会话 ${sessionId} 已失效（${reason}），关闭连接`);
    try {
      session.webSocket.close(1008, reason);
    } catch {
      /* 已断开 */
    }
    this.sessions.delete(sessionId);
    this.revokingSessions.delete(sessionId);
    void this.removeSessionPresence(sessionId);
  }

  async cleanupStalePresence(room = '') {
    if (!this.env.DB) {
      return;
    }
    const cutoff = Math.floor((Date.now() - PRESENCE_TTL_MS) / 1000);
    const statement = room
      ? this.env.DB.prepare('DELETE FROM room_presence WHERE room = ? AND updatedAt < ?')
          .bind(room, cutoff)
      : this.env.DB.prepare('DELETE FROM room_presence WHERE updatedAt < ?')
          .bind(cutoff);
    const result = await statement.run();
    const removed = result?.meta?.changes ?? 0;
    if (removed > 0) {
      console.log(`清理了 ${removed} 条过期在线状态${room ? ` (房间: ${room})` : ''}`);
    }
  }

  getRoomStats() {
    let latestConnectedAt = 0;

    for (const session of this.sessions.values()) {
      if (session.connectedAt > latestConnectedAt) {
        latestConnectedAt = session.connectedAt;
      }
    }

    return {
      deviceCount: this.sessions.size,
      isActive: this.sessions.size > 0,
      lastActive: latestConnectedAt ? Math.floor(latestConnectedAt / 1000) : 0,
    };
  }
}