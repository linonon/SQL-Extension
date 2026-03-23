export const READ_ACTIONS = ['listTopics', 'describeTopic', 'fetch'] as const;
export const WRITE_ACTIONS = ['produce'] as const;

const ALL_ACTIONS = new Set([...READ_ACTIONS, ...WRITE_ACTIONS]);

export interface KafkaQueryParams {
  action: string;
  topic?: string;
  partition?: number;
  offset?: string;
  limit?: number;
  key?: string;
  value?: string;
  headers?: Record<string, string>;
}

export function parseKafkaQuery(query: string): KafkaQueryParams {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(query);
  } catch {
    throw new Error('Invalid JSON in query. Expected format: {"action":"listTopics"}');
  }

  const action = parsed.action as string | undefined;
  if (!action || typeof action !== 'string') {
    throw new Error('Missing required field: action');
  }
  if (!ALL_ACTIONS.has(action)) {
    throw new Error(`Unknown action '${action}'. Allowed: ${[...ALL_ACTIONS].join(', ')}`);
  }

  return {
    action,
    topic: parsed.topic as string | undefined,
    partition: parsed.partition as number | undefined,
    offset: parsed.offset as string | undefined,
    limit: parsed.limit as number | undefined,
    key: parsed.key as string | undefined,
    value: parsed.value as string | undefined,
    headers: (parsed.headers as Record<string, string> | undefined) ?? undefined,
  };
}
