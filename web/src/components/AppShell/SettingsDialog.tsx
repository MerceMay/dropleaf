import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useColorScheme } from '@mui/material/styles';
import {
    Button, Dialog, DialogContent, DialogTitle, Divider, IconButton, List, ListItem, ListItemText,
    MenuItem, Select, Stack, Switch, Tab, Tabs, ToggleButton, ToggleButtonGroup, Typography,
} from '@mui/material';
import { DISPLAY_GROUPS, togglesForMode } from '@/data/displayToggles.js';
import { MODES } from '@/modes/registry';
import { setMenuLayout, useAppStore } from '@/stores/appStore';
import { useDisplaySettings } from '@/hooks/useDisplaySettings';
import { useThemeStore } from '@/stores/themeStore';
import { buildId } from '@/services/swUpdate';
import { MdiIcon } from '@/components/ui/MdiIcon';
import i18n from '@/i18n';

const LANGUAGE_OPTIONS = [
    { code: 'zh', name: '简体中文' },
    { code: 'zh-TW', name: '繁體中文' },
    { code: 'en', name: 'English' },
    { code: 'ja', name: '日本語' },
];

const iconStyle = { marginRight: 8, color: 'var(--mui-palette-primary-main)' } as const;

/**
 * 一行设置：图标 + 标题/说明 + 右侧控件。
 *
 * ⚠️★ 控件必须放进 `children`（与说明**同一行**，可换行）：MUI `secondaryAction` 只给正文
 * 留 48px 右内边距，而这一页的控件是 140px 的 Select 或 85px 的开关组 —— 窄屏上正文会
 * 钻到控件底下（2026-10-26 用户报的「移动端设置通用页文字重叠」，实测重叠 92px）。
 */
function SettingRow({ icon, primary, secondary, children }: {
    icon?: string;
    primary: string;
    secondary?: string;
    children?: React.ReactNode;
}) {
    return (
        <ListItem
            disableGutters
            sx={{ display: 'flex', alignItems: 'center', gap: 1, flexWrap: 'wrap', pr: 0 }}
        >
            {icon && <MdiIcon name={icon} style={iconStyle} />}
            <ListItemText
                primary={primary}
                secondary={secondary}
                sx={{ flex: '1 1 200px', minWidth: 0, my: 0 }}
                slotProps={{ primary: { sx: { wordBreak: 'break-word' } }, secondary: { sx: { wordBreak: 'break-word' } } }}
            />
            <Stack direction="row" alignItems="center" justifyContent="flex-end" spacing={1} sx={{ flexShrink: 0, ml: 'auto' }}>
                {children}
            </Stack>
        </ListItem>
    );
}

/**
 * 设置弹窗 —— 对应 web-vue3/src/App.vue 里的 `settingsDialog`（两个页签）。
 *
 * ⚠️★ DropLeaf（单人剪贴板）：「分享历史」「多后端地址」两节已删（分享功能整体不存在；
 * 后端地址只由部署方的 `config.js` 决定）。
 */
