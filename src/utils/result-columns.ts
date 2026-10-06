// SQL 结果集的行按列名建对象, 同名列 (JOIN 的 u.id / o.id) 不能互相覆盖.
// 首次出现的列名不变; 再次出现的用 `<表别名>.<列名>` (有别名且未被占用时), 否则 `<列名> (2)` / `(3)` ...
export function uniqueColumnKeys(fields: readonly { readonly name: string; readonly table?: string }[]): string[] {
  const used = new Set<string>();
  return fields.map(({ name, table }) => {
    let key = name;
    if (used.has(key) && table) { key = `${table}.${name}`; }
    for (let n = 2; used.has(key); n++) { key = `${name} (${n})`; }
    used.add(key);
    return key;
  });
}

// 按列下标把值数组 (mysql2 rowsAsArray / pg rowMode 'array' 的行) 组装成以 keys 为键的对象
export function rowObjects(keys: readonly string[], rows: readonly (readonly unknown[])[]): Record<string, unknown>[] {
  return rows.map((row) => Object.fromEntries(keys.map((k, i) => [k, row[i]])));
}
