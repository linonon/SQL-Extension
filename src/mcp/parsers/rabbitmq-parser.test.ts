import { describe, it, expect } from 'vitest';
import { parseRabbitMQQuery, READ_ACTIONS } from './rabbitmq-parser.js';

describe('parseRabbitMQQuery', () => {
  it('should parse listQueues', () => {
    const r = parseRabbitMQQuery('{"action":"listQueues"}');
    expect(r.action).toBe('listQueues');
  });
  it('should parse peek with count', () => {
    const r = parseRabbitMQQuery('{"action":"peek","queue":"my-queue","count":10}');
    expect(r.action).toBe('peek');
    expect(r.queue).toBe('my-queue');
    expect(r.count).toBe(10);
  });
  it('should default peek count to 10', () => {
    const r = parseRabbitMQQuery('{"action":"peek","queue":"q1"}');
    expect(r.count).toBe(10);
  });
  it('should cap peek count at 50', () => {
    const r = parseRabbitMQQuery('{"action":"peek","queue":"q1","count":999}');
    expect(r.count).toBe(50);
  });
  it('should throw on unknown action', () => {
    expect(() => parseRabbitMQQuery('{"action":"publish"}')).toThrow();
  });
});
