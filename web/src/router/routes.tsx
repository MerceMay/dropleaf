import { RouteObject } from 'react-router';
import Home from '@/pages/Home';
import { RootLayout } from '@/components/AppShell/RootLayout';

/**
 * 路由表 —— 对应 web-vue3/src/router/index.js。
 *
 * ⚠️★ 包一层 `RootLayout`：它负责挂载后启动实时连接（见 services/bootstrap.ts）。
 */
export const routes: RouteObject[] = [
    {
        element: <RootLayout />,
        children: [
            {
                path: '/',
                element: <Home />,
            },
        ],
    },
];
