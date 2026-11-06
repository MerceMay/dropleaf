import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { useLocation } from 'react-router';
import { Alert, Box } from '@mui/material';
import { router } from '@/router';
import { MODES_META } from '@/modes/meta';
import { useAppStore } from '@/stores/appStore';
import { useWebSocketStore } from '@/stores/wsStore';
import { useDarkMode } from '@/hooks/useDarkMode';
import { PageToolbarContext, type PageToolbarActions } from './PageToolbarContext';
import { SettingsDialog } from './SettingsDialog';
import { ClearAllDialog } from './ClearAllDialog';
import { TraditionalColorDialog } from './TraditionalColorDialog';
import { ToastHost } from './ToastHost';
import { MediaViewer } from '@/components/viewer/MediaViewer';

/**
 * 应用外壳 —— 背景 / 「已清空」提示条 / 工作区 / 全部顶层弹窗 / toast，
 * 并通过 `PageToolbarContext` 把「打开这些弹窗」的能力提供给各模式里的工具栏。
 *
 * ⚠️ DropLeaf 是**单人剪贴板**：房间已删除（后端房间恒 `default`），这里不再有房间侧栏 /
 * 房间 pill / 二维码 / 热力图 / 分享历史那一层。
 */
export function AppShell({ children }: { children: ReactNode }) {
    const { t } = useTranslation();
    const location = useLocation();
    // 深浅色系统（含 time/prefer 的定时器与 matchMedia 监听）
    useDarkMode();

    const [settingsOpen, setSettingsOpen] = useState(false);
    const [clearAllOpen, setClearAllOpen] = useState(false);
    const [traditionalColorsOpen, setTraditionalColorsOpen] = useState(false);
    const [clearedVisible, setClearedVisible] = useState(false);

    const uiMode = useAppStore((s) => s.uiMode);
    const menuLayout = useAppStore((s) => s.menuLayout);
    const isSide = menuLayout === 'side';

    // 初始化：纠正地址里手打错的模式 key（否则地址栏一直挂着一个不存在的键骗人）
    useEffect(() => {
        if (!MODES_META.some((entry) => entry.key === useAppStore.getState().uiMode)) {
            useAppStore.getState().setUiMode('default');
        }
    }, []);

    // 模式写回地址 —— **replace**（每切一次模式就 push 的话，后退键会变成「回到上一个模式」）。
    useEffect(() => {
        const params = new URLSearchParams(router.state.location.search);
        if (params.get('mode') === uiMode) {
            return;
        }
        params.set('mode', uiMode);
        void router.navigate(
            { pathname: router.state.location.pathname, search: `?${params.toString()}` },
            { replace: true },
        );
    }, [uiMode]);

    // 地址变化 → 清掉「已清空」提示
    useEffect(() => {
        setClearedVisible(false);
    }, [location.search, location.pathname]);

    const toolbarActions = useMemo<PageToolbarActions>(() => ({
        openSettings: () => setSettingsOpen(true),
        openClearAll: () => setClearAllOpen(true),
        toggleConnection: () => {
            const ws = useWebSocketStore.getState();
            if (!ws.websocket && !ws.websocketConnecting) {
                useWebSocketStore.setState({ retry: 0 });
                void ws.connect();
            }
        },
        goHome: () => {
            if (router.state.location.pathname !== '/' || router.state.location.search) {
                void router.navigate('/');
            }
        },
    }), []);

    return (
        <PageToolbarContext.Provider value={toolbarActions}>
            {/* ⚠️★ 侧栏模式下要**给左边留出那条固定栏的宽度**（56px，收起时是 0）——
                这个数**由 `PageToolbar` 写进 `--page-sidebar-width`**（两处各写一个数字的画，
                「点了隐藏只隐藏了图标」就是那个漂：图标没了、这条空位还在）。
                不留的话内容会被压在栏下面，而且**看起来只是「左边少了一块」**。 */}
            {/* ⚠️★ 外壳是**100dvh 的 flex 列 + overflow hidden**：整个窗口不滚，
                工具栏和模式头固定，每个模式的内容区自己滚。
                ⚠️ 以前这里是 `minHeight: 100dvh`，窗口可以整体滚动 —— 工具栏是 sticky，
                内容就会从它下面穿过去（2026-10-29 用户报的「往上滑头部内容滑进顶部菜单栏」）。
                模式根节点因此也统一用 `height: 100%`（不是 100dvh）。 */}
            <Box
                sx={{
                    height: '100dvh',
                    minHeight: 0,
                    display: 'flex',
                    flexDirection: 'column',
                    overflow: 'hidden',
                    bgcolor: 'background.default',
                    pl: isSide ? 'var(--page-sidebar-width, 56px)' : 0,
                }}
            >
                {/* 不再提示「刷新页面生效」：clearAll 现在有 WS 广播，列表会自动清空
                    （含发起端自己）。这里只是一条确认提示。 */}
                {clearedVisible && (
                    <Alert severity="success" onClose={() => setClearedVisible(false)} sx={{ borderRadius: 0, justifyContent: 'center', flexShrink: 0 }}>
                        {t('clipboardCleared')}
                    </Alert>
                )}

                <Box
                    sx={{
                        flex: 1,
                        minHeight: 0,
                        display: 'flex',
                        alignItems: 'stretch',
                    }}
                >
                    <Box sx={{ flex: 1, minWidth: 0, minHeight: 0, overflow: 'hidden' }}>{children}</Box>
                </Box>

                <SettingsDialog
                    open={settingsOpen}
                    onClose={() => setSettingsOpen(false)}
                    onOpenTraditionalColors={() => setTraditionalColorsOpen(true)}
                />
                <TraditionalColorDialog open={traditionalColorsOpen} onClose={() => setTraditionalColorsOpen(false)} />
                <ClearAllDialog open={clearAllOpen} onClose={() => setClearAllOpen(false)} onCleared={setClearedVisible} />
                {/* 全屏查看器挂在这一层（不是某个模式里）：**每个模式点开媒体都是它**。
                    它自己走 portal 到 body，所以不受这里的布局影响。 */}
                <MediaViewer />
                <ToastHost />
            </Box>
        </PageToolbarContext.Provider>
    );
}
