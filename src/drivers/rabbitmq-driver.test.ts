import { describe, it, expect, vi, beforeEach } from 'vitest';
import { RabbitMQDriver } from './rabbitmq-driver';
import type { EventEmitter } from 'events';

// --- mock http/https ---

interface MockResponse {
  statusCode: number;
  on: (event: string, cb: (...args: unknown[]) => void) => MockResponse;
}

interface MockRequest {
  on: (event: string, cb: (...args: unknown[]) => void) => MockRequest;
  setTimeout: (ms: number, cb: () => void) => void;
  write: (data: string) => void;
  end: () => void;
  destroy: () => void;
}

// 用于在测试中控制 mock response 的行为
let onRequestCallback: ((res: MockResponse) => void) | null = null;
let onRequestError: ((err: Error) => void) | null = null;
let lastRequestOptions: Record<string, unknown> | null = null;
let lastRequestBody: string | null = null;

function createMockRequest(): MockRequest {
  const listeners: Record<string, ((...args: unknown[]) => void)[]> = {};
  const req: MockRequest = {
    on(event: string, cb: (...args: unknown[]) => void) {
      if (!listeners[event]) { listeners[event] = []; }
      listeners[event].push(cb);
      if (event === 'error') { onRequestError = cb as (err: Error) => void; }
      return req;
    },
    setTimeout(_ms: number, _cb: () => void) {
      // 测试中不触发 timeout
    },
    write(data: string) {
      lastRequestBody = data;
    },
    end() {
      // 触发 response callback
    },
    destroy() {},
  };
  return req;
}

function createMockResponse(statusCode: number, body: string): MockResponse {
  const listeners: Record<string, ((...args: unknown[]) => void)[]> = {};
  const res: MockResponse = {
    statusCode,
    on(event: string, cb: (...args: unknown[]) => void) {
      if (!listeners[event]) { listeners[event] = []; }
      listeners[event].push(cb);
      // 在注册完 data 和 end 后自动触发
      if (event === 'end') {
        // 异步触发 data + end
        setTimeout(() => {
          for (const dataCb of (listeners['data'] ?? [])) {
            dataCb(Buffer.from(body));
          }
          for (const endCb of (listeners['end'] ?? [])) {
            endCb();
          }
        }, 0);
      }
      return res;
    },
  };
  return res;
}

// mock request 函数: 捕获 options, 调用 callback
function mockRequestFn(options: Record<string, unknown>, callback: (res: MockResponse) => void) {
  lastRequestOptions = options;
  onRequestCallback = callback;
  return createMockRequest();
}

vi.mock('http', () => ({
  request: vi.fn((...args: unknown[]) => {
    const options = args[0] as Record<string, unknown>;
    const callback = args[1] as (res: MockResponse) => void;
    return mockRequestFn(options, callback);
  }),
}));

vi.mock('https', () => ({
  request: vi.fn((...args: unknown[]) => {
    const options = args[0] as Record<string, unknown>;
    const callback = args[1] as (res: MockResponse) => void;
    return mockRequestFn(options, callback);
  }),
}));

// helper: 让 mock request 立即成功返回
function resolveRequest(statusCode: number, body: string) {
  if (onRequestCallback) {
    const res = createMockResponse(statusCode, body);
    onRequestCallback(res);
  }
}

// helper: 让 mock request 触发 error
function rejectRequest(message: string) {
  if (onRequestError) {
    onRequestError(new Error(message));
  }
}

// 因为 http.request 是异步触发的, 需要 patch end 方法来自动 resolve
// 重新设计: 直接在 mock 中自动 resolve
vi.mock('http', () => ({
  request: vi.fn(),
}));

vi.mock('https', () => ({
  request: vi.fn(),
}));

import * as http from 'http';
import * as https from 'https';

// helper: 设置 mock 返回特定 statusCode + body
function setupMockResponse(statusCode: number, body: string) {
  const mockFn = vi.mocked(http.request);
  mockFn.mockImplementation((...args: unknown[]) => {
    const options = args[0] as Record<string, unknown>;
    const callback = args[1] as (res: MockResponse) => void;
    lastRequestOptions = options;
    lastRequestBody = null;

    const resListeners: Record<string, ((...args: unknown[]) => void)[]> = {};
    const res: MockResponse = {
      statusCode,
      on(event: string, cb: (...args: unknown[]) => void) {
        if (!resListeners[event]) { resListeners[event] = []; }
        resListeners[event].push(cb);
        if (event === 'end') {
          // 同步触发 data + end (在 microtask 中)
          Promise.resolve().then(() => {
            for (const dataCb of (resListeners['data'] ?? [])) {
              dataCb(Buffer.from(body));
            }
            for (const endCb of (resListeners['end'] ?? [])) {
              endCb();
            }
          });
        }
        return res;
      },
    };

    // 调用 response callback
    callback(res);

    // 返回 mock request
    const reqListeners: Record<string, ((...args: unknown[]) => void)[]> = {};
    const req = {
      on(event: string, cb: (...args: unknown[]) => void) {
        if (!reqListeners[event]) { reqListeners[event] = []; }
        reqListeners[event].push(cb);
        return req;
      },
      setTimeout(_ms: number, _cb: () => void) { return req; },
      write(data: string) { lastRequestBody = data; },
      end() {},
      destroy() {},
    };
    return req as unknown as ReturnType<typeof http.request>;
  });
}

