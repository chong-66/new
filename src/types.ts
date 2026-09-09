/** 阅读 3.0 书源（本应用实现其子集，详见 README） */
export interface BookSource {
  bookSourceName: string;
  bookSourceUrl: string;
  /** 0=文本 1=音频 2=图片。第一版只支持 0 */
  bookSourceType?: number;
  bookSourceGroup?: string;
  enabled?: boolean;
  /** 自定义请求头（JSON 字符串或对象） */
  header?: string | Record<string, string>;
  jsLib?: string;
  searchUrl?: string;
  ruleSearch?: RuleSearch;
  ruleBookInfo?: RuleBookInfo;
  ruleToc?: RuleToc;
  ruleContent?: RuleContent;
  [key: string]: unknown;
}

export interface RuleSearch {
  bookList?: string;
  name?: string;
  author?: string;
  kind?: string;
  coverUrl?: string;
  intro?: string;
  bookUrl?: string;
  lastChapter?: string;
}

export interface RuleBookInfo {
  init?: string;
  name?: string;
  author?: string;
  intro?: string;
  kind?: string;
  coverUrl?: string;
  tocUrl?: string;
}

export interface RuleToc {
  chapterList?: string;
  chapterName?: string;
  chapterUrl?: string;
  nextTocUrl?: string;
}

export interface RuleContent {
  content?: string;
  nextContentUrl?: string;
  replaceRegex?: string;
}

/** 书架上的书 */
export interface Book {
  id: string;
  name: string;
  author: string;
  coverUrl: string;
  intro: string;
  /** 书籍详情页地址 */
  bookUrl: string;
  /** 目录页地址（部分书源详情页与目录页不同） */
  tocUrl: string;
  /** 来源书源的 bookSourceUrl */
  sourceUrl: string;
  /** 来源书源名称（冗余，展示用） */
  sourceName: string;
  kind: string;
  addedTime: number;
  lastReadTime: number;
  /** 最近一次已知的章节总数（用于未读角标） */
  totalChapters: number;
  /** 目录最新一章标题（书架展示用） */
  latestChapter: string;
  /** 未读章节数角标 */
  unreadCount: number;
  progress: { chapterIndex: number; chapterUrl?: string; chapterTitle?: string; scrollRatio?: number };
}

export interface Chapter {
  title: string;
  url: string;
}

/** 搜索结果（未入架的轻量书籍信息） */
export interface SearchResult {
  /** 同一本书的其他来源，保留以供选择。 */
  alternatives?: SearchResult[];
  name: string;
  author: string;
  coverUrl: string;
  intro: string;
  bookUrl: string;
  kind: string;
  source: BookSource;
}
