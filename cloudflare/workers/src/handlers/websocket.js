import { corsHeaders } from '../cors';
import { ensureRoomAccess, extractWebSocketToken, normalizeRoomName } from '../auth';
import { errorResponse } from '../errors';

export class WebSocketHandler {
  static async connect(request, env) {
    try {
      const url = new URL(request.url);
      const room = normalizeRoomName(url.searchParams.get('room'));
      // ⚠️ 只记 room，不记 URL —— ?auth= 凭据不进日志（安全修复 2026-11-05）
      console.log(`WebSocket 连接请求: room=${room}`);
      // ⚠️ 握手不使用 Cookie（第二轮复审 P1）：同站其它子域的页面可以自动带上
      // 会话 Cookie 发起 WS —— 那等于让它们订阅实时草稿。显式令牌之外的来源一律拒绝。
      const authResult = await ensureRoomAccess(request, env, room, extractWebSocketToken(request), { allowCookie: false });
      if (!authResult.ok) {
        console.log('WebSocket 认证失败');
        return authResult.response;
      }
      console.log('WebSocket 认证成功');

      // 检查是否为 WebSocket 升级请求
      const upgradeHeader = request.headers.get('Upgrade');
      if (!upgradeHeader || upgradeHeader.toLowerCase() !== 'websocket') {
        console.log('不是 WebSocket 升级请求');
        return new Response('Expected WebSocket', { 
          status: 400,
          headers: corsHeaders
        });
      }

      // 检查必要的 WebSocket 头部
      const connectionHeader = request.headers.get('Connection');
      const wsKeyHeader = request.headers.get('Sec-WebSocket-Key');
      const wsVersionHeader = request.headers.get('Sec-WebSocket-Version');
      
      if (!connectionHeader || !wsKeyHeader || !wsVersionHeader) {
        console.log('缺少必要的 WebSocket 头部');
        return new Response('Invalid WebSocket headers', {
          status: 400,
          headers: corsHeaders
        });
      }

      console.log('准备创建 Durable Object 连接');

      // 确保 WEBSOCKET_ROOM binding 存在
      if (!env.WEBSOCKET_ROOM) {
        console.error('WEBSOCKET_ROOM binding 不存在');
        return new Response('WebSocket service unavailable', {
          status: 503,
          headers: corsHeaders
        });
      }

      // 使用 Durable Objects 处理 WebSocket 连接
      const durableObjectId = env.WEBSOCKET_ROOM.idFromName(room);
      const durableObject = env.WEBSOCKET_ROOM.get(durableObjectId);

      // ⚠️ 日志只写 room，不写完整 URL —— URL 里可能带 ?auth= 凭据（安全修复 2026-11-05）
      console.log(`转发到 Durable Object, room: ${room}`);

      // 转发到 DO，并把已验证的会话令牌以内部参数传过去（DO 周期性复验、支持撤销）。
      // 原始 ?auth= 从转发 URL 里剥掉 —— 令牌只进 DO 内存，不留在任何会打日志的 URL 上。
      const doUrl = new URL(request.url);
      doUrl.searchParams.delete('auth');
      if (authResult.token) {
        doUrl.searchParams.set('session', authResult.token);
      }
      const forwarded = new Request(doUrl.toString(), request);
      return await durableObject.fetch(forwarded);

    } catch (error) {
      console.error('WebSocket handler error:', error);
      console.error('Error stack:', error.stack);
      
      return errorResponse(500, 'internal_error', 'Internal Server Error', '服务器内部错误');
    }
  }
}