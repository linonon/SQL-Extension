import type { WebviewMessage } from './types/messages';

interface VSCodeApi {
  postMessage(message: WebviewMessage): void;
  getState(): unknown;
  setState(state: unknown): void;
}

// acquireVsCodeApi 只能调用一次, 这里做单例
const vscodeApi: VSCodeApi = (function () {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (window as any).acquireVsCodeApi();
})();

export default vscodeApi;
