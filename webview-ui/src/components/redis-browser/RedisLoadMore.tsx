import { useState } from 'react';

interface RedisLoadMoreProps {
  // 未保存的编辑数: 加载下一页会刷新 value, 编辑器随之清空编辑, 有则先就地确认
  readonly pendingEdits: number;
  readonly onLoadMore: () => void;
}

export function RedisLoadMore({ pendingEdits, onLoadMore }: RedisLoadMoreProps) {
  const [confirming, setConfirming] = useState(false);

  // 编辑已保存或撤回 (pendingEdits 归零) 时收起确认, 免得下次编辑不点 Load More 就弹出
  if (confirming && pendingEdits === 0) {
    setConfirming(false);
  }

  if (confirming) {
    return (
      <div className="redis-load-more redis-load-more-confirm">
        <span>Loading more discards {pendingEdits} unsaved edit(s).</span>
        <button onClick={() => { setConfirming(false); onLoadMore(); }}>Discard and Load More</button>
        <button className="secondary" onClick={() => setConfirming(false)}>Cancel</button>
      </div>
    );
  }

  return (
    <div className="redis-load-more">
      <button className="secondary" onClick={() => (pendingEdits > 0 ? setConfirming(true) : onLoadMore())}>
        Load More
      </button>
    </div>
  );
}
