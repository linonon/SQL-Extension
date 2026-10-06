import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { useVSCodeMessage } from '../../hooks/useVSCodeMessage';
import { usePostMessage } from '../../hooks/usePostMessage';
import type { ExtensionMessage, MongoQueryInputs } from '../../../../src/types/messages';

// target 'sql': SQL 编辑器, 回答里的 ```sql 块替换选区或整个编辑器.
// target 'mongo': Mongo 查询栏, 回答里按输入框命名的块 (```filter 等) 填进五个输入框, 不自动 Apply
type AiAskBarProps = {
  readonly database: string;
  // 上一次执行 (Mongo: 上一次 Apply 的查询) 失败时的报错, 随提问发出
  readonly lastError?: string;
  readonly onClose: () => void;
} & (
  | {
    readonly target: 'sql';
    readonly sql: string;
    readonly selection: string;
    readonly selectionStart: number;
    readonly onApply: (sql: string) => void;
  }
  | {
    readonly target: 'mongo';
    readonly collection: string;
    readonly inputs: MongoQueryInputs;
    readonly onFill: (inputs: MongoQueryInputs) => void;
  }
);

/** 提问那一刻的选区; selection 为空表示针对整个编辑器 */
export interface SelectionSnapshot {
  readonly selection: string;
  readonly start: number;
}

/** 回答里第一个 info string 为 name 的 fenced 块的内容 */
export function extractBlock(answer: string, name: string): string | null {
  const m = new RegExp('```' + name + '\\b[^\\n]*\\n([\\s\\S]*?)```', 'i').exec(answer);
  return m ? m[1].trim() : null;
}

const MONGO_BOXES = ['filter', 'sort', 'projection', 'limit', 'skip'] as const;

/**
 * 回答里按输入框命名的块合起来就是完整查询: 缺块的输入框清空 (Limit / Skip 回到默认). 一个块都没有返回 null.
 * 只提取不校验: 写错的在 Apply 时由宿主解析报错, 下次提问带上它
 */
export function extractMongoBlocks(answer: string): MongoQueryInputs | null {
  const found = MONGO_BOXES.map((box) => extractBlock(answer, box));
  if (found.every((b) => b === null)) return null;
  const [filter, sort, projection, limit, skip] = found.map((b) => b ?? '');
  return { filter, sort, projection, limit, skip };
}

/**
 * 按提问时的选区位置拼接: 有选区只替换原位置 (保留首尾空白, 免得和下一句粘在一起), 无选区替换整段.
 * 原位置的文本已被改动则返回 null, 由调用方提示手动复制, 不猜测替换哪里.
 */
export function applySql(current: string, snap: SelectionSnapshot, generated: string): string | null {
  if (!snap.selection) {
    return generated;
  }
  if (!current.startsWith(snap.selection, snap.start)) {
    return null;
  }
  const lead = /^\s*/.exec(snap.selection)![0];
  const trail = /\s*$/.exec(snap.selection)![0];
  return current.slice(0, snap.start) + lead + generated + trail + current.slice(snap.start + snap.selection.length);
}

// 同一 webview 内唯一即可: 扩展回执带回 id, 旧提问的残余 chunk 不会串进新回答
let askSeq = 0;

