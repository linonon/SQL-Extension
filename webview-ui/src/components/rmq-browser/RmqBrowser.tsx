import { useCallback, useEffect, useRef, useState } from 'react';
import { useVSCodeMessage } from '../../hooks/useVSCodeMessage';
import { usePostMessage } from '../../hooks/usePostMessage';
import type { ExtensionMessage } from '../../types/messages';
import type { RmqQueueInfo, RmqMessage } from '../../types/rabbitmq';
import { RmqQueueList } from './RmqQueueList';
import { RmqMessagePanel } from './RmqMessagePanel';
import '../../styles/rmq-browser.css';

interface RmqBrowserProps {
  readonly connectionId: string;
}

export function RmqBrowser({ connectionId }: RmqBrowserProps) {
  const [queues, setQueues] = useState<readonly RmqQueueInfo[]>([]);
  const [selectedQueue, setSelectedQueue] = useState<string | null>(null);
  const [messages, setMessages] = useState<readonly RmqMessage[]>([]);
  const [loading, setLoading] = useState(false);
  const [panelWidth, setPanelWidth] = useState(280);

  const postMessage = usePostMessage();
  const resizing = useRef(false);
  const startX = useRef(0);
  const startWidth = useRef(0);

  const handleMessage = useCallback((msg: ExtensionMessage) => {
    switch (msg.type) {
      case 'rmqQueueList':
        setQueues(msg.queues);
        break;
      case 'rmqMessageList':
        setMessages(msg.messages);
        setLoading(false);
        break;
    }
  }, []);

  useVSCodeMessage(handleMessage);

  // 初始加载 queue 列表
  useEffect(() => {
    postMessage({ type: 'rmqListQueues' });
  }, [postMessage]);

  const handleSelectQueue = useCallback((queue: string) => {
    setSelectedQueue(queue);
    // 选中 queue 时清空消息列表, 不自动 peek (有副作用)
    setMessages([]);
  }, []);

  const handlePeek = useCallback((count: number) => {
    if (!selectedQueue) { return; }
    setLoading(true);
    postMessage({
      type: 'rmqPeekMessages',
      queue: selectedQueue,
      count,
    });
  }, [selectedQueue, postMessage]);

  // resize handle
  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    resizing.current = true;
    startX.current = e.clientX;
    startWidth.current = panelWidth;

    const onMouseMove = (ev: MouseEvent) => {
      if (!resizing.current) { return; }
      const delta = ev.clientX - startX.current;
      setPanelWidth(Math.max(140, Math.min(600, startWidth.current + delta)));
    };

    const onMouseUp = () => {
      resizing.current = false;
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };

    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  }, [panelWidth]);

  return (
    <div className="rmq-browser">
      <div className="rmq-body">
        <div className="rmq-left-panel" style={{ width: panelWidth }}>
          <RmqQueueList
            queues={queues}
            selectedQueue={selectedQueue}
            onSelectQueue={handleSelectQueue}
          />
        </div>
        <div className="rmq-resize-handle" onMouseDown={handleMouseDown} />
        <div className="rmq-right-panel">
          {selectedQueue ? (
            <RmqMessagePanel
              queue={selectedQueue}
              messages={messages}
              loading={loading}
              onPeek={handlePeek}
            />
          ) : (
            <div className="rmq-empty">Select a queue to browse messages</div>
          )}
        </div>
      </div>
    </div>
  );
}
