/**
 * 嵌入态（桌面端把网页版塞进 iframe）的**宿主消息通道** —— 从 web-vue3/src/host-bridge.js 移植。
 *
 * # 协议
 * 宿主 → 页面：
 *   { type: 'paste:theme', theme: 'dark' | 'light' } → 深浅色
 *   { type: 'paste:ping' }                           → 探活
 * 页面 → 宿主（只在收到 ping 之后回一条）：
 *   { type: 'paste:hello', protocol: number }
 *
 * ⚠️★ `protocol` 是**协议版本**，它是宿主判断「这个页面能不能被消息驱动」的**第二条**判据：
 * 第一条是 `index.html` 里那个 `<meta name="dropleaf-web">`。两处一起改，别只改一处。
 *
 * # 安全
 * ⚠️★ 只认 `event.source === window.parent`：别的窗口不该能指挥它。
 * ⚠️ 刻意**不校验** `event.origin`：宿主的父页面在每个平台上的 origin 都不一样。
 * ⚠️ 这条通道能做的只有「切主题」—— **别往协议里加会改数据的能力**。
 */
import { readLocationParam } from '@/lib/util';
import { useAppStore } from '@/stores/appStore';

/** 宿主协议版本。⚠️ 改消息形状时要**一起**改 `index.html` 那个 meta 的 content。 */
export const HOST_PROTOCOL = 1;

/**
 * 装上游消息通道。返回一个句柄（方便调试与测试；页面活到老，不需要卸）。
 * ⚠️ 非嵌入态返回 `null`（没装）—— 普通浏览器里这个页面没有父窗口。
 */
export function installHostBridge(): { protocol: number } | null {
    if (readLocationParam('embed') !== '1') {
        return null;
    }

    /** 往父窗口回话。⚠️ 目标 origin 用 `'*'`：父页面各平台 origin 不同，而这条消息里只有协议号。 */
    const post = (payload: unknown) => {
        if (window.parent === window) return;
        window.parent.postMessage(payload, '*');
    };

    window.addEventListener('message', (event) => {
        // ⚠️★ 只认父窗口。
        if (event.source !== window.parent) return;
        const data = event.data as { type?: string; theme?: unknown } | null;
        if (!data || typeof data !== 'object') return;

        switch (data.type) {
            case 'paste:theme': {
                // ⚠️ 落点与 main.tsx 里读 `?theme=` 那次是**同一个字段**（`app.dark`）。
                if (data.theme === 'dark') {
                    useAppStore.setState({ dark: 'enable' });
                } else if (data.theme === 'light') {
                    useAppStore.setState({ dark: 'disable' });
                }
                break;
            }
            case 'paste:ping': {
                post({ type: 'paste:hello', protocol: HOST_PROTOCOL });
                break;
            }
            default:
                break;
        }
    });

    return { protocol: HOST_PROTOCOL };
}