// 内联提问: 问题 + 当前查询 + 上次报错 + 结构 (SQL 表结构 / Mongo 采样字段类型) 交给 AI 模型, 回答里的查询可一键套用
export function AiAskBar(props: AiAskBarProps) {
  const { database, lastError, onClose } = props;
  const postMessage = usePostMessage();
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const reqId = useRef('');
  const busyRef = useRef(false);
  const [question, setQuestion] = useState('');
  const [answer, setAnswer] = useState('');
  const [busy, setBusy] = useState(false);
  const [model, setModel] = useState('');
  const [error, setError] = useState('');
  const [snap, setSnap] = useState<SelectionSnapshot>({ selection: '', start: 0 });
  const [models, setModels] = useState<{ id: string; name: string }[]>([]);
  const [modelId, setModelId] = useState('');
  // 套用 / 填入前的内容, 供一次撤回 (受控输入整段赋值会丢原生 undo 栈)
  const [undo, setUndo] = useState<(() => void) | null>(null);

  useEffect(() => {
    inputRef.current?.focus();
    postMessage({ type: 'aiListModels' });
  }, [postMessage]);

  // 卸载时 (关闭 / 切表或切集合重挂载) 取消进行中的提问
  useEffect(() => () => {
    if (busyRef.current) postMessage({ type: 'aiCancel' });
  }, [postMessage]);

  const handleMessage = useCallback((message: ExtensionMessage) => {
    if (message.type === 'aiModels') {
      setModels(message.models);
      // selected 是扩展侧实际会用的模型 (设置不可用时已回落到第一个)
      setModelId(message.selected);
      return;
    }
    // 笼统失败 (如按需重连失败, 提问没送到) 由 App 显示, 这里只结束 busy
    if (message.type === 'error') {
      busyRef.current = false;
      setBusy(false);
      return;
    }
    if ((message.type !== 'aiChunk' && message.type !== 'aiDone') || message.id !== reqId.current) return;
    if (message.type === 'aiChunk') {
      setAnswer((prev) => prev + message.text);
      return;
    }
    busyRef.current = false;
    setBusy(false);
    setModel(message.model ?? '');
    setError(message.error ?? '');
  }, []);
  useVSCodeMessage(handleMessage);

  const ask = useCallback(() => {
    const q = question.trim();
    if (!q || busy) return;
    reqId.current = String(++askSeq);
    busyRef.current = true;
    setAnswer('');
    setError('');
    setModel('');
    setUndo(null);
    setBusy(true);
    const err = lastError ? { lastError } : {};
    if (props.target === 'sql') {
      const s = { selection: props.selection.trim() ? props.selection : '', start: props.selectionStart };
      setSnap(s);
      postMessage({ type: 'aiAsk', id: reqId.current, database, question: q, sql: props.sql, selection: s.selection, ...err });
    } else {
      postMessage({ type: 'mongoAiAsk', id: reqId.current, database, collection: props.collection, question: q, ...props.inputs, ...err });
    }
  }, [question, busy, props, database, lastError, postMessage]);

  const handleKeyDown = useCallback((e: KeyboardEvent<HTMLTextAreaElement>) => {
    // 输入法组字中的 Enter / Esc 属于输入法, 不提交也不关闭
    if (e.nativeEvent.isComposing || e.keyCode === 229) return;
    // Enter 提交, Shift+Enter 换行
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); ask(); }
    if (e.key === 'Escape') { e.preventDefault(); onClose(); }
  }, [ask, onClose]);

  // 回答里可套用的查询 (流式输出中不给); run 缺省表示不可套用
  let action: { label: string; title?: string; run?: () => void } | null = null;
  if (!busy && props.target === 'sql') {
    const generated = extractBlock(answer, 'sql');
    const applied = generated ? applySql(props.sql, snap, generated) : null;
    const { sql, onApply } = props;
    if (generated) {
      action = applied === null
        ? { label: 'Selection changed', title: 'The selected SQL changed since you asked; copy the answer manually' }
        : { label: snap.selection ? 'Replace selection' : 'Replace editor', run: () => { setUndo(() => () => onApply(sql)); onApply(applied); } };
    }
  } else if (!busy && props.target === 'mongo') {
    const filled = extractMongoBlocks(answer);
    const { inputs, onFill } = props;
    if (filled) {
      action = { label: 'Fill query', title: 'Fill the query inputs; click Apply to run it', run: () => { setUndo(() => () => onFill(inputs)); onFill(filled); } };
    }
  }

  return (
    <div className="ai-ask-bar">
      <div className="ai-ask-row">
        <textarea
          ref={inputRef}
          className="ai-ask-input"
          rows={1}
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={props.target === 'mongo'
            ? 'Describe the documents you want...'
            : props.selection ? 'Ask about the selected SQL...' : 'Ask or describe the query you want...'}
          data-testid="ai-ask-input"
        />
        {models.length > 0 && (
          <select
            className="ai-ask-model"
            value={modelId}
            title="AI model (saved to setting sqlext.ai.model)"
            onChange={(e) => { setModelId(e.target.value); postMessage({ type: 'aiSetModel', id: e.target.value }); }}
          >
            {models.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}
          </select>
        )}
        {busy
          ? <button onClick={() => postMessage({ type: 'aiCancel' })}>Stop</button>
          : <button onClick={ask} disabled={!question.trim()}>Ask</button>}
        <button onClick={onClose} title="Close (Esc)">Close</button>
      </div>
      {(answer || error) && (
        <div className="ai-ask-answer">
          {error && <div className="ai-ask-error">{error}</div>}
          {answer && <pre>{answer}</pre>}
        </div>
      )}
      {(action || undo || model) && (
        <div className="ai-ask-row">
          {action && !undo && (
            <button disabled={!action.run} title={action.title} onClick={action.run}>{action.label}</button>
          )}
          {undo && (
            <button onClick={() => { undo(); setUndo(null); }}>{props.target === 'sql' ? 'Undo apply' : 'Undo fill'}</button>
          )}
          {model && <span className="hint">{model}</span>}
        </div>
      )}
    </div>
  );
}
