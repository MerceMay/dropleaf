import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Box, Chip, IconButton, ListItemIcon, ListItemText, Menu, MenuItem, Stack, Tooltip, useTheme } from '@mui/material';
import { MODES_META } from '@/modes/meta';
import { useAppStore } from '@/stores/appStore';
import { useWebSocketStore } from '@/stores/wsStore';
import { useAuthStore } from '@/stores/authStore';
import { usePageToolbarActions } from './PageToolbarContext';
import { MdiIcon } from '@/components/ui/MdiIcon';
import { API_BASE_URL } from '@/lib/base';

/**
 * 页面工具栏 —— 对应 web-vue3/src/components/PageToolbar.vue。
 *
 * ⚠️ 由**每个模式**自己渲染（`<PageToolbar variant="..."/>`），它触发的弹窗归外壳管
 * （通过 `PageToolbarContext`）。
 *
 * ⚠️ 连接图标只在「没连上」时出现：连上之后它是个**死按钮** —— 「连接好不好」已经由
 * 侧栏布局下那一格的延迟数字（带颜色分级）表达了，常驻就只是白占一个位置。
 *
 * ⚠️★ DropLeaf（单人剪贴板）：房间 pill / 二维码 / 热力图 / 进房间 / 房间列表按钮已删，
 * 左侧那组只剩「连接态 + 延迟」。
 */
