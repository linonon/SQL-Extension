// 把 MongoDB explain('executionStats') 输出提炼成精简摘要, 供 UI 展示索引使用情况.

export interface ExplainSummary {
  readonly stage: string;           // 关键阶段: IXSCAN / COLLSCAN / ...
  readonly indexName?: string;      // 命中的索引名 (若走索引)
  readonly docsExamined: number;    // 扫描文档数
  readonly keysExamined: number;    // 扫描索引键数
  readonly nReturned: number;       // 返回文档数
  readonly executionTimeMillis: number;
  readonly isCollScan: boolean;     // 是否全表扫描 (无索引, 性能警告)
}

interface PlanNode {
  readonly stage?: string;
  readonly indexName?: string;
  readonly inputStage?: PlanNode;
  readonly inputStages?: readonly PlanNode[];
}

function collectPlan(plan: PlanNode | undefined): { stages: string[]; indexName?: string } {
  const stages: string[] = [];
  let indexName: string | undefined;
  const walk = (node: PlanNode | undefined): void => {
    if (!node || typeof node !== 'object') { return; }
    if (typeof node.stage === 'string') { stages.push(node.stage); }
    if (typeof node.indexName === 'string' && indexName === undefined) { indexName = node.indexName; }
    if (node.inputStage) { walk(node.inputStage); }
    if (Array.isArray(node.inputStages)) { node.inputStages.forEach(walk); }
  };
  walk(plan);
  return { stages, indexName };
}

export function summarizeExplain(explain: unknown): ExplainSummary {
  const e = (explain ?? {}) as {
    queryPlanner?: { winningPlan?: PlanNode };
    executionStats?: Record<string, unknown>;
  };
  const { stages, indexName } = collectPlan(e.queryPlanner?.winningPlan);
  const isCollScan = stages.includes('COLLSCAN');
  const hasIxScan = stages.includes('IXSCAN');
  const stage = hasIxScan ? 'IXSCAN' : isCollScan ? 'COLLSCAN' : (stages[0] ?? 'UNKNOWN');

  const stats = e.executionStats ?? {};
  const num = (v: unknown) => Number(v ?? 0);
  return {
    stage,
    indexName: hasIxScan ? indexName : undefined,
    docsExamined: num(stats.totalDocsExamined),
    keysExamined: num(stats.totalKeysExamined),
    nReturned: num(stats.nReturned),
    executionTimeMillis: num(stats.executionTimeMillis),
    isCollScan,
  };
}
