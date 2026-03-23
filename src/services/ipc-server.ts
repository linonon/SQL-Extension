import * as net from 'net';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import type { ConnectionManager } from './connection-manager.js';

const SOCKET_DIR = path.join(os.homedir(), '.sql-extension');
const SOCKET_PATH = path.join(SOCKET_DIR, 'ipc.sock');

interface IpcRequest {
  readonly id: string;
  readonly method: string;
  readonly params?: Record<string, unknown>;
}

interface IpcResponse {
  readonly id: string;
  readonly result?: unknown;
  readonly error?: string;
}

export class IpcServer {
  private server: net.Server | null = null;

  constructor(private readonly connectionManager: ConnectionManager) {}

  start(): void {
    // 清理旧 socket 文件
    try { fs.unlinkSync(SOCKET_PATH); } catch {}
    fs.mkdirSync(SOCKET_DIR, { recursive: true });

    this.server = net.createServer((socket) => {
      let buffer = '';
      socket.on('data', (data) => {
        buffer += data.toString();
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';
        for (const line of lines) {
          if (!line.trim()) { continue; }
          void this.handleMessage(line, socket);
        }
      });
      socket.on('error', () => {});
    });

    this.server.listen(SOCKET_PATH, () => {
      // 仅 owner 可读写
      try { fs.chmodSync(SOCKET_PATH, 0o600); } catch {}
    });

    this.server.on('error', (err) => {
      process.stderr.write(`IPC server error: ${err.message}\n`);
    });
  }