export function PageToolbar({ variant = 'default' }: { variant?: string }) {
    const { t } = useTranslation();
    const theme = useTheme();
    const actions = usePageToolbarActions();

    const connected = useWebSocketStore((s) => s.websocket !== null);
    const connecting = useWebSocketStore((s) => s.websocketConnecting);
    const latency = useWebSocketStore((s) => s.latency);

    const uiMode = useAppStore((s) => s.uiMode);
    const setUiMode = useAppStore((s) => s.setUiMode);
    const automationEnabled = useAppStore((s) => s.config?.automation?.enabled === true);

    const [collapsed, setCollapsed] = useState(() => localStorage.getItem('pageToolbarCollapsed') === 'true');
    const [modeMenuAnchor, setModeMenuAnchor] = useState<HTMLElement | null>(null);

    const menuLayout = useAppStore((s) => s.menuLayout);
    const isSide = menuLayout === 'side';

    // ⚠️★ 侧栏模式下写**它自己占多宽**（2026-10-07）：收起时这条栏是**空的**，
    // 而 `AppShell` 还给左边留着 56px —— 用户报的「点了隐藏只隐藏了图标」就是这个
    //（图标没了、那一整条空位还在）。两处读**同一个变量**，就不会再各写一个数。
    // ⚠️ 工具栏高度**不再**写 CSS 变量：标准模式的输入区现在是固定头部，不再吸顶；
    // 每个模式的内容区自己滚（见 `DefaultMode` 的 `listScrollRef`）。
    useEffect(() => {
        document.documentElement.style.setProperty('--page-sidebar-width', collapsed && isSide ? '0px' : '56px');
        return () => { document.documentElement.style.removeProperty('--page-sidebar-width'); };
    }, [collapsed, isSide]);

    const currentMode = MODES_META.find((m) => m.key === uiMode) || MODES_META[0];

    const latencyColor = latency === null
        ? undefined
        : latency < 60
            ? theme.palette.success.main
            : latency < 120
                ? theme.palette.warning.main
                : theme.palette.error.main;

    // ⚠️★ 自动化管理页是**服务端渲染**的独立页面（不是这份前端的路由），所以地址必须指向
    // **后端**（`API_BASE_URL`）。按页面目录拼的话，前后端分离部署时点进去是静态托管那边的一张 404 ——
    // 而图标长得完全正常。
    // ⚠️ 不再手动拼 `config.server.prefix`：`API_BASE_URL` 里已经含后端那个前缀（同源部署时
    // 它就是从 `<base>` / 文档目录推出来的），再拼一次会变成 `/paste/paste/automation`。
    const automationUrl = (() => {
        try {
            return new URL('automation', API_BASE_URL).href;
        } catch {
            return 'automation';
        }
    })();

    const toggleToolbar = () => {
        const next = !collapsed;
        setCollapsed(next);
        localStorage.setItem('pageToolbarCollapsed', String(next));
    };

    return (
        <Box
            className={`page-toolbar page-toolbar--${variant}`}
            sx={{
                // ⚠️★ 侧栏模式（2026-10-07）：**固定**在左边，而不是 `sticky` 在顶部 ——
                // 「竖排但还跟着内容滚」是没意义的（它会跟着滚出视野）。
                // ⚠️ 宽度写死 `56px`，而**外壳那边要补同样宽度的左内边距**
                //（`AppShell` 里那一句）—— 两处必须同一个数，否则内容会被压在栏下面。
                ...(isSide
                    ? { position: 'fixed', left: 0, top: 0, height: '100dvh', width: 'var(--page-sidebar-width, 56px)', zIndex: 60 }
                    : { position: 'sticky', top: 0 }),
                zIndex: isSide ? 60 : 40,
                // ⚠️ 背景与下边框**不在这里**：它们按模式不同（见 styles/components.css 的
                // `.page-toolbar--*`）—— Vue 里 default 是 #f5f7fa、sticky 是 #f3ead2，
                // 而 glance / board **故意透明**（让模式自己的底色透上来）。
                // 统一写 `background.paper` 会让这几个模式的顶栏变成一块白，跟 Vue 对不上。
            }}
        >
            {!collapsed && (
                <Stack
                    // ⚠️ 侧栏模式下竖排。⚠️ 两个 `flex: 1` 的间隔块在竖排里会把
                    // 「右边那组」（设置 / 主题…）**推到栏底** —— 那正是想要的：
                    // 日常动作在上、一次性入口在下。
                    direction={isSide ? 'column' : 'row'}
                    alignItems="center"
                    spacing={1}
                    sx={isSide
                        ? { height: '100%', py: 1.5, px: 0.5 }
                        : { maxWidth: 1100, mx: 'auto', px: 2, py: 1 }}
                >
                    {/* 左侧：连接态 + 延迟
                        ⚠️★ 侧栏模式下**这一组也要竖排** —— 只改外层是不够的：
                        内层还是 `row` 的话会横向溢出 56px 的栏，被裁掉之后**按钮点不到**。 */}
                    <Stack direction={isSide ? 'column' : 'row'} alignItems="center" spacing={isSide ? 0.5 : 0.5} sx={isSide ? undefined : { flex: 1, minWidth: 0 }}>
                        {!connected && (
                            <Tooltip title={connecting ? t('connecting') : t('disconnected')}>
                                <IconButton size="small" aria-label={connecting ? t('connecting') : t('disconnected')} onClick={actions.toggleConnection}>
                                    <MdiIcon
                                        name={connecting ? 'mdi-lan-pending' : 'mdi-lan-disconnect'}
                                        size={22}
                                        color={connecting ? undefined : theme.palette.error.main}
                                    />
                                </IconButton>
                            </Tooltip>
                        )}
                        {/* ⚠️★ 侧栏里这一格显示 **ping 值**（三档颜色），量不到
                            （没连上 / 第一拍还没回来）就不占位 —— 顶栏布局下它退回
                            「断线」那颗图标，信息也不会凭空消失。 */}
                        {isSide ? (
                            connected && latency !== null ? (
                                <Tooltip title={t('latency')}>
                                    <Box component="span" sx={{ color: latencyColor, fontWeight: 700, fontSize: 12, py: 0.5 }}>
                                        {`${Math.round(latency)} ms`}
                                    </Box>
                                </Tooltip>
                            ) : null
                        ) : (
                            connected && latency !== null && (
                                <Tooltip title={t('latency')}>
                                    <Chip
                                        size="small"
                                        variant="outlined"
                                        label={
                                            <Box component="span" sx={{ color: latencyColor, fontWeight: 700, fontSize: 12 }}>
                                                {`${Math.round(latency)} ms`}
                                            </Box>
                                        }
                                    />
                                </Tooltip>
                            )
                        )}
                    </Stack>

                    {/* 右侧：模式 / 系统 两组
                        ⚠️ 与左侧同理：侧栏模式下必须竖排，否则这一组也会横向溢出。 */}
                    <Stack direction={isSide ? 'column' : 'row'} alignItems="center" spacing={1.5}>
                        {/* ⚠️★ 模式切换：侧栏模式下也收成**图标按钮**（与延迟那格同理）——
                            带标签的 chip 在 56px 的栏里会被裁掉，而「切模式」是这一栏里
                            最常用的东西之一，点不到等于整条栏废了。
                            ⚠️ 当前模式用 `title` / `aria-label` 说清楚（图标本身不表意）。 */}
                        {isSide ? (
                            <Tooltip title={`${t('uiMode')}：${t(currentMode.labelKey)}`}>
                                <IconButton
                                    size="small"
                                    aria-label={`${t('uiMode')}：${t(currentMode.labelKey)}`}
                                    onClick={(e) => setModeMenuAnchor(e.currentTarget)}
                                >
                                    <MdiIcon name={currentMode.icon} size={22} />
                                </IconButton>
                            </Tooltip>
                        ) : (
                        <Chip
                            size="small"
                            variant="outlined"
                            onClick={(e) => setModeMenuAnchor(e.currentTarget)}
                            aria-label={`${t('uiMode')}：${t(currentMode.labelKey)}`}
                            label={
                                <Stack direction="row" alignItems="center" spacing={0.5}>
                                    {/* ⚠️★ 窄屏**只显示图标**（2026-10-13，Jonny 要求）：
                                        模式名（「标准」「动作台」…）是这一栏里最长的一段文字，
                                        而手机上的顶栏本来就挤。图标每个模式一个，够辨识；
                                        真认不出时点开菜单就有名字（菜单里图标与文字是并排的）。
                                        ⚠️ 桌面端**保持纯文字、不加图标** —— 与 Vue 版同一条理由
                                        （那个版本的注释写着：旁边那几个都是纯图标按钮，
                                        这里再放一个图标只是多一层信息）。
                                        ⚠️ 箭头两边都留着：它是「这里能点开一个菜单」的唯一提示，
                                        去掉之后这个胶囊就长得跟旁边的纯图标按钮一样了。 */}
                                    <Box component="span" sx={{ display: { xs: 'inline', sm: 'none' } }}>
                                        <MdiIcon name={currentMode.icon} size={18} />
                                    </Box>
                                    <Box component="span" sx={{ fontSize: 13, display: { xs: 'none', sm: 'inline' } }}>{t(currentMode.labelKey)}</Box>
                                    <MdiIcon name="mdi-chevron-down" size={14} />
                                </Stack>
                            }
                            title={`${t('uiMode')}：${t(currentMode.labelKey)}`}
                        />
                        )}
                        <Menu anchorEl={modeMenuAnchor} open={Boolean(modeMenuAnchor)} onClose={() => setModeMenuAnchor(null)}>
                            {MODES_META.map((mode) => (
                                <MenuItem
                                    key={mode.key}
                                    selected={uiMode === mode.key}
                                    onClick={() => {
                                        setUiMode(mode.key);
                                        setModeMenuAnchor(null);
                                    }}
                                >
                                    <ListItemIcon><MdiIcon name={mode.icon} size={18} /></ListItemIcon>
                                    <ListItemText>{t(mode.labelKey)}</ListItemText>
                                </MenuItem>
                            ))}
                        </Menu>

                        <Stack direction={isSide ? 'column' : 'row'} alignItems="center" spacing={0.25}>
                            <Tooltip title={t('clearClipboard')}>
                                <IconButton size="small" aria-label={t('clearClipboard')} onClick={actions.openClearAll}>
                                    <MdiIcon name="mdi-broom" size={22} />
                                </IconButton>
                            </Tooltip>
                            {automationEnabled && (
                                <Tooltip title={t('automationEntryHint')}>
                                    <IconButton size="small" component="a" href={automationUrl} aria-label={t('automationEntry')}>
                                        <MdiIcon name="mdi-calendar-clock" size={22} />
                                    </IconButton>
                                </Tooltip>
                            )}
                            <Tooltip title={t('settings')}>
                                <IconButton size="small" aria-label={t('settings')} onClick={actions.openSettings}>
                                    <MdiIcon name="mdi-cog" size={22} />
                                </IconButton>
                            </Tooltip>
                            <Tooltip title={t('logout')}>
                                <IconButton
                                    size="small"
                                    aria-label={t('logout')}
                                    onClick={() => { void useAuthStore.getState().logout(); }}
                                >
                                    <MdiIcon name="mdi-logout" size={22} />
                                </IconButton>
                            </Tooltip>
                        </Stack>
                    </Stack>
                </Stack>
            )}
            {/* 折叠开关：一枚小胶囊，**嵌在那条分割线上**（Vue 用 `bottom:-2px` + 绝对定位）。
                ⚠️ 它**不该自己占一行** —— 原来那样会把工具栏撑高一截，而且看起来不像「贴着边框」。 */}
            <Box
                component="button"
                type="button"
                onClick={toggleToolbar}
                title={collapsed ? t('expandToolbar') : t('collapseToolbar')}
                aria-label={collapsed ? t('expandToolbar') : t('collapseToolbar')}
                sx={{
                    // ⚠️★ 侧栏模式下这枚胶囊要**转 90°**：它原本是「贴在横条下边缘中间」的
                    // 一小段横线（26×4）。竖栏里照原样放的话，它会贴在**栏底中间**、
                    // 而且仍然是一横条 —— 既看不出是「收起这一栏」，也不在栏的边缘上。
                    // 现在是：贴**右边缘**、竖直居中、4×26 的竖条。
                    position: 'absolute',
                    ...(isSide
                        ? { left: 'auto', right: collapsed ? -10 : -2, top: '50%', bottom: 'auto', transform: 'translateY(-50%)', width: 4, height: 26 }
                        : { left: '50%', bottom: -2, transform: 'translateX(-50%)', width: 26, height: 4 }),
                    zIndex: 5,
                    borderRadius: 999,
                    border: 'none',
                    p: 0,
                    background: 'currentColor',
                    opacity: 0.35,
                    cursor: 'pointer',
                    transition: 'opacity .15s, width .15s',
                    '&:hover': isSide ? { opacity: 0.8, height: 36 } : { opacity: 0.8, width: 36 },
                }}
            />
        </Box>
    );
}
