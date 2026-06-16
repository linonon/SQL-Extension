import { Component, type ErrorInfo, type ReactNode } from 'react';

interface ErrorBoundaryProps {
  readonly children: ReactNode;
}

interface ErrorBoundaryState {
  readonly error: Error | null;
  readonly componentStack: string;
}

/**
 * 兜底 React 渲染期 / 生命周期抛出的未捕获错误.
 * 没有它时, 任一组件 render 抛错会卸载整棵树, webview 整页变黑且无法恢复.
 * 捕获后展示错误信息和组件栈, 并提供 Reload (location.reload 会重新挂载 App,
 * App mount 时发 'ready', extension 回 'viewInit' 重新初始化, 从而恢复可用).
 */
export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null, componentStack: '' };

  static getDerivedStateFromError(error: Error): Partial<ErrorBoundaryState> {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // 完整堆栈打到 webview devtools console, 便于定位抛错组件
    console.error('[webview] render crash:', error, info.componentStack);
    this.setState({ componentStack: info.componentStack ?? '' });
  }

  private readonly handleReload = (): void => {
    window.location.reload();
  };

  render(): ReactNode {
    const { error, componentStack } = this.state;
    if (!error) {
      return this.props.children;
    }

    return (
      <div
        style={{
          padding: 16,
          fontFamily: 'var(--vscode-font-family)',
          color: 'var(--vscode-errorForeground, #f48771)',
          height: '100%',
          boxSizing: 'border-box',
          overflow: 'auto',
        }}
      >
        <h3 style={{ marginTop: 0 }}>页面渲染出错 (Render Error)</h3>
        <p style={{ color: 'var(--vscode-foreground)' }}>
          下方是错误详情. 截图发给开发者即可定位; 点 Reload 可重新加载本面板.
        </p>
        <button
          onClick={this.handleReload}
          style={{
            marginBottom: 12,
            padding: '4px 12px',
            cursor: 'pointer',
            color: 'var(--vscode-button-foreground)',
            background: 'var(--vscode-button-background)',
            border: 'none',
            borderRadius: 2,
          }}
        >
          Reload
        </button>
        <pre
          style={{
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
            background: 'var(--vscode-textCodeBlock-background, rgba(0,0,0,0.2))',
            color: 'var(--vscode-foreground)',
            padding: 12,
            borderRadius: 4,
            fontSize: 12,
            lineHeight: 1.5,
          }}
        >
          {error.message}
          {error.stack ? `\n\n${error.stack}` : ''}
          {componentStack ? `\n\nComponent stack:${componentStack}` : ''}
        </pre>
      </div>
    );
  }
}
