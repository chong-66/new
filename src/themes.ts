export const THEMES = [
  { id: 'dark', label: '暗夜', swatch: '#16161c', textColor: '#e6e6eb', minimumBackgroundOpacity: 0 },
  { id: 'midnight', label: '深海', swatch: '#0f172a', textColor: '#e2e8f0', minimumBackgroundOpacity: 0 },
  { id: 'forest', label: '墨绿', swatch: '#10201b', textColor: '#e1eee7', minimumBackgroundOpacity: 0 },
  { id: 'plum', label: '暮紫', swatch: '#241824', textColor: '#f1e4ef', minimumBackgroundOpacity: 0 },
  { id: 'sepia', label: '护眼', swatch: '#f4ecd8', textColor: '#49372a', minimumBackgroundOpacity: 72 },
  { id: 'light', label: '纸白', swatch: '#f7f8fb', textColor: '#182033', minimumBackgroundOpacity: 85 },
] as const;

export type ThemeId = typeof THEMES[number]['id'];

export function themeById(id: unknown) {
  return THEMES.find((theme) => theme.id === id) ?? THEMES[0];
}

export function normalizeTheme(id: unknown): ThemeId {
  return themeById(id).id;
}
