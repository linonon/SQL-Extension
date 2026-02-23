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

// 每个 test 之间重置 mock
beforeEach(() => {
  mockPostMessage.mockClear();
  mockGetState.mockClear();
  mockSetState.mockClear();
});

export { mockPostMessage, mockGetState, mockSetState };
