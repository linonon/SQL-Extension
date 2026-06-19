import '@testing-library/jest-dom/vitest';

// mock acquireVsCodeApi
const mockPostMessage = vi.fn();
const mockGetState = vi.fn(() => undefined);
const mockSetState = vi.fn();

(globalThis as Record<string, unknown>).acquireVsCodeApi = () => ({
  postMessage: mockPostMessage,
  getState: mockGetState,
  setState: mockSetState,
});

// jsdom 未实现 scrollIntoView (调用会抛); 真实 webview (Chromium) 有. 测试环境 stub 掉.
Element.prototype.scrollIntoView = vi.fn();

// 每个 test 之间重置 mock
beforeEach(() => {
  mockPostMessage.mockClear();
  mockGetState.mockClear();
  mockSetState.mockClear();
});

export { mockPostMessage, mockGetState, mockSetState };
