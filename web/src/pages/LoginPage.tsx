import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Alert, Box, Button, TextField, Typography } from '@mui/material';
import { useAuthStore } from '@/stores/authStore';

/**
 * 全页登录页 —— DropLeaf 唯一入口（未登录时工作区不挂载，见 RootLayout 的相位门）。
 *
 * 品牌沿用叠纸 Logo（favicon.svg）与主题色（primary = #f2572b 系），
 * 深浅色跟随全局主题（本页在 ThemeProvider 内渲染）。
 *
 * 表单细节：
 *   · `<form onSubmit>`：回车提交 + 密码管理器识别（name/autoComplete/type 三件套）；
 *   · 密码错误 → 输入框旁 helperText；网络故障 → 独立 Alert + 重试按钮（重新探测）；
 *   · 提交中 disabled + loading，防重复点击；
 *   · 100dvh + 居中窄卡：手机键盘弹出时表单仍完整可见、可提交。
 */
export function LoginPage() {
    const { t } = useTranslation();
    const loginError = useAuthStore((s) => s.loginError);
    const networkError = useAuthStore((s) => s.networkError);
    const expired = useAuthStore((s) => s.expired);
    const submitting = useAuthStore((s) => s.submitting);

    const [password, setPassword] = useState('');

    const handleSubmit = (event: React.FormEvent<HTMLFormElement>) => {
        event.preventDefault();
        if (!password.trim() || submitting) {
            return;
        }
        void useAuthStore.getState().login(password);
    };

    return (
        <Box
            sx={{
                minHeight: '100dvh',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                px: 2,
                bgcolor: 'background.default',
            }}
        >
            <Box
                sx={{
                    width: '100%',
                    maxWidth: 340,
                    display: 'flex',
                    flexDirection: 'column',
                    alignItems: 'center',
                    gap: 1,
                    py: { xs: 4, sm: 6 },
                }}
            >
                {/* 品牌：叠纸 Logo（public/favicon.svg，随外壳的 <base> 解析）+ 产品名 */}
                <Box
                    component="img"
                    src="favicon.svg"
                    alt="DropLeaf"
                    sx={{ width: 64, height: 64, borderRadius: 3 }}
                />
                <Typography variant="h5" component="h1" fontWeight={700} sx={{ letterSpacing: '0.02em' }}>
                    DropLeaf
                </Typography>
                <Typography variant="body2" color="text.secondary" textAlign="center">
                    {t('loginTagline')}
                </Typography>

                {expired && !loginError && !networkError && (
                    <Typography variant="caption" color="text.secondary" role="status">
                        {t('loginSessionExpired')}
                    </Typography>
                )}

                {networkError && (
                    <Alert
                        severity="warning"
                        sx={{ width: '100%' }}
                        action={
                            <Button
                                color="inherit"
                                size="small"
                                onClick={() => void useAuthStore.getState().probe()}
                            >
                                {t('loginRetry')}
                            </Button>
                        }
                    >
                        {t('loginNetworkError')}
                    </Alert>
                )}

                <Box
                    component="form"
                    onSubmit={handleSubmit}
                    noValidate
                    sx={{ width: '100%', mt: 1, display: 'flex', flexDirection: 'column', gap: 1.5 }}
                >
                    <TextField
                        name="password"
                        type="password"
                        autoComplete="current-password"
                        autoFocus
                        fullWidth
                        label={t('password')}
                        value={password}
                        disabled={submitting}
                        error={loginError === 'invalid'}
                        helperText={loginError === 'invalid' ? t('authInvalid') : undefined}
                        onChange={(e) => {
                            setPassword(e.target.value);
                            if (loginError !== '') {
                                useAuthStore.setState({ loginError: '' });
                            }
                        }}
                    />
                    <Button
                        type="submit"
                        variant="contained"
                        fullWidth
                        size="large"
                        disabled={!password.trim() || submitting}
                        loading={submitting}
                    >
                        {t('loginButton')}
                    </Button>
                </Box>
            </Box>
        </Box>
    );
}
