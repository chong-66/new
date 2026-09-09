/**
 * JSONPath 子集实现，覆盖书源 @JSon 规则的常见写法：
 *   $.a.b.c        逐层取值
 *   $.a.b[*]       展开数组
 *   $.a.b[0]       取下标（支持负数）
 *   $..key         递归查找所有同名 key
 *   $['a']['b']    引号形式
 *   $.a.*          对象所有值
 * 返回单个值或数组（多个结果时）。
 */
export function jsonQuery(input: unknown, path: string): unknown {
  const tokens = tokenize(path);
  let cur: unknown[] = [input];
  for (const tk of tokens) {
    const next: unknown[] = [];
    for (const v of cur) collect(v, tk, next);
    cur = next;
  }
  return cur.length <= 1 ? cur[0] : cur;
}

/** 始终返回数组形式（列表规则用） */
export function jsonQueryList(input: unknown, path: string): unknown[] {
  const r = jsonQuery(input, path);
  if (r === undefined || r === null) return [];
  return Array.isArray(r) ? r : [r];
}

type Token =
  | { kind: 'child'; key: string }
  | { kind: 'deep'; key: string }
  | { kind: 'index'; i: number }
  | { kind: 'wildcard' };

function tokenize(path: string): Token[] {
  const re = /\.\.([\w$]+)|\.([\w$*]+)|\['([^']+)'\]|\["([^"]+)"\]|\[(-?\d+)\]|\[\*\]/g;
  const out: Token[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(path))) {
    if (m[1] !== undefined) out.push({ kind: 'deep', key: m[1] });
    else if (m[2] !== undefined) {
      if (m[2] === '*') out.push({ kind: 'wildcard' });
      else out.push({ kind: 'child', key: m[2] });
    } else if (m[3] !== undefined) out.push({ kind: 'child', key: m[3] });
    else if (m[4] !== undefined) out.push({ kind: 'child', key: m[4] });
    else if (m[5] !== undefined) out.push({ kind: 'index', i: parseInt(m[5], 10) });
    else out.push({ kind: 'wildcard' });
  }
  return out;
}

function collect(v: unknown, tk: Token, out: unknown[]): void {
  if (v === null || v === undefined) return;
  switch (tk.kind) {
    case 'child':
      if (typeof v === 'object' && !Array.isArray(v)) {
        const val = (v as Record<string, unknown>)[tk.key];
        if (val !== undefined) out.push(val);
      }
      break;
    case 'deep':
      deepFind(v, tk.key, out);
      break;
    case 'index':
      if (Array.isArray(v)) {
        const i = tk.i < 0 ? v.length + tk.i : tk.i;
        if (v[i] !== undefined) out.push(v[i]);
      }
      break;
    case 'wildcard':
      if (Array.isArray(v)) out.push(...v);
      else if (typeof v === 'object') out.push(...Object.values(v as Record<string, unknown>));
      break;
  }
}

function deepFind(v: unknown, key: string, out: unknown[]): void {
  if (v === null || v === undefined) return;
  if (Array.isArray(v)) {
    for (const item of v) deepFind(item, key, out);
  } else if (typeof v === 'object') {
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      if (k === key) out.push(val);
      deepFind(val, key, out);
    }
  }
}
