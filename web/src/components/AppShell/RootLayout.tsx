import { useEffect } from 'react';
import { Outlet } from 'react-router';
import { Box, CircularProgress, Typography } from '@mui/material';
import { useTranslation } from 'react-i18next';
import { useAuthStore } from '@/stores/authStore';
import { LoginPage } from '@/pages/LoginPage';
import { useDarkMode } from '@/hooks/useDarkMode';
import { startRealtime } from '@/services/bootstrap';
import { AppShell } from './AppShell';

/**
 * 路由根布局 —— 登录门 + 外壳。
 *
 * ⚠️★ 实时连接（WebSocket / 宿主桥）放在这里而不是 main.tsx：那时首个 location 才解析完；
 * 而且**不能**手动调 `router.initialize()`（会让 history 注册两个监听器、整树挂掉）。
 * 详见 services/bootstrap.ts 的文件头。
 *
 * ⚠️★ 登录门（2026-11-05 加）：未登录时**只渲染登录页** —— 编辑器、时间线、看板、
 * 工作区工具栏全部不挂载（不是隐藏）。相位在 authStore：
 *   checking（探测会话，避免刷新闪出密码框）→ login（全页登录页）→ ready（工作区）。
 * 会话被服务端确认失效时 authStore.invalidate() 把相位切回 login，工作区随之卸载；
 * 草稿内容留在 draftStore 引擎内存里，重新登录后照常恢复/对账。
 */
export function RootLayout() {
    const phase = useAuthStore((s) => s.phase);

    // ⚠️★ 深浅色系统挂在**这里**（原来在 AppShell）：登录页/连接屏不挂载 AppShell，
    // 但主题必须跟着走 —— 否则偏好暗色的用户看到登录页是亮的。
    useDarkMode();

    useEffect(() => {
        void useAuthStore.getState().probe();
    }, []);

    if (phase === 'checking') {
        return <CheckingScreen />;
    }
    if (phase === 'login') {
        return <LoginPage />;
    }
    return <WorkspaceRoot />;
}

/** 探测已有会话时的简洁连接状态（刷新时短暂可见，不闪密码框）。 */
function CheckingScreen() {
    const { t } = useTranslation();
    return (
        <Box
            sx={{
                minHeight: '100dvh',
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                justifyContent: 'center',
                gap: 2,
                bgcolor: 'background.default',
            }}
        >
            <CircularProgress size={28} />
            <Typography variant="body2" color="text.secondary" role="status">
                {t('loginChecking')}
            </Typography>
        </Box>
    );
}

/** 工作区（仅在会话就绪后挂载；挂载即启动实时连接 —— 与登录成功后的重挂载共用这一条路）。 */
function WorkspaceRoot() {
    useEffect(() => {
        startRealtime();
    }, []);

    return (
        <AppShell>
            <Outlet />
        </AppShell>
    );
}
