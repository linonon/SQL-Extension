import { detectLeafType } from './mongo-leaf-type';

// 把行里的 _id 值转成可注入 update/delete filter 的 shell token.
// _id 来自 deepFormatValue: BSON 叶子是 shell-tag 字符串 (ObjectId("..") / NumberLong("..") 等), 标量是裸值.
// shell-tag 原样输出 (本就是合法 shell 语法, 由 backend convertShellToJson 还原类型);
// 标量走 JSON.stringify 保留字面量与类型 (数字裸输出, 字符串加引号并转义).
// 单一 source of truth: 类型判定不在 backend 二次猜测.
export function idToShell(id: unknown): string {
  if (typeof id === 'string' && detectLeafType(id) !== 'string') {
    return id;
  }
  return JSON.stringify(id);
}
