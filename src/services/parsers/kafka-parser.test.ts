import { describe, it, expect } from 'vitest';
import { parseKafkaQuery, READ_ACTIONS, WRITE_ACTIONS } from './kafka-parser.js';

describe('parseKafkaQuery', () => {
  it('should parse listTopics', () => {
    const r = parseKafkaQuery('{"action":"listTopics"}');
    expect(r.action).toBe('listTopics');
  });
  it('should parse describeTopic', () => {
    const r = parseKafkaQuery('{"action":"describeTopic","topic":"my-topic"}');
    expect(r.action).toBe('describeTopic');
    expect(r.topic).toBe('my-topic');
  });
  it('should parse fetch', () => {
    const r = parseKafkaQuery('{"action":"fetch","topic":"t1","partition":0,"offset":"0","limit":10}');
    expect(r.action).toBe('fetch');
    expect(r.topic).toBe('t1');
    expect(r.partition).toBe(0);
    expect(r.offset).toBe('0');
    expect(r.limit).toBe(10);
  });
  it('should parse produce', () => {
    const r = parseKafkaQuery('{"action":"produce","topic":"t1","key":"k","value":"v"}');
    expect(r.action).toBe('produce');
  });
  it('should throw on invalid JSON', () => {
    expect(() => parseKafkaQuery('not json')).toThrow();
  });
  it('should throw on unknown action', () => {
    expect(() => parseKafkaQuery('{"action":"delete"}')).toThrow();
  });
  it('should throw on missing action', () => {
    expect(() => parseKafkaQuery('{"topic":"t1"}')).toThrow();
  });
});
