import { describe, it, expect } from 'vitest';
import { summarizeExplain } from './mongo-explain';

const ixscan = {
  queryPlanner: {
    winningPlan: {
      stage: 'FETCH',
      inputStage: { stage: 'IXSCAN', indexName: 'age_1' },
    },
  },
};

const collscan = {
  queryPlanner: { winningPlan: { stage: 'COLLSCAN' } },
};

describe('summarizeExplain', () => {
  it('IXSCAN: 提取索引名, 非全表扫描', () => {
    expect(summarizeExplain(ixscan)).toEqual({ stage: 'IXSCAN', indexName: 'age_1', isCollScan: false });
  });

  it('COLLSCAN: 标记为全表扫描, 无索引名', () => {
    expect(summarizeExplain(collscan)).toEqual({ stage: 'COLLSCAN', indexName: undefined, isCollScan: true });
  });

  it('空/异常输入不抛错, 给默认值', () => {
    expect(summarizeExplain(undefined)).toEqual({ stage: 'UNKNOWN', indexName: undefined, isCollScan: false });
  });

  it('SBE 计划: 阶段树在 winningPlan.queryPlan 下', () => {
    const sbe = {
      queryPlanner: {
        winningPlan: {
          queryPlan: { stage: 'FETCH', inputStage: { stage: 'IXSCAN', indexName: 'uid_1' } },
          slotBasedPlan: { slots: '...', stages: '...' },
        },
      },
    };
    expect(summarizeExplain(sbe)).toEqual({ stage: 'IXSCAN', indexName: 'uid_1', isCollScan: false });
    const sbeScan = { queryPlanner: { winningPlan: { queryPlan: { stage: 'COLLSCAN' }, slotBasedPlan: {} } } };
    expect(summarizeExplain(sbeScan).isCollScan).toBe(true);
  });

  it('分片 explain: 从 shards 提取 stage / indexName', () => {
    const sharded = {
      queryPlanner: {
        winningPlan: {
          stage: 'SHARD_MERGE',
          shards: [
            { winningPlan: { stage: 'FETCH', inputStage: { stage: 'IXSCAN', indexName: 'a_1' } } },
          ],
        },
      },
    };
    const s = summarizeExplain(sharded);
    expect(s.stage).toBe('IXSCAN');
    expect(s.indexName).toBe('a_1');
    expect(s.isCollScan).toBe(false);
  });

  it('分片 explain 全表扫描: isCollScan=true', () => {
    const sharded = {
      queryPlanner: { winningPlan: { stage: 'SHARD_MERGE', shards: [{ winningPlan: { stage: 'COLLSCAN' } }] } },
    };
    expect(summarizeExplain(sharded).isCollScan).toBe(true);
  });
});
