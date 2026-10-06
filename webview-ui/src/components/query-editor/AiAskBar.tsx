import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { useVSCodeMessage } from '../../hooks/useVSCodeMessage';
import { usePostMessage } from '../../hooks/usePostMessage';
import type { ExtensionMessage } from '../../types/messages';

interface AiAskBarProps {
  readonly database: string;
  readonly sql: string;
  readonly selection: string;
  readonly selectionStart: number;
  readonly onApply: (sql: string) => void;
  readonly onClose: () => void;
}

/** 提问那一刻的选区; selection 为空表示针对整个编辑器 */
export interface SelectionSnapshot {
  readonly selection: string;
  readonly start: number;
}

export function extractSqlBlock(answer: string): string | null {
  const m = /```sql[^\n]*\n([\s\S]*?)```/i.exec(answer);
  return m ? m[1].trim() : null;
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

// 编辑器内联提问: 问题 + 当前 SQL + 表结构交给 Copilot 模型, 回答里的 ```sql 块可一键套用
export function AiAskBar({ database, sql, selection, selectionStart, onApply, onClose }: AiAskBarProps) {
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
  // 套用前的编辑器内容, 供一键撤回 (受控 textarea 整段赋值会丢原生 undo 栈)
  const [beforeApply, setBeforeApply] = useState<string | null>(null);

  useEffect(() => {
    inputRef.current?.focus();
    postMessage({ type: 'aiListModels' });
  }, [postMessage]);

  // 卸载时 (关闭 / 切表重挂载) 取消进行中的提问
  useEffect(() => () => {
    if (busyRef.current) postMessage({ type: 'aiCancel' });
  }, [postMessage]);

  const handleMessage = useCallback((message: ExtensionMessage) => {
    if (message.type === 'aiModels') {
      setModels(message.models);
      // 设置为空或已下线时显示第一个 (与扩展侧回落一致)
      setModelId(message.models.some(m => m.id === message.selected) ? message.selected : (message.models[0]?.id ?? ''));
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
    const s = { selection: selection.trim() ? selection : '', start: selectionStart };
    reqId.current = String(++askSeq);
    busyRef.current = true;
    setSnap(s);
    setAnswer('');
    setError('');
    setModel('');
    setBeforeApply(null);
    setBusy(true);
    postMessage({ type: 'aiAsk', id: reqId.current, database, question: q, sql, selection: s.selection });
  }, [question, busy, selection, selectionStart, database, sql, postMessage]);

  const handleKeyDown = useCallback((e: KeyboardEvent<HTMLTextAreaElement>) => {
    // 输入法组字中的 Enter / Esc 属于输入法, 不提交也不关闭
    if (e.nativeEvent.isComposing || e.keyCode === 229) return;
    // Enter 提交, Shift+Enter 换行
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); ask(); }
    if (e.key === 'Escape') { e.preventDefault(); onClose(); }
  }, [ask, onClose]);

  const generated = busy ? null : extractSqlBlock(answer);
  const applied = generated ? applySql(sql, snap, generated) : null;

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
          placeholder={selection ? 'Ask about the selected SQL...' : 'Ask or describe the query you want...'}
          data-testid="ai-ask-input"
        />
        {models.length > 0 && (
          <select
            className="ai-ask-model"
            value={modelId}
            title="Copilot model (saved to setting sqlext.ai.model)"
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
      {(generated || beforeApply !== null || model) && (
        <div className="ai-ask-row">
          {generated && beforeApply === null && (
            <button
              disabled={applied === null}
              title={applied === null ? 'The selected SQL changed since you asked; copy the answer manually' : undefined}
              onClick={() => { if (applied !== null) { setBeforeApply(sql); onApply(applied); } }}
            >
              {applied === null ? 'Selection changed' : snap.selection ? 'Replace selection' : 'Replace editor'}
            </button>
          )}
          {beforeApply !== null && (
            <button onClick={() => { onApply(beforeApply); setBeforeApply(null); }}>Undo apply</button>
          )}
          {model && <span className="hint">{model}</span>}
        </div>
      )}
    </div>
  );
}
