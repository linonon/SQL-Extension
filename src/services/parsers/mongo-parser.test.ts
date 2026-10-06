import { describe, it, expect } from 'vitest';
import { parseMongoQuery, READ_METHODS, WRITE_METHODS } from './mongo-parser.js';

describe('parseMongoQuery', () => {
  it('should parse find query', () => {
    const result = parseMongoQuery('{"collection":"users","method":"find","filter":{"age":{"$gt":20}}}');
    expect(result.collection).toBe('users');
    expect(result.method).toBe('find');
    expect(result.filter).toEqual({ age: { $gt: 20 } });
  });
  it('should parse aggregate query', () => {
    const result = parseMongoQuery('{"collection":"users","method":"aggregate","pipeline":[]}');
    expect(result.method).toBe('aggregate');
    expect(result.pipeline).toEqual([]);
  });
  it('should parse insertOne', () => {
    const result = parseMongoQuery('{"collection":"users","method":"insertOne","document":{"name":"foo"}}');
    expect(result.method).toBe('insertOne');
    expect(result.document).toEqual({ name: 'foo' });
  });
  it('should throw on missing collection', () => {
    expect(() => parseMongoQuery('{"method":"find"}')).toThrow('collection');
  });
  it('should throw on missing method', () => {
    expect(() => parseMongoQuery('{"collection":"users"}')).toThrow('method');
  });
  it('should throw on invalid JSON', () => {
    expect(() => parseMongoQuery('not json')).toThrow();
  });
  it('should throw on unknown method', () => {
    expect(() => parseMongoQuery('{"collection":"users","method":"drop"}')).toThrow();
  });
});

describe('method lists', () => {
  it('READ_METHODS should contain read methods', () => {
    expect(READ_METHODS).toContain('find');
    expect(READ_METHODS).toContain('aggregate');
    expect(READ_METHODS).toContain('countDocuments');
  });
  it('WRITE_METHODS should contain write methods', () => {
    expect(WRITE_METHODS).toContain('insertOne');
    expect(WRITE_METHODS).toContain('deleteMany');
    expect(WRITE_METHODS).toContain('createIndex');
    expect(WRITE_METHODS).toContain('dropIndex');
  });
});
