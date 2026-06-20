import type { ColumnInfo } from '../types/database';
import { isAutoFilledColumn } from './insert-row';

const NUMERIC_TYPE_RE = /^(tinyint|smallint|mediumint|int|integer|bigint|decimal|numeric|dec|fixed|float|double|real)\b/i;
const DATE_TYPE_RE = /^(date|datetime|timestamp)\b/i;
const DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

function isLeapYear(y: number): boolean {
  return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
}

// 像日期 (YYYY-M-D 开头) 但日历非法 (月份越界 / 该月无此日) 时返回错误.
// 不匹配日期形态的串一律放行, 交给 DB 判, 避免误伤合法的奇异格式.
function validateDateLike(colName: string, s: string): string | null {
  const m = s.trim().match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (!m) {
    return null;
  }
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  if (month < 1 || month > 12) {
    return `列 "${colName}" 日期非法: 月份 ${month} 越界`;
  }
  // 自行算当月天数 + 闰年, 不用 new Date (其对 0-99 年映射到 1900+ 会错判闰年)
  const maxDay = month === 2 && isLeapYear(year) ? 29 : DAYS_IN_MONTH[month - 1];
  if (day < 1 || day > maxDay) {
    return `列 "${colName}" 日期非法: ${year}-${month} 月没有第 ${day} 天`;
  }
  return null;
}

// 提交前校验单元格值与列类型/可空性是否匹配, 返回错误消息或 null (通过).
// 防御目标: 语法合法但值非法被静默写库 (如非数字写进 INT, 非法日期写进 DATE).
// 原则: 只拦"客户端能确定为非法"的情形, 不替 DB 重做完整类型系统.
export function validateCellValue(col: ColumnInfo, value: unknown): string | null {
  if (value === null || value === undefined || value === '') {
    // 空值: 仅对 NOT NULL 且非自动填充列拦截 (自增/默认值列空值是合法的"交给 DB")
    if (!col.nullable && !isAutoFilledColumn(col)) {
      return `列 "${col.name}" 不可为空 (NOT NULL)`;
    }
    return null;
  }
  const s = String(value).trim();
  const type = col.dataType.toLowerCase();
  // 纯空白: 对数字/日期列是非法值 (Number("")=0 会静默放行), 字符串列空白合法
  if (s === '') {
    if (NUMERIC_TYPE_RE.test(type) || DATE_TYPE_RE.test(type)) {
      return `列 "${col.name}" (${col.dataType}) 不能为纯空白`;
    }
    return null;
  }
  if (NUMERIC_TYPE_RE.test(type)) {
    if (!Number.isFinite(Number(s))) {
      return `列 "${col.name}" (${col.dataType}) 需要数字, 收到 "${value}"`;
    }
  }
  if (DATE_TYPE_RE.test(type)) {
    return validateDateLike(col.name, s);
  }
  return null;
}

// 批量校验一组 { col -> value }, 返回首个错误或 null.
export function validateRow(
  columns: readonly ColumnInfo[],
  row: Record<string, unknown>,
): string | null {
  for (const col of columns) {
    if (Object.prototype.hasOwnProperty.call(row, col.name)) {
      const msg = validateCellValue(col, row[col.name]);
      if (msg) {
        return msg;
      }
    }
  }
  return null;
}