  private async handleMessage(raw: string, socket: net.Socket): Promise<void> {
    let req: IpcRequest;
    try {
      req = JSON.parse(raw);
    } catch {
      return;
    }
    try {
      const result = await this.dispatch(req.method, req.params ?? {});
      this.send(socket, { id: req.id, result });
    } catch (err) {
      this.send(socket, {
        id: req.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private async dispatch(method: string, params: Record<string, unknown>): Promise<unknown> {
    switch (method) {
      case 'listConnections':
        return this.connectionManager.getConnectionInfo().map(info => ({
          id: info.config.id,
          name: info.config.name,
          driverType: info.config.driverType,
          host: info.config.host,
          port: info.config.port,
          database: info.config.database,
          state: info.state,
        }));

      case 'connect': {
        const id = params.connectionId as string;
        await this.connectionManager.connect(id);
        return { success: true };
      }

      case 'disconnect': {
        const id = params.connectionId as string;
        await this.connectionManager.disconnect(id);
        return { success: true };
      }

      case 'read':
      case 'execute': {
        const id = params.connectionId as string;
        const query = params.query as string;
        const database = params.database as string | undefined;
        const config = this.connectionManager.getConnections().find(c => c.id === id);
        if (!config) { throw new Error(`Connection not found: ${id}`); }
        const driverType = config.driverType;

        switch (driverType) {
          case 'mysql':
          case 'postgresql': {
            const driver = this.connectionManager.getDriver(id);
            if (database) {
              const { promise } = driver.executeCancellable(query, undefined, database);
              return await promise;
            }
            return await driver.execute(query);
          }
          case 'redis': {
            const { parseRedisCommand } = await import('../mcp/parsers/redis-parser.js');
            const args = parseRedisCommand(query);
            const driver = this.connectionManager.getRedisDriver(id);
            if (database !== undefined) {
              const dbIndex = parseInt(database, 10);
              if (!isNaN(dbIndex) && dbIndex >= 0 && dbIndex <= 15) {
                await driver.selectDatabase(dbIndex);
              }
            }
            return await driver.executeCommand(args);
          }
          case 'mongodb': {
            const { parseMongoQuery } = await import('../mcp/parsers/mongo-parser.js');
            const parsed = parseMongoQuery(query);
            const mArgs: unknown[] = [];
            switch (parsed.method) {
              case 'find': mArgs.push(parsed.filter ?? {}, { projection: parsed.projection }); break;
              case 'aggregate': mArgs.push(parsed.pipeline ?? []); break;
              case 'countDocuments': mArgs.push(parsed.filter ?? {}); break;
              case 'insertOne': mArgs.push(parsed.document ?? {}); break;
              case 'insertMany': mArgs.push(parsed.documents ?? []); break;
              case 'updateOne': case 'updateMany': mArgs.push(parsed.filter ?? {}, parsed.update ?? {}); break;
              case 'deleteOne': case 'deleteMany': mArgs.push(parsed.filter ?? {}); break;
              case 'createIndex': mArgs.push(parsed.keys ?? {}, parsed.options ?? {}); break;
              case 'dropIndex': mArgs.push(parsed.indexName ?? ''); break;
            }
            const driver = this.connectionManager.getDriver(id);
            // MongoDriver has dispatchToCollection as public method
            const mongoDriver = driver as unknown as { dispatchToCollection: (db: string, coll: string, method: string, args: readonly unknown[], options?: { limit?: number }) => Promise<unknown> };
            return await mongoDriver.dispatchToCollection(database ?? 'test', parsed.collection, parsed.method, mArgs, parsed.limit ? { limit: parsed.limit } : undefined);
          }
          case 'kafka': {
            const { parseKafkaQuery } = await import('../mcp/parsers/kafka-parser.js');
            const kParams = parseKafkaQuery(query);
            const driver = this.connectionManager.getKafkaDriver(id);
            switch (kParams.action) {
              case 'listTopics': return await driver.listTopics();
              case 'describeTopic': return await driver.getTopicPartitions(kParams.topic!);
              case 'fetch': return await driver.fetchMessages(kParams.topic!, kParams.partition ?? 0, kParams.offset ?? '0', kParams.limit ?? 500);
              case 'produce': return await driver.produceMessage(kParams.topic!, kParams.key ?? null, kParams.value ?? '', kParams.headers ?? {}, kParams.partition);
              default: throw new Error(`Unknown Kafka action: ${kParams.action}`);
            }
          }
          case 'rabbitmq': {
            if (method === 'execute') { throw new Error('RabbitMQ does not support write operations yet.'); }
            const { parseRabbitMQQuery } = await import('../mcp/parsers/rabbitmq-parser.js');
            const rParams = parseRabbitMQQuery(query);
            const driver = this.connectionManager.getRabbitMQDriver(id);
            switch (rParams.action) {
              case 'listQueues': return await driver.listQueues();
              case 'peek': return await driver.peekMessages(rParams.queue!, rParams.count ?? 10);
              default: throw new Error(`Unknown RabbitMQ action: ${rParams.action}`);
            }
          }
          default:
            throw new Error(`Unsupported driver type: ${driverType}`);
        }
      }

      case 'listDatabases': {
        const id = params.connectionId as string;
        const config = this.connectionManager.getConnections().find(c => c.id === id);
        if (!config) { throw new Error(`Connection not found: ${id}`); }
        if (config.driverType === 'redis') {
          return Array.from({ length: 16 }, (_, i) => ({ name: String(i) }));
        }
        if (config.driverType === 'kafka' || config.driverType === 'rabbitmq') {
          return { error: 'N/A for this database type' };
        }
        const driver = this.connectionManager.getDriver(id);
        return await driver.listDatabases();
      }

      case 'listTables': {
        const id = params.connectionId as string;
        const database = params.database as string;
        const config = this.connectionManager.getConnections().find(c => c.id === id);
        if (!config) { throw new Error(`Connection not found: ${id}`); }
        if (config.driverType === 'kafka') {
          return await this.connectionManager.getKafkaDriver(id).listTopics();
        }
        if (config.driverType === 'rabbitmq') {
          return await this.connectionManager.getRabbitMQDriver(id).listQueues();
        }
        if (config.driverType === 'redis') {
          return { error: 'N/A for Redis' };
        }
        const driver = this.connectionManager.getDriver(id);
        return await driver.listTables(database);
      }

      case 'listColumns': {
        const id = params.connectionId as string;
        const database = params.database as string;
        const table = params.table as string;
        const driver = this.connectionManager.getDriver(id);
        return await driver.listColumns(database, table);
      }

      case 'getTableDDL': {
        const id = params.connectionId as string;
        const database = params.database as string;
        const table = params.table as string;
        const driver = this.connectionManager.getDriver(id);
        return await driver.getTableDDL(database, table);
      }

      case 'saveConnection': {
        const config = params.config as Record<string, unknown>;
        const password = (params.password as string) ?? '';
        const sshPassword = params.sshPassword as string | undefined;
        const id = config.id as string || `conn_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        const connConfig = {
          id,
          name: (config.name as string) || id,
          driverType: config.driverType as string,
          host: config.host as string,
          port: config.port as number,
          username: (config.username as string) ?? '',
          database: (config.database as string) ?? '',
          ssh: config.ssh as Record<string, unknown> | undefined,
        };
        await this.connectionManager.addConnection(
          connConfig as unknown as import('../types/connection.js').ConnectionConfig,
          password,
          sshPassword,
        );
        return { success: true, connectionId: id };
      }

      default:
        throw new Error(`Unknown IPC method: ${method}`);
    }
  }

  private send(socket: net.Socket, response: IpcResponse): void {
    try {
      socket.write(JSON.stringify(response) + '\n');
    } catch {}
  }

  dispose(): void {
    this.server?.close();
    this.server = null;
    try { fs.unlinkSync(SOCKET_PATH); } catch {}
  }
}
