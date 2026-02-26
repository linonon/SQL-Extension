import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ConnectionPool } from './connection-pool.js';

function makeMockDriver(type: string) {
  return class {
    driverType = type;
    connect = vi.fn().mockResolvedValue(undefined);
    disconnect = vi.fn().mockResolvedValue(undefined);
    isConnected = vi.fn().mockReturnValue(true);
    ping = vi.fn().mockResolvedValue(undefined);
  };
}

vi.mock('../drivers/mysql-driver.js', () => ({ MySQLDriver: makeMockDriver('mysql') }));
vi.mock('../drivers/pg-driver.js', () => ({ PgDriver: makeMockDriver('postgresql') }));
vi.mock('../drivers/redis-driver.js', () => ({ RedisDriver: makeMockDriver('redis') }));
vi.mock('../drivers/mongo-driver.js', () => ({ MongoDriver: makeMockDriver('mongodb') }));
vi.mock('../drivers/kafka-driver.js', () => ({ KafkaDriver: makeMockDriver('kafka') }));
vi.mock('../drivers/rabbitmq-driver.js', () => ({ RabbitMQDriver: makeMockDriver('rabbitmq') }));

vi.mock('../services/ssh-tunnel.js', () => ({
  createTunnel: vi.fn().mockResolvedValue({
    localPort: 12345,
    close: vi.fn(),
  }),
}));

describe('ConnectionPool', () => {
  let pool: ConnectionPool;

  beforeEach(() => {
    pool = new ConnectionPool();
  });

  afterEach(() => {
    pool.dispose();
  });

  it('should connect and return connectionId', async () => {
    const id = await pool.connect({
      driverType: 'mysql',
      host: 'localhost',
      port: 3306,
    });
    expect(id).toMatch(/^conn_/);
    expect(pool.size).toBe(1);
  });

  it('should disconnect by id', async () => {
    const id = await pool.connect({
      driverType: 'mysql',
      host: 'localhost',
      port: 3306,
    });
    await pool.disconnect(id);
    expect(pool.size).toBe(0);
  });

  it('should throw on disconnect unknown id', async () => {
    await expect(pool.disconnect('nonexistent')).rejects.toThrow('Connection not found');
  });

  it('should get SQL driver', async () => {
    const id = await pool.connect({
      driverType: 'mysql',
      host: 'localhost',
      port: 3306,
    });
    const driver = pool.getDriver(id);
    expect(driver.driverType).toBe('mysql');
  });

  it('should reject getDriver for redis connection', async () => {
    const id = await pool.connect({
      driverType: 'redis',
      host: 'localhost',
      port: 6379,
    });
    expect(() => pool.getDriver(id)).toThrow('not a SQL database');
  });

  it('should get Redis driver', async () => {
    const id = await pool.connect({
      driverType: 'redis',
      host: 'localhost',
      port: 6379,
    });
    const driver = pool.getRedisDriver(id);
    expect(driver.driverType).toBe('redis');
  });

  it('should list connections without sensitive info', async () => {
    await pool.connect({ driverType: 'mysql', host: 'localhost', port: 3306, database: 'mydb' });
    await pool.connect({ driverType: 'postgresql', host: 'localhost', port: 5432, database: 'pgdb' });
    const list = pool.listConnections();
    expect(list).toHaveLength(2);
    expect(list[0]).toHaveProperty('id');
    expect(list[0]).toHaveProperty('driverType');
    expect(list[0]).toHaveProperty('database');
    // 不应有敏感信息
    expect(list[0]).not.toHaveProperty('host');
    expect(list[0]).not.toHaveProperty('password');
  });

  it('should reject new connection when max reached', async () => {
    for (let i = 0; i < 10; i++) {
      await pool.connect({ driverType: 'mysql', host: 'localhost', port: 3306 });
    }
    await expect(
      pool.connect({ driverType: 'mysql', host: 'localhost', port: 3306 })
    ).rejects.toThrow('Max connections');
  });

  it('should disconnect all', async () => {
    await pool.connect({ driverType: 'mysql', host: 'localhost', port: 3306 });
    await pool.connect({ driverType: 'postgresql', host: 'localhost', port: 5432 });
    await pool.disconnectAll();
    expect(pool.size).toBe(0);
  });

  it('should connect with SSH tunnel', async () => {
    const id = await pool.connect({
      driverType: 'mysql',
      host: 'remote-db',
      port: 3306,
      ssh: {
        enabled: true,
        host: 'bastion',
        port: 22,
        username: 'admin',
        authType: 'password',
        password: 'sshpass',
      },
    });
    expect(pool.size).toBe(1);
    const entry = pool.getEntry(id);
    expect(entry.tunnel).not.toBeNull();
  });
});
