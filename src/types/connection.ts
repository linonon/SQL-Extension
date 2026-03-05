export type DriverType = 'mysql' | 'postgresql' | 'redis' | 'mongodb' | 'kafka' | 'rabbitmq';

export type SSHAuthType = 'password' | 'privateKey';

export interface SSHTunnelConfig {
  readonly enabled: boolean;
  readonly host: string;
  readonly port: number;
  readonly username: string;
  readonly authType: SSHAuthType;
  readonly privateKeyPath?: string;
}

export interface ConnectionConfig {
  readonly id: string;
  readonly name: string;
  readonly driverType: DriverType;
  readonly host: string;
  readonly port: number;
  readonly username: string;
  readonly database: string;
  readonly separator?: string;
  readonly ssh?: SSHTunnelConfig;
}

export type ConnectionState = 'connected' | 'disconnected' | 'connecting';

export interface ConnectionInfo {
  readonly config: ConnectionConfig;
  readonly state: ConnectionState;
}
