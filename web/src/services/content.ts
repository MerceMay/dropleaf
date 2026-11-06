/**
 * 条目更新相关的 HTTP 调用 —— 看板挪列、任务列表打勾这两条「改已有条目」的路。
 */
import axios from 'axios';
import { writeParams } from './http';

/**
 * 把一条内容挪到看板的某一列（`POST /content/<id>/column`）。
 * **固定三列**（todo / doing / done）、卡片就是剪贴板条目本身，而且**不动 timestamp**。
 */
export async function updateEntryColumn(id: string, room: string | undefined, column: string) {
    const response = await axios.post(
        `content/${encodeURIComponent(id)}/column`,
        { column },
        { params: new URLSearchParams([['room', room ?? '']]) },
    );
    return response.data;
}

/**
 * 覆盖一条**已有**文本条目的正文（`POST /text?id=<id>`）。
 * 落盘、广播 `update` 事件、id 不变。任务列表打勾是第一个用它的地方。
 */
export async function updateTextEntry(id: string, room: string, content: string) {
    await axios.post('text', String(content ?? ''), {
        // ⚠️ `id` 走 `extra` 而不是自己拼 URLSearchParams：`?room=` + `?client=` 这一对
        // 全站只能有一处拼法（见 `writeParams` 的注释），否则下一条请求一定会漏。
        params: writeParams(room ?? '', undefined, { id: String(id) }),
        headers: { 'Content-Type': 'text/plain' },
    });
}
