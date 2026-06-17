import { convertShellToJson } from '../../utils/mongo-shell-to-json';

// 聚合 pipeline 构建器的纯逻辑: stage 卡片 -> db.<coll>.aggregate([...]) 查询串.
// 复用现有 mongoRunQuery 执行路径, 无需后端改动.

export interface AggStage {
  readonly op: string;     // stage operator, 如 $match / $group / $sort
  readonly body: string;   // stage body 文本 (JSON / shell)
  readonly enabled: boolean;
}

// 常见 stage operator, 供 UI 下拉
export const AGG_STAGE_OPS: readonly string[] = [
  '$match', '$group', '$project', '$sort', '$limit', '$skip',
  '$unwind', '$lookup', '$count', '$addFields', '$set', '$unset',
  '$replaceRoot', '$facet', '$bucket', '$sample',
];

export function buildAggregateStages(stages: readonly AggStage[]): unknown[] {
  const pipeline: unknown[] = [];
  let idx = 0;
  for (const s of stages) {
    idx++;
    if (!s.enabled || !s.op.trim()) { continue; }
    const text = s.body.trim();
    let body: unknown = {};
    if (text) {
      try {
        body = JSON.parse(convertShellToJson(text));
      } catch {
        throw new Error(`Stage ${idx} (${s.op}): invalid JSON body`);
      }
    }
    pipeline.push({ [s.op]: body });
  }
  return pipeline;
}

export function buildAggregateQuery(collection: string, stages: readonly AggStage[]): string {
  const pipeline = buildAggregateStages(stages);
  return `db.${collection}.aggregate(${JSON.stringify(pipeline)})`;
}
