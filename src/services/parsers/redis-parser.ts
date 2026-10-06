export function parseRedisCommand(query: string): string[] {
  const trimmed = query.trim();
  if (!trimmed) {
    throw new Error('Empty Redis command.');
  }

  const args: string[] = [];
  let i = 0;
  while (i < trimmed.length) {
    while (i < trimmed.length && trimmed[i] === ' ') { i++; }
    if (i >= trimmed.length) { break; }

    if (trimmed[i] === '"' || trimmed[i] === "'") {
      const quote = trimmed[i];
      i++;
      let val = '';
      while (i < trimmed.length && trimmed[i] !== quote) {
        val += trimmed[i];
        i++;
      }
      i++;
      args.push(val);
    } else {
      let val = '';
      while (i < trimmed.length && trimmed[i] !== ' ') {
        val += trimmed[i];
        i++;
      }
      args.push(val);
    }
  }
  return args;
}