// helper: 设置 mock 触发网络错误
function setupMockError(errorMessage: string) {
  const mockFn = vi.mocked(http.request);
  mockFn.mockImplementation((...args: unknown[]) => {
    const options = args[0] as Record<string, unknown>;
    const callback = args[1] as (res: MockResponse) => void;
    lastRequestOptions = options;

    const reqListeners: Record<string, ((...args: unknown[]) => void)[]> = {};
    const req = {
      on(event: string, cb: (...args: unknown[]) => void) {
        if (!reqListeners[event]) { reqListeners[event] = []; }
        reqListeners[event].push(cb);
        // 注册 error 后立即触发
        if (event === 'error') {
          Promise.resolve().then(() => {
            cb(new Error(errorMessage));
          });
        }
        return req;
      },
      setTimeout(_ms: number, _cb: () => void) { return req; },
      write(_data: string) {},
      end() {},
      destroy() {},
    };
    return req as unknown as ReturnType<typeof http.request>;
  });
}

const TEST_CONFIG = {
  id: 'test-id',
  name: 'test-rabbit',
  driverType: 'rabbitmq' as const,
  host: 'localhost',
  port: 15672,
  username: 'guest',
  password: 'guest',
  database: '/',
};

describe('RabbitMQDriver', () => {
  let driver: RabbitMQDriver;

  beforeEach(() => {
    driver = new RabbitMQDriver();
    vi.clearAllMocks();
    lastRequestOptions = null;
    lastRequestBody = null;
  });

  describe('connect', () => {
    it('成功连接: 发起 GET /api/overview', async () => {
      setupMockResponse(200, '{"management_version":"3.12.0"}');

      await driver.connect(TEST_CONFIG);

      expect(http.request).toHaveBeenCalled();
      expect(lastRequestOptions).toMatchObject({
        hostname: 'localhost',
        port: 15672,
        path: '/api/overview',
        method: 'GET',
      });
    });

    it('authHeader 应该是 Base64 编码的 user:password', async () => {
      setupMockResponse(200, '{}');

      await driver.connect(TEST_CONFIG);

      const expectedAuth = 'Basic ' + Buffer.from('guest:guest').toString('base64');
      expect(lastRequestOptions).toHaveProperty('headers.Authorization', expectedAuth);
    });

    it('vhost 默认值为 /', async () => {
      setupMockResponse(200, '{}');

      const configNoDb = { ...TEST_CONFIG, database: '' };
      await driver.connect(configNoDb);

      expect(driver.isConnected()).toBe(true);
    });

    it('HTTP 401 应该抛出错误', async () => {
      setupMockResponse(401, 'Unauthorized');

      await expect(driver.connect(TEST_CONFIG)).rejects.toThrow('RabbitMQ API error (401)');
    });

    it('HTTP 500 应该抛出错误', async () => {
      setupMockResponse(500, 'Internal Server Error');

      await expect(driver.connect(TEST_CONFIG)).rejects.toThrow('RabbitMQ API error (500)');
    });

    it('网络错误应该抛出错误', async () => {
      setupMockError('ECONNREFUSED');

      await expect(driver.connect(TEST_CONFIG)).rejects.toThrow('RabbitMQ connection failed: ECONNREFUSED');
    });
  });

  describe('disconnect', () => {
    it('调用后 isConnected 返回 false', async () => {
      setupMockResponse(200, '{}');
      await driver.connect(TEST_CONFIG);
      expect(driver.isConnected()).toBe(true);

      await driver.disconnect();
      expect(driver.isConnected()).toBe(false);
    });
  });

  describe('isConnected', () => {
    it('connect 前返回 false', () => {
      expect(driver.isConnected()).toBe(false);
    });

    it('connect 后返回 true', async () => {
      setupMockResponse(200, '{}');
      await driver.connect(TEST_CONFIG);
      expect(driver.isConnected()).toBe(true);
    });
  });

  describe('listQueues', () => {
    it('未连接时抛出 Not connected', async () => {
      await expect(driver.listQueues()).rejects.toThrow('Not connected');
    });

    it('vhost / 应该 URL encode 为 %2F', async () => {
      // connect
      setupMockResponse(200, '{}');
      await driver.connect(TEST_CONFIG);

      // listQueues
      const queuesData = [
        { name: 'q1', messages: 10, consumers: 2, state: 'running', durable: true, auto_delete: false, type: 'classic' },
      ];
      setupMockResponse(200, JSON.stringify(queuesData));

      await driver.listQueues();

      expect(lastRequestOptions).toHaveProperty('path', '/api/queues/%2F');
    });

    it('返回值正确映射字段', async () => {
      setupMockResponse(200, '{}');
      await driver.connect(TEST_CONFIG);

      const queuesData = [
        { name: 'test-queue', messages: 5, consumers: 1, state: 'running', durable: true, auto_delete: false, type: 'classic' },
        { name: 'other-queue', messages: 0, consumers: 0, state: 'idle', durable: false, auto_delete: true, type: 'quorum' },
      ];
      setupMockResponse(200, JSON.stringify(queuesData));

      const result = await driver.listQueues();

      expect(result).toEqual([
        { name: 'test-queue', messages: 5, consumers: 1, state: 'running', durable: true, autoDelete: false, type: 'classic' },
        { name: 'other-queue', messages: 0, consumers: 0, state: 'idle', durable: false, autoDelete: true, type: 'quorum' },
      ]);
    });

    it('自定义 vhost 应正确编码', async () => {
      setupMockResponse(200, '{}');
      const config = { ...TEST_CONFIG, database: 'my-vhost' };
      await driver.connect(config);

      setupMockResponse(200, '[]');
      await driver.listQueues();

      expect(lastRequestOptions).toHaveProperty('path', '/api/queues/my-vhost');
    });
  });

  describe('peekMessages', () => {
    beforeEach(async () => {
      setupMockResponse(200, '{}');
      await driver.connect(TEST_CONFIG);
    });

    it('未连接时抛出 Not connected', async () => {
      const disconnected = new RabbitMQDriver();
      await expect(disconnected.peekMessages('q', 10)).rejects.toThrow('Not connected');
    });

    it('count 超过 50 时截断为 50', async () => {
      setupMockResponse(200, '[]');

      await driver.peekMessages('test-queue', 100);

      const body = JSON.parse(lastRequestBody ?? '{}');
      expect(body.count).toBe(50);
    });

    it('count 小于 50 时保持原值', async () => {
      setupMockResponse(200, '[]');

      await driver.peekMessages('test-queue', 5);

      const body = JSON.parse(lastRequestBody ?? '{}');
      expect(body.count).toBe(5);
    });

    it('POST body 构造正确', async () => {
      setupMockResponse(200, '[]');

      await driver.peekMessages('test-queue', 10);

      const body = JSON.parse(lastRequestBody ?? '{}');
      expect(body).toEqual({
        count: 10,
        ackmode: 'ack_requeue_true',
        encoding: 'auto',
        truncate: 50000,
      });
      expect(lastRequestOptions).toHaveProperty('method', 'POST');
    });

    it('请求路径正确编码 vhost 和 queue', async () => {
      setupMockResponse(200, '[]');

      await driver.peekMessages('my queue', 1);

      expect(lastRequestOptions).toHaveProperty('path', '/api/queues/%2F/my%20queue/get');
    });

    it('properties.headers 为 null 时降级为 {}', async () => {
      const messagesData = [{
        payload: 'hello',
        payload_encoding: 'string',
        exchange: '',
        routing_key: 'test',
        redelivered: false,
        properties: {
          content_type: 'text/plain',
          content_encoding: null,
          delivery_mode: 2,
          headers: null,
          timestamp: null,
          message_id: null,
          app_id: null,
        },
      }];
      setupMockResponse(200, JSON.stringify(messagesData));

      const result = await driver.peekMessages('q', 1);

      expect(result[0].properties.headers).toEqual({});
    });

    it('properties.headers 为 undefined 时降级为 {}', async () => {
      // 模拟 API 返回没有 headers 字段的情况 (JSON.parse 后为 undefined)
      const raw = '[{"payload":"hi","payload_encoding":"string","exchange":"","routing_key":"k","redelivered":false,"properties":{"content_type":null,"content_encoding":null,"delivery_mode":null,"timestamp":null,"message_id":null,"app_id":null}}]';
      setupMockResponse(200, raw);

      const result = await driver.peekMessages('q', 1);

      expect(result[0].properties.headers).toEqual({});
    });

    it('正确映射所有 message 字段', async () => {
      const messagesData = [{
        payload: '{"key":"value"}',
        payload_encoding: 'string',
        exchange: 'my-exchange',
        routing_key: 'my.route',
        redelivered: true,
        properties: {
          content_type: 'application/json',
          content_encoding: 'utf-8',
          delivery_mode: 2,
          headers: { 'x-custom': 'val' },
          timestamp: 1700000000,
          message_id: 'msg-001',
          app_id: 'test-app',
        },
      }];
      setupMockResponse(200, JSON.stringify(messagesData));

      const result = await driver.peekMessages('q', 1);

      expect(result).toEqual([{
        payload: '{"key":"value"}',
        payloadEncoding: 'string',
        exchange: 'my-exchange',
        routingKey: 'my.route',
        redelivered: true,
        properties: {
          contentType: 'application/json',
          contentEncoding: 'utf-8',
          deliveryMode: 2,
          headers: { 'x-custom': 'val' },
          timestamp: 1700000000,
          messageId: 'msg-001',
          appId: 'test-app',
        },
      }]);
    });
  });
});
