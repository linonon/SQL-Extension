import { useState } from 'react';
import { detectLeafType, type LeafType } from './mongo-leaf-type';

interface TreeNodeProps {
  readonly name: string;
  readonly value: unknown;
  readonly depth: number;
}

const LEAF_CLASS: Record<LeafType, string> = {
  ObjectId: 'leaf-id', Date: 'leaf-date', Long: 'leaf-num', Int: 'leaf-num',
  Decimal128: 'leaf-num', MinKey: 'leaf-key', MaxKey: 'leaf-key',
  string: 'leaf-str', number: 'leaf-num', boolean: 'leaf-bool', null: 'leaf-null',
};

const MAX_STR = 200;

function isContainer(v: unknown): v is Record<string, unknown> | unknown[] {
  return v !== null && typeof v === 'object';
}

function Leaf({ value }: { readonly value: unknown }) {
  const [expanded, setExpanded] = useState(false);
  const type = detectLeafType(value);
  const raw = value === null ? 'null' : typeof value === 'string' ? value : String(value);
  const display = type === 'string' ? `"${raw}"` : raw;
  const long = display.length > MAX_STR;
  const shown = long && !expanded ? display.slice(0, MAX_STR) + '...' : display;
  return (
    <span className={`mongo-tree-leaf ${LEAF_CLASS[type]}`}>
      {shown}
      {long && (
        <button className="mongo-tree-more" onClick={() => setExpanded((e) => !e)}>
          {expanded ? 'less' : 'more'}
        </button>
      )}
      {(type !== 'string' && type !== 'number' && type !== 'boolean' && type !== 'null') && (
        <span className="mongo-tree-badge">{type}</span>
      )}
    </span>
  );
}

function TreeNode({ name, value, depth }: TreeNodeProps) {
  // 容器节点默认折叠, 点击 field-name 行展开
  const [expanded, setExpanded] = useState(false);

  if (!isContainer(value)) {
    return (
      <div className="mongo-tree-row" style={{ paddingLeft: depth * 16 }}>
        <span className="mongo-tree-key">{name}</span>: <Leaf value={value} />
      </div>
    );
  }

  const entries: ReadonlyArray<[string, unknown]> = Array.isArray(value)
    ? value.map((v, i) => [String(i), v])
    : Object.entries(value);
  const summary = Array.isArray(value) ? `[ ${entries.length} items ]` : `{ ${entries.length} fields }`;

  return (
    <div>
      <div
        className="mongo-tree-row mongo-tree-toggle"
        style={{ paddingLeft: depth * 16 }}
        onClick={() => setExpanded((e) => !e)}
      >
        <i className={`ti ti-chevron-${expanded ? 'down' : 'right'} mongo-tree-chevron`} aria-hidden="true" />
        <span className="mongo-tree-key">{name}</span>
        {!expanded && <span className="mongo-tree-summary"> {summary}</span>}
      </div>
      {expanded && entries.map(([k, v]) => (
        <TreeNode key={k} name={k} value={v} depth={depth + 1} />
      ))}
    </div>
  );
}

export function MongoJsonTree({ value }: { readonly value: Record<string, unknown> }) {
  return (
    <div className="mongo-json-tree">
      {Object.entries(value).map(([k, v]) => (
        <TreeNode key={k} name={k} value={v} depth={0} />
      ))}
    </div>
  );
}
