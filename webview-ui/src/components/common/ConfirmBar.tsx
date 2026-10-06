interface ConfirmBarProps {
  readonly message: string;
  readonly confirmLabel: string;
  readonly onConfirm: () => void;
  readonly onCancel: () => void;
}

// 行内确认条: webview 里 window.confirm 不可用, 会丢弃数据的动作先在这里确认
export function ConfirmBar({ message, confirmLabel, onConfirm, onCancel }: ConfirmBarProps) {
  return (
    <div className="confirm-bar" role="alertdialog">
      <span>{message}</span>
      <button className="confirm-bar-confirm" onClick={onConfirm}>{confirmLabel}</button>
      <button onClick={onCancel}>Cancel</button>
    </div>
  );
}