export function SettingsDialog({
    open,
    onClose,
    onOpenTraditionalColors,
}: {
    open: boolean;
    onClose: () => void;
    onOpenTraditionalColors: () => void;
}) {
    const { t } = useTranslation();
    const { mode } = useColorScheme();
    const [tab, setTab] = useState<'general' | 'personalization'>('general');
    const menuLayout = useAppStore((s) => s.menuLayout);

    const config = useAppStore((s) => s.config);
    const dark = useAppStore((s) => s.dark);
    const uiMode = useAppStore((s) => s.uiMode);
    const setUiMode = useAppStore((s) => s.setUiMode);
    const setDisplayToggle = useAppStore((s) => s.setDisplayToggle);
    const display = useDisplaySettings();

    const primaryLight = useThemeStore((s) => s.primaryLight);
    const primaryDark = useThemeStore((s) => s.primaryDark);
    const setPrimary = useThemeStore((s) => s.setPrimary);

    const isDark = mode === 'dark';
    const currentPrimary = isDark ? primaryDark : primaryLight;
    const currentLocale = i18n.resolvedLanguage || i18n.language || 'zh';

    const darkModeOptions = [
        { value: 'time', title: t('switchByTime'), desc: t('switchByTimeDesc') },
        { value: 'prefer', title: t('switchBySystem'), desc: t('switchBySystemDesc') },
        { value: 'enable', title: t('keepEnabled'), desc: '' },
        { value: 'disable', title: t('keepDisabled'), desc: '' },
    ];
    const darkModeDesc = darkModeOptions.find((option) => option.value === dark)?.desc || '';

    const togglesInGroup = (groupKey: string) =>
        togglesForMode(uiMode, groupKey) as Array<{ key: string; labelKey: string; icon: string }>;

    const groupAllOn = (groupKey: string) => {
        const list = togglesInGroup(groupKey);
        return list.length > 0 && list.every((toggle) => display[toggle.key]);
    };
    const setGroupAll = (groupKey: string, value: boolean) => {
        togglesInGroup(groupKey).forEach((toggle) => setDisplayToggle(toggle.key, value));
    };

    const changeLocale = (code: string) => {
        if (currentLocale !== code) {
            void i18n.changeLanguage(code);
            localStorage.setItem('locale', code);
        }
    };

    return (
        <Dialog open={open} onClose={onClose} maxWidth="sm" fullWidth>
            <DialogTitle sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                <div style={{ flex: 1, lineHeight: 1.3 }}>
                    <div style={{ fontSize: 18, fontWeight: 600 }}>{t('settings')}</div>
                    <Typography variant="caption" color="text.secondary">
                        {t('cloudClipboard')} {config.version || ''}
                        {buildId ? ` · web ${buildId}` : ''}
                    </Typography>
                </div>
                <IconButton size="small" onClick={onClose} aria-label={t('close')}>
                    <MdiIcon name="mdi-close" size={18} />
                </IconButton>
            </DialogTitle>
            <Divider />
            <Tabs value={tab} onChange={(_e, v) => setTab(v)} variant="fullWidth">
                <Tab value="general" label={t('settingsGeneral')} />
                <Tab value="personalization" label={t('personalization')} />
            </Tabs>
            <DialogContent dividers sx={{ maxHeight: '62vh' }}>
                {tab === 'general' && (
                    <Stack spacing={1}>
                        <Typography variant="subtitle2" color="text.secondary">{t('appearance')}</Typography>
                        <List dense disablePadding>
                            <SettingRow
                                icon="mdi-brightness-4"
                                primary={t('darkMode')}
                                secondary={darkModeDesc}
                            >
                                <Select
                                    size="small"
                                    value={dark}
                                    onChange={(e) => useAppStore.setState({ dark: e.target.value as never })}
                                    sx={{ minWidth: 140 }}
                                >
                                    {darkModeOptions.map((option) => (
                                        <MenuItem key={option.value} value={option.value}>{option.title}</MenuItem>
                                    ))}
                                </Select>
                            </SettingRow>
                            {/* 菜单布局（2026-10-07）。⚠️ 与「暗色模式」并列：两者都是
                                **外观**这一类的选择，而且都要求**即时生效 + 记住**。
                                ⚠️ 它只影响工具栏排在哪 —— 不改任何功能的位置。 */}
                            <SettingRow
                                icon="mdi-view-column-outline"
                                primary={t('menuLayout')}
                                secondary={t('menuLayoutHint')}
                            >
                                <ToggleButtonGroup
                                    size="small"
                                    exclusive
                                    value={menuLayout}
                                    onChange={(_e, v) => v && setMenuLayout(v)}
                                >
                                    <ToggleButton value="top">{t('menuLayoutTop')}</ToggleButton>
                                    <ToggleButton value="side">{t('menuLayoutSide')}</ToggleButton>
                                </ToggleButtonGroup>
                            </SettingRow>
                            <SettingRow icon="mdi-palette" primary={t('changeThemeColor')}>
                                <input
                                    type="color"
                                    value={currentPrimary}
                                    onChange={(e) => setPrimary(isDark ? 'dark' : 'light', e.target.value)}
                                    style={{ width: 36, height: 28, border: 'none', background: 'none', cursor: 'pointer' }}
                                    title={t('selectThemeColor')}
                                    aria-label={t('colorPicker')}
                                />
                                <Button
                                    size="small"
                                    variant="outlined"
                                    startIcon={<MdiIcon name="mdi-palette-swatch" size={16} />}
                                    onClick={onOpenTraditionalColors}
                                >
                                    {t('traditionalColors')}
                                </Button>
                            </SettingRow>
                        </List>

                        <Typography variant="subtitle2" color="text.secondary">{t('language')}</Typography>
                        <List dense disablePadding>
                            <SettingRow icon="mdi-translate" primary={t('language')}>
                                <Select size="small" value={currentLocale} onChange={(e) => changeLocale(e.target.value)} sx={{ minWidth: 140 }}>
                                    {LANGUAGE_OPTIONS.map((option) => (
                                        <MenuItem key={option.code} value={option.code}>{option.name}</MenuItem>
                                    ))}
                                </Select>
                            </SettingRow>
                        </List>

                        <Divider sx={{ my: 1 }} />
                    </Stack>
                )}

                {tab === 'personalization' && (
                    <Stack spacing={1.5}>
                        <Typography variant="caption" color="text.secondary">{t('personalizationHint')}</Typography>
                        <ToggleButtonGroup
                            value={uiMode}
                            exclusive
                            size="small"
                            onChange={(_e, value) => { if (value) setUiMode(value); }}
                            sx={{ flexWrap: 'wrap' }}
                        >
                            {MODES.map((m) => (
                                <ToggleButton key={m.key} value={m.key} sx={{ textTransform: 'none', gap: 0.5 }}>
                                    <MdiIcon name={m.icon} size={18} />
                                    {t(m.labelKey)}
                                </ToggleButton>
                            ))}
                        </ToggleButtonGroup>

                        {DISPLAY_GROUPS.map((group: { key: string; labelKey: string }) => {
                            const list = togglesInGroup(group.key);
                            if (!list.length) return null;
                            return (
                                <div key={group.key}>
                                    <Stack direction="row" alignItems="center" justifyContent="space-between">
                                        <Typography variant="subtitle2" color="text.secondary">{t(group.labelKey)}</Typography>
                                        <Switch
                                            size="small"
                                            checked={groupAllOn(group.key)}
                                            onChange={(e) => setGroupAll(group.key, e.target.checked)}
                                            title={t('toggleGroupAll')}
                                        />
                                    </Stack>
                                    <List dense disablePadding>
                                        {list.map((toggle) => (
                                            <ListItem
                                                key={toggle.key}
                                                disableGutters
                                                secondaryAction={
                                                    <Switch
                                                        size="small"
                                                        checked={Boolean(display[toggle.key])}
                                                        onChange={(e) => setDisplayToggle(toggle.key, e.target.checked)}
                                                    />
                                                }
                                            >
                                                <MdiIcon name={toggle.icon} style={iconStyle} />
                                                <ListItemText primary={t(toggle.labelKey)} />
                                            </ListItem>
                                        ))}
                                    </List>
                                </div>
                            );
                        })}
                    </Stack>
                )}
            </DialogContent>
        </Dialog>
    );
}
