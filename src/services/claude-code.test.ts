import { describe, expect, it } from 'vitest';
import { parseStreamLine } from './claude-code.js';

describe('parseStreamLine', () => {
  it('extracts text deltas, the resolved model and errors; ignores the rest', () => {
    expect(parseStreamLine('{"type":"system","subtype":"init","model":"claude-haiku-4-5"}')).toEqual({ model: 'claude-haiku-4-5' });
    expect(parseStreamLine('{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"SEL"}}}')).toEqual({ text: 'SEL' });
    expect(parseStreamLine('{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"thinking_delta","thinking":"x"}}}')).toBeNull();
    expect(parseStreamLine('{"type":"result","subtype":"error","is_error":true,"result":"rate limited"}')).toEqual({ error: 'rate limited' });
    expect(parseStreamLine('{"type":"result","subtype":"success","is_error":false,"result":"ok"}')).toBeNull();
    expect(parseStreamLine('not json')).toBeNull();
  });
});
