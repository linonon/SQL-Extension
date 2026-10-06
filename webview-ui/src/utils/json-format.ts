// 无损 JSON 格式化: 只重排原文 token 之间的空白, 数字和字符串逐字取自原文,
// 所以 int64 (1234567890123456789) 和 1.50 不会被 JSON.parse + stringify 改写.
// 不是合法 JSON 时原样返回.
export function formatJsonLossless(text: string): string {
  try {
    JSON.parse(text);
  } catch {
    return text;
  }
  let out = '';
  let depth = 0;
  let inString = false;
  const newline = () => '\n' + '  '.repeat(depth);
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      out += c;
      if (c === '\\') {
        out += text[++i];
      } else if (c === '"') {
        inString = false;
      }
      continue;
    }
    switch (c) {
      case '"':
        inString = true;
        out += c;
        break;
      case '{':
      case '[': {
        // 空容器保持 {} / []
        let j = i + 1;
        while (' \t\n\r'.includes(text[j])) { j++; }
        if (text[j] === (c === '{' ? '}' : ']')) {
          out += c + text[j];
          i = j;
        } else {
          depth++;
          out += c + newline();
        }
        break;
      }
      case '}':
      case ']':
        depth--;
        out += newline() + c;
        break;
      case ',':
        out += ',' + newline();
        break;
      case ':':
        out += ': ';
        break;
      case ' ':
      case '\t':
      case '\n':
      case '\r':
        break;
      default:
        out += c;
    }
  }
  return out;
}
