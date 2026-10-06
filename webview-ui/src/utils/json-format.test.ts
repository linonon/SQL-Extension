import { describe, it, expect } from 'vitest';
import { formatJsonLossless } from './json-format';

describe('formatJsonLossless', () => {
  it('int64 和尾随 0 的小数保持原文', () => {
    expect(formatJsonLossless('{"uid":1234567890123456789,"gold":1.50,"e":-1.0E+2}')).toBe(
      '{\n  "uid": 1234567890123456789,\n  "gold": 1.50,\n  "e": -1.0E+2\n}'
    );
  });

  it('字符串内的转义引号, 反斜杠和结构字符不被当成 token', () => {
    const input = '{"a":"x\\"y\\\\","b":"{[,:]}"}';
    expect(formatJsonLossless(input)).toBe('{\n  "a": "x\\"y\\\\",\n  "b": "{[,:]}"\n}');
  });

  it('嵌套数组/对象缩进, 空容器保持紧凑, 原有空白被重排', () => {
    const input = ' { "a" : [ 1 , { "b" : [ ] } ] , "c" : { \n } } ';
    expect(formatJsonLossless(input)).toBe(
      '{\n  "a": [\n    1,\n    {\n      "b": []\n    }\n  ],\n  "c": {}\n}'
    );
  });

  it('格式化结果仍是等价 JSON, 重复格式化幂等', () => {
    const once = formatJsonLossless('[{"k":[true,false,null]},"s"]');
    expect(JSON.parse(once)).toEqual([{ k: [true, false, null] }, 's']);
    expect(formatJsonLossless(once)).toBe(once);
  });

  it('非法 JSON 原样返回', () => {
    for (const s of ['{"a":1', 'hello', '{a:1}', '']) {
      expect(formatJsonLossless(s)).toBe(s);
    }
  });
});
