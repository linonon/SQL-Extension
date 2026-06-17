import { describe, it, expect } from 'vitest';
import { summarizeExplain } from './mongo-explain';

const ixscan = {
  queryPlanner: {
    winningPlan: {
      stage: 'FETCH',
      inputStage: { stage: 'IXSCAN', indexName: 'age_1' },
    },
  },
  executionStats: {
    nReturned: 5,
    executionTimeMillis: 2,
    totalKeysExamined: 5,
    totalDocsExamined: 5,
  },
};

const collscan = {
  queryPlanner: { winningPlan: { stage: 'COLLSCAN' } },
  executionStats: {
    nReturned: 5,
    executionTimeMillis: 40,
    totalKeysExamined: 0,
    totalDocsExamined: 100000,
  },
};

describe('summarizeExplain', () => {
  it('IXSCAN: 提取索引名 + 统计, 非全表扫描', () => {
    const s = summarizeExplain(ixscan);
    expect(s.stage).toBe('IXSCAN');
    expect(s.indexName).toBe('age_1');
    expect(s.isCollScan).toBe(false);
    expect(s.docsExamined).toBe(5);
    expect(s.keysExamined).toBe(5);
    expect(s.nReturned).toBe(5);
    expect(s.executionTimeMillis).toBe(2);
  });

  it('COLLSCAN: 标记为全表扫描, 无索引名', () => {
    const s = summarizeExplain(collscan);
    expect(s.stage).toBe('COLLSCAN');
    expect(s.isCollScan).toBe(true);
    expect(s.indexName).toBeUndefined();
    expect(s.docsExamined).toBe(100000);
  });

  it('空/异常输入不抛错, 给默认值', () => {
    const s = summarizeExplain(undefined);
    expect(s.docsExamined).toBe(0);
    expect(s.isCollScan).toBe(false);
  });
});
