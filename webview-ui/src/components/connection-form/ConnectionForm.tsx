import { useCallback, useState } from 'react';
import { useVSCodeMessage } from '../../hooks/useVSCodeMessage';
import { usePostMessage } from '../../hooks/usePostMessage';
import type { ExtensionMessage, ConnectionFormSSH } from '../../../../src/types/messages';
import type { DriverType, SSHAuthType } from '../../../../src/types/connection';
import '../../styles/connection-form.css';

interface FormState {
  readonly name: string;
  readonly driverType: DriverType;
  readonly host: string;
  readonly port: string;
  readonly username: string;
  readonly password: string;
  readonly database: string;
  readonly authSource: string;
  readonly separator: string;
  readonly sshEnabled: boolean;
  readonly sshHost: string;
  readonly sshPort: string;
  readonly sshUsername: string;
  readonly sshAuthType: SSHAuthType;
  readonly sshPassword: string;
  readonly sshPrivateKeyPath: string;
  readonly readOnly: boolean;
}

const DEFAULT_PORTS: Record<DriverType, string> = {
  mysql: '3306',
  postgresql: '5432',
  redis: '6379',
  mongodb: '27017',
  kafka: '9092',
  rabbitmq: '15672',
};

const initialState: FormState = {
  name: '',
  driverType: 'mysql',
  host: 'localhost',
  port: '3306',
  username: 'root',
  password: '',
  database: '',
  authSource: '',
  separator: ':',
  sshEnabled: false,
  sshHost: '',
  sshPort: '22',
  sshUsername: '',
  sshAuthType: 'password',
  sshPassword: '',
  sshPrivateKeyPath: '',
  readOnly: false,
};

// 已存的密码不发到 webview, 只给有没有: 编辑时密码框留空表示沿用已存的值
interface EditConnection {
  readonly id: string;
  readonly name: string;
  readonly driverType: DriverType;
  readonly host: string;
  readonly port: number;
  readonly username: string;
  readonly hasPassword: boolean;
  readonly database: string;
  readonly authSource?: string;
  readonly separator?: string;
  readonly sshEnabled: boolean;
  readonly sshHost: string;
  readonly sshPort: number;
  readonly sshUsername: string;
  readonly sshAuthType: SSHAuthType;
  readonly hasSshPassword: boolean;
  readonly sshPrivateKeyPath: string;
  readonly readOnly: boolean;
}

const UNCHANGED_PLACEHOLDER = '(unchanged)';

function sshFields(form: FormState): ConnectionFormSSH {
  return {
    sshEnabled: form.sshEnabled,
    sshHost: form.sshHost,
    sshPort: Number(form.sshPort),
    sshUsername: form.sshUsername,
    sshAuthType: form.sshAuthType,
    sshPassword: form.sshPassword,
    sshPrivateKeyPath: form.sshPrivateKeyPath,
  };
}

export interface ConnectionFormProps {
  readonly editConnection?: EditConnection;
}

