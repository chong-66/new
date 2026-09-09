import type { Chapter } from '../types';

export function matchChapter(chapters: Chapter[], title: string): number {
  const normalize = (s: string) => s.normalize('NFKC').replace(/[\s·:：、，。!！?？_—-]/g, '').toLowerCase();
  const wanted = normalize(title);
  if (!wanted) return -1;
  const matches = chapters.map((c, index) => ({ index, title: normalize(c.title) })).filter((c) => c.title === wanted);
  // 重名章节也交给用户选择，避免错误跳转。
  return matches.length === 1 ? matches[0].index : -1;
}
