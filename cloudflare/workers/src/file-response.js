import { corsHeaders } from './cors';

/**
 * 附件响应的**唯一**安全头实现（安全修复 2026-11-05）。
 *
 * ⚠️★ 为什么抽成模块：附件有**两个**字节出口 —— `/file/:uuid` 和 `/content/:id`
 * （`/content/latest` 的文件分支同一条路）。上一轮只加固了前者，后者的 raw 分支
 * 仍按上传时声明的 MIME 原样 inline 返回 text/html：脚本照跑、能读同源页面的
 * localStorage 令牌。两份实现 = 迟早只有一份被修 —— 所以规则只写在这里，
 * 两个处理器都调它，回归测试对两个入口各钉一遍。
 *
 * 规则：
 *   · 仅明确安全的媒体类型可 inline（位图/音视频/PDF/纯文本）；
 *   · 其余（HTML、SVG、XML、JSON、未知类型…）一律 attachment + octet-stream；
 *   · 一律 nosniff + CSP sandbox（纵深防御，防 MIME 嗅探与插件执行）；
 *   · 私有附件不做共享缓存（private, no-store）。
 */

/** 允许 inline 预览的媒体类型白名单。SVG 按 HTML 同级对待（可内嵌脚本）。 */
export function isInlineSafeMediaType(contentType) {
  const type = String(contentType || '').toLowerCase().split(';')[0].trim();
  if (type === 'image/svg+xml' || type === 'image/svg') {
    return false;
  }
  if (type.startsWith('image/')) {
    return true;
  }
  if (type.startsWith('video/') || type.startsWith('audio/')) {
    return true;
  }
  return type === 'application/pdf' || type === 'text/plain';
}

/** 头里只放 ASCII 安全字符；原名另用 RFC 5987 的 `filename*` 保留 UTF-8。 */
export function toSafeAsciiFilename(filename = '') {
  const normalized = String(filename || '')
    .replace(/[\r\n]/g, ' ')
    .replace(/["\\]/g, '_')
    .replace(/[^\x20-\x7E]/g, '_')
    .trim();
  return normalized || 'file';
}

export function buildContentDisposition(filename = '', disposition = 'inline') {
  const safeFallback = toSafeAsciiFilename(filename);
  const encodedFilename = encodeURIComponent(String(filename || safeFallback));
  return `${disposition}; filename="${safeFallback}"; filename*=UTF-8''${encodedFilename}`;
}

/**
 * 组装附件字节响应的全部头。
 *
 * @param {object} options
 * @param {string} options.declaredType  上传时登记的 MIME（不可信，只用于判断能否 inline）
 * @param {string} options.originalName  原始文件名（进 Content-Disposition）
 * @param {number} [options.size]        字节数（给了才写 Content-Length）
 * @param {boolean} [options.forceDownload] 客户端显式要求下载（download=true）
 * @param {object} [options.extra]       额外头（CORS、X-Content-* 等）
 */
export function buildSafeFileHeaders({ declaredType, originalName, size, forceDownload = false, extra = {} }) {
  const normalizedType = String(declaredType || 'application/octet-stream').toLowerCase();
  const inlineSafe = isInlineSafeMediaType(normalizedType);
  const serveType = inlineSafe ? normalizedType : 'application/octet-stream';

  const headers = {
    'Content-Type': serveType,
    'Cache-Control': 'private, no-store',
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': 'sandbox',
    ...(size !== undefined && size !== null ? { 'Content-Length': String(size) } : {}),
    ...extra,
  };

  headers['Content-Disposition'] = buildContentDisposition(
    originalName || 'file',
    forceDownload || !inlineSafe ? 'attachment' : 'inline',
  );

  return headers;
}

/** 同上，但直接返回 Response（处理器只关心「给我一个安全的响应」）。 */
export function safeFileResponse(object, { declaredType, originalName, forceDownload = false, extra = {} } = {}) {
  const headers = buildSafeFileHeaders({
    declaredType: declaredType ?? object?.httpMetadata?.contentType,
    originalName,
    size: object?.size,
    forceDownload,
    extra: { ...corsHeaders, ...extra },
  });
  return new Response(object.body, { headers });
}
