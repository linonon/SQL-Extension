export const READ_ACTIONS = ['listQueues', 'peek'] as const;

const ALL_ACTIONS = new Set<string>([...READ_ACTIONS]);
const MAX_PEEK_COUNT = 50;
const DEFAULT_PEEK_COUNT = 10;

export interface RabbitMQQueryParams {
  action: string;
  queue?: string;
  count?: number;
}

export function parseRabbitMQQuery(query: string): RabbitMQQueryParams {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(query);
  } catch {
    throw new Error('Invalid JSON in query. Expected format: {"action":"listQueues"}');
  }

  const action = parsed.action as string | undefined;
  if (!action || typeof action !== 'string') {
    throw new Error('Missing required field: action');
  }
  if (!ALL_ACTIONS.has(action)) {
    throw new Error(`Unknown action '${action}'. Allowed: ${[...ALL_ACTIONS].join(', ')}`);
  }

  let count: number | undefined;
  if (action === 'peek') {
    const raw = (parsed.count as number | undefined) ?? DEFAULT_PEEK_COUNT;
    count = Math.min(raw, MAX_PEEK_COUNT);
  }

  return {
    action,
    queue: parsed.queue as string | undefined,
    count,
  };
}