export function ConnectionForm({ editConnection }: ConnectionFormProps) {
  const isEdit = !!editConnection;

  const [form, setForm] = useState<FormState>(() => {
    if (!editConnection) { return initialState; }
    return {
      name: editConnection.name,
      driverType: editConnection.driverType,
      host: editConnection.host,
      port: String(editConnection.port),
      username: editConnection.username,
      password: '',
      database: editConnection.database,
      authSource: editConnection.authSource ?? '',
      separator: editConnection.separator ?? ':',
      sshEnabled: editConnection.sshEnabled,
      sshHost: editConnection.sshHost,
      sshPort: String(editConnection.sshPort),
      sshUsername: editConnection.sshUsername,
      sshAuthType: editConnection.sshAuthType,
      sshPassword: '',
      sshPrivateKeyPath: editConnection.sshPrivateKeyPath,
      readOnly: editConnection.readOnly,
    };
  });
  const [testResult, setTestResult] = useState<{ success: boolean; error?: string } | null>(null);
  const [testing, setTesting] = useState(false);
  const postMessage = usePostMessage();

  const updateField = useCallback(
    <K extends keyof FormState>(key: K, value: FormState[K]) => {
      setForm((prev) => {
        const next = { ...prev, [key]: value };
        if (key === 'driverType') {
          const dt = value as DriverType;
          const portUpdate = prev.port === DEFAULT_PORTS[prev.driverType] ? DEFAULT_PORTS[dt] : prev.port;
          if (dt === 'redis') {
            return { ...next, port: portUpdate, username: '', database: '0', separator: ':' };
          }
          if (dt === 'mongodb') {
            return { ...next, port: portUpdate, username: '', database: '' };
          }
          if (dt === 'kafka') {
            return { ...next, port: portUpdate, username: '', database: '' };
          }
          if (dt === 'rabbitmq') {
            return { ...next, port: portUpdate, username: 'guest', database: '/' };
          }
          if (prev.driverType === 'redis' || prev.driverType === 'mongodb' || prev.driverType === 'kafka' || prev.driverType === 'rabbitmq') {
            return { ...next, port: portUpdate, username: 'root', database: '' };
          }
          return { ...next, port: portUpdate };
        }
        return next;
      });
      setTestResult(null);
    },
    []
  );

  const handleMessage = useCallback((message: ExtensionMessage) => {
    if (message.type === 'connectionTestResult') {
      setTesting(false);
      setTestResult({ success: message.success, error: message.error });
    }
    // 笼统失败 (如保存出错) 由 App 显示, 这里只结束 Testing
    if (message.type === 'error') {
      setTesting(false);
    }
  }, []);

  useVSCodeMessage(handleMessage);

  const handleTest = useCallback(() => {
    setTesting(true);
    setTestResult(null);
    postMessage({
      type: 'testConnection',
      config: {
        driverType: form.driverType,
        host: form.host,
        port: Number(form.port),
        username: form.username,
        password: form.password,
        database: form.database,
        ...(form.driverType === 'mongodb' && form.authSource ? { authSource: form.authSource } : {}),
        ...sshFields(form),
      },
    });
  }, [form, postMessage]);

  const handleSave = useCallback(() => {
    if (!form.name.trim()) { return; }
    const separatorField = form.driverType === 'redis' ? { separator: form.separator || ':' } : {};
    const authSourceField = form.driverType === 'mongodb' && form.authSource ? { authSource: form.authSource } : {};
    if (isEdit) {
      postMessage({
        type: 'updateConnection',
        config: {
          id: editConnection.id,
          name: form.name.trim(),
          driverType: form.driverType,
          host: form.host,
          port: Number(form.port),
          username: form.username,
          password: form.password,
          database: form.database,
          ...separatorField,
          ...authSourceField,
          ...sshFields(form),
          readOnly: form.readOnly,
        },
      });
    } else {
      postMessage({
        type: 'saveConnection',
        config: {
          name: form.name.trim(),
          driverType: form.driverType,
          host: form.host,
          port: Number(form.port),
          username: form.username,
          password: form.password,
          database: form.database,
          ...separatorField,
          ...authSourceField,
          ...sshFields(form),
          readOnly: form.readOnly,
        },
      });
    }
  }, [form, isEdit, editConnection, postMessage]);

  return (
    <div className="connection-form">
      <h2>{isEdit ? 'Edit Connection' : 'New Connection'}</h2>

      <div className="form-group">
        <label>Connection Name</label>
        <input
          value={form.name}
          onChange={(e) => updateField('name', e.target.value)}
          placeholder="My Database"
        />
      </div>

      <div className="form-group">
        <label>Database Type</label>
        <select
          value={form.driverType}
          onChange={(e) => updateField('driverType', e.target.value as DriverType)}
        >
          <option value="mysql">MySQL</option>
          <option value="postgresql">PostgreSQL</option>
          <option value="redis">Redis</option>
          <option value="mongodb">MongoDB</option>
          <option value="kafka">Kafka</option>
          <option value="rabbitmq">RabbitMQ</option>
        </select>
      </div>

      <div className="form-row">
        <div className="form-group">
          <label>Host</label>
          <input
            value={form.host}
            onChange={(e) => updateField('host', e.target.value)}
            placeholder="localhost"
          />
        </div>
        <div className="form-group">
          <label>Port</label>
          <input
            type="number"
            value={form.port}
            onChange={(e) => updateField('port', e.target.value)}
          />
        </div>
      </div>

      <div className="form-row">
        {form.driverType !== 'kafka' && (
          <div className="form-group">
            <label>Username</label>
            <input
              value={form.username}
              onChange={(e) => updateField('username', e.target.value)}
              placeholder={form.driverType === 'mongodb' || form.driverType === 'redis' ? '(optional)' : undefined}
            />
          </div>
        )}
        {form.driverType === 'kafka' && (
          <div className="form-group">
            <label>SASL Username</label>
            <input
              value={form.username}
              onChange={(e) => updateField('username', e.target.value)}
              placeholder="(optional, for SASL)"
            />
          </div>
        )}
        <div className="form-group">
          <label>Password</label>
          <input
            type="password"
            value={form.password}
            onChange={(e) => updateField('password', e.target.value)}
            placeholder={editConnection?.hasPassword
              ? UNCHANGED_PLACEHOLDER
              : form.driverType === 'redis' || form.driverType === 'mongodb' || form.driverType === 'kafka' ? 'Password (optional)' : undefined}
          />
        </div>
      </div>

      {form.driverType === 'rabbitmq' ? (
        <div className="form-group">
          <label>Virtual Host</label>
          <input
            value={form.database}
            onChange={(e) => updateField('database', e.target.value)}
            placeholder="/"
          />
        </div>
      ) : form.driverType === 'kafka' ? null : form.driverType === 'redis' ? (
        <div className="form-row">
          <div className="form-group">
            <label>DB Index</label>
            <select
              value={form.database}
              onChange={(e) => updateField('database', e.target.value)}
            >
              {Array.from({ length: 16 }, (_, i) => (
                <option key={i} value={String(i)}>{`db${i}`}</option>
              ))}
            </select>
          </div>
          <div className="form-group">
            <label>Key Separator</label>
            <input
              value={form.separator}
              onChange={(e) => updateField('separator', e.target.value)}
              placeholder=":"
              style={{ width: '60px' }}
            />
          </div>
        </div>
      ) : (
        <div className="form-group">
          <label>Database</label>
          <input
            value={form.database}
            onChange={(e) => updateField('database', e.target.value)}
            placeholder="(optional)"
          />
        </div>
      )}

      {form.driverType === 'mongodb' && (
        <div className="form-group">
          <label>Auth Database</label>
          <input
            value={form.authSource}
            onChange={(e) => updateField('authSource', e.target.value)}
            placeholder="admin"
          />
        </div>
      )}

      <div className="form-group">
        <label className="read-only-toggle">
          <input
            type="checkbox"
            checked={form.readOnly}
            onChange={(e) => updateField('readOnly', e.target.checked)}
          />
          Read-only (block writes from the UI and from agents)
        </label>
      </div>

      <div className="ssh-section">
          <label className="ssh-toggle">
            <input
              type="checkbox"
              checked={form.sshEnabled}
              onChange={(e) => updateField('sshEnabled', e.target.checked)}
            />
            Enable SSH Tunnel
          </label>

          {form.sshEnabled && (
            <div className="ssh-fields">
              {form.driverType === 'kafka' && (
                // tunnel 只转发一个端口, kafkajs 拿到 metadata 后直连 broker 自己 advertise 的地址
                <p className="form-hint">
                  SSH works only for a single broker whose advertised listener is reachable through the tunnel.
                </p>
              )}
              <div className="form-row">
                <div className="form-group">
                  <label>SSH Host</label>
                  <input
                    value={form.sshHost}
                    onChange={(e) => updateField('sshHost', e.target.value)}
                    placeholder="ssh.example.com"
                  />
                </div>
                <div className="form-group">
                  <label>SSH Port</label>
                  <input
                    type="number"
                    value={form.sshPort}
                    onChange={(e) => updateField('sshPort', e.target.value)}
                  />
                </div>
              </div>

              <div className="form-group">
                <label>SSH Username</label>
                <input
                  value={form.sshUsername}
                  onChange={(e) => updateField('sshUsername', e.target.value)}
                />
              </div>

              <div className="form-group">
                <label>Authentication</label>
                <select
                  value={form.sshAuthType}
                  onChange={(e) => updateField('sshAuthType', e.target.value as SSHAuthType)}
                >
                  <option value="password">Password</option>
                  <option value="privateKey">Private Key / ssh-agent</option>
                </select>
              </div>

              {form.sshAuthType === 'password' ? (
                <div className="form-group">
                  <label>SSH Password</label>
                  <input
                    type="password"
                    value={form.sshPassword}
                    onChange={(e) => updateField('sshPassword', e.target.value)}
                    placeholder={editConnection?.hasSshPassword ? UNCHANGED_PLACEHOLDER : undefined}
                  />
                </div>
              ) : (
                <>
                  <div className="form-group">
                    <label>Private Key Path</label>
                    <input
                      value={form.sshPrivateKeyPath}
                      onChange={(e) => updateField('sshPrivateKeyPath', e.target.value)}
                      placeholder="~/.ssh/id_rsa"
                    />
                    <p className="form-hint">Leave empty to use the keys in ssh-agent (SSH_AUTH_SOCK).</p>
                  </div>
                  {/* 加密私钥的 passphrase 存在 SSH 密码字段 */}
                  <div className="form-group">
                    <label>Key Passphrase</label>
                    <input
                      type="password"
                      value={form.sshPassword}
                      onChange={(e) => updateField('sshPassword', e.target.value)}
                      placeholder={editConnection?.hasSshPassword ? UNCHANGED_PLACEHOLDER : '(only for an encrypted key)'}
                    />
                  </div>
                </>
              )}
            </div>
          )}
      </div>

      <div className="form-actions">
        <button className="secondary" onClick={handleTest} disabled={testing}>
          {testing ? 'Testing...' : 'Test Connection'}
        </button>
        <button onClick={handleSave} disabled={!form.name.trim()}>
          {isEdit ? 'Update' : 'Save'}
        </button>
      </div>

      {testResult && (
        <div className={`test-result ${testResult.success ? 'success' : 'error'}`}>
          {testResult.success
            ? 'Connection successful!'
            : `Connection failed: ${testResult.error ?? 'Unknown error'}`}
        </div>
      )}
    </div>
  );
}
