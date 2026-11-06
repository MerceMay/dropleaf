import { createContext, useContext } from 'react';

/**
 * 外壳提供给工具栏的动作 —— 对应 Vue 版的 `provide('pageToolbarActions', ...)`。
 *
 * ⚠️★ 为什么走 Context 而不是把 props 一层层传：工具栏由**各个模式**自己渲染
 * （`DefaultMode` / `GlanceWall` / … 都挂一个 `<PageToolbar/>`），而它要触发的
 * 弹窗（设置 / 清空）全都归**外壳**管。Context 让模式不需要知道外壳。
 */
export interface PageToolbarActions {
    openSettings: () => void;
    openClearAll: () => void;
    toggleConnection: () => void;
    goHome: () => void;
}

const noop = () => {};

/** 默认值是一组空操作：工具栏在**外壳之外**被渲染时（比如测试）不该崩。 */
export const PageToolbarContext = createContext<PageToolbarActions>({
    openSettings: noop,
    openClearAll: noop,
    toggleConnection: noop,
    goHome: noop,
});

export function usePageToolbarActions(): PageToolbarActions {
    return useContext(PageToolbarContext);
}
