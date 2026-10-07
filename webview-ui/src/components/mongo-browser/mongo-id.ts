import { detectLeafType } from './mongo-leaf-type';
import { jsonToShell } from '../../utils/mongo-shell-to-json';

// 行 _id 的 shell 形式, 用作界面里的文档身份 (编辑态比对 / key) 与 "Copy _id" 的文本.
// _id 来自 deepFormatValue: BSON 叶子是 shell-tag 字符串 (ObjectId("..") / NumberLong("..") 等), 原样输出;
// 标量走 JSON.stringify (数字裸输出, 字符串加引号并转义); 复合 _id 里的 shell-tag 还原成 shell 写法, 粘进 mongosh 能直接查.
// 发给宿主定位文档的 _id 不用它, 用 convertTags 还原成 EJSON (复合 _id 内的 shell-tag 也能还原).
export function idToShell(id: unknown): string {
  // 投影排除 _id 时 id 为 undefined; 返回空串而非 JSON.stringify 的 undefined
  if (id === undefined) { return ''; }
  if (typeof id === 'string' && detectLeafType(id) !== 'string') {
    return id;
  }
  return typeof id === 'object' && id !== null ? jsonToShell(JSON.stringify(id)) : JSON.stringify(id);
}
