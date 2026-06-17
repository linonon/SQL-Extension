// Table 视图列模型: 支持把 object 字段"展开"成 parent.child 列 (Studio 3T Show Embedded Fields).
// 叶子列携带完整 JSON path 作为表头, 让嵌套层级在表格里一目了然.

export interface DisplayColumn {
  readonly path: string;            // 取值用的 dot-path
  readonly label: string;           // 表头展示 (完整 path)
  readonly expandable: boolean;     // 值是 plain object, 可继续展开
  readonly collapseParent: string | null; // 折叠时应从 expanded 集合移除的祖先 path
}

export function getByPath(row: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>(
    (acc, k) => (acc == null || typeof acc !== 'object' ? undefined : (acc as Record<string, unknown>)[k]),
    row,
  );
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export function buildDisplayColumns(
  topLevel: readonly string[],
  rows: readonly Record<string, unknown>[],
  expanded: ReadonlySet<string>,
): DisplayColumn[] {
  const out: DisplayColumn[] = [];

  const walk = (path: string, collapseParent: string | null): void => {
    const valuesAreObject = rows.some((r) => isPlainObject(getByPath(r, path)));
    if (expanded.has(path) && valuesAreObject) {
      // 跨所有行求子 key 并集, 保持首次出现顺序
      const seen = new Set<string>();
      const keys: string[] = [];
      for (const r of rows) {
        const v = getByPath(r, path);
        if (isPlainObject(v)) {
          for (const k of Object.keys(v)) {
            if (!seen.has(k)) { seen.add(k); keys.push(k); }
          }
        }
      }
      for (const k of keys) { walk(`${path}.${k}`, path); }
    } else {
      out.push({ path, label: path, expandable: valuesAreObject, collapseParent });
    }
  };

  for (const name of topLevel) { walk(name, null); }
  return out;
}
