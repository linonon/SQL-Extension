import { useCallback, useState } from 'react';
import { useVSCodeMessage } from '../../hooks/useVSCodeMessage';
import { usePostMessage } from '../../hooks/usePostMessage';
import type { DriverType, SSHAuthType, ExtensionMessage, ConnectionFormSSH } from '../../types/messages';
import '../../styles/connection-form.css';

interface FormState {
  readonly name: string;
  readonly driverType: DriverType;
  readonly host: string;
  readonly port: string;
  readonly username: string;
  readonly password: string;
  readonly database: string;
  readonly separator: string;
  readonly sshEnabled: boolean;
  readonly sshHost: string;
  readonly sshPort: string;
  readonly sshUsername: string;
  readonly sshAuthType: SSHAuthType;
  readonly sshPassword: string;
  readonly sshPrivateKeyPath: string;
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
  separator: ':',
  sshEnabled: false,
  sshHost: '',
  sshPort: '22',
  sshUsername: '',
  sshAuthType: 'password',
  sshPassword: '',
  sshPrivateKeyPath: '',
};

interface EditConnection {
  readonly id: string;
  readonly name: string;
  readonly driverType: DriverType;
  readonly host: string;
  readonly port: number;
  readonly username: string;
  readonly password: string;
  readonly database: string;
  readonly separator?: string;
  readonly sshEnabled: boolean;
  readonly sshHost: string;
  readonly sshPort: number;
  readonly sshUsername: string;
  readonly sshAuthType: SSHAuthType;
  readonly sshPassword: string;
  readonly sshPrivateKeyPath: string;
}

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
      password: editConnection.password,
      database: editConnection.database,
      separator: editConnection.separator ?? ':',
      sshEnabled: editConnection.sshEnabled,
      sshHost: editConnection.sshHost,
      sshPort: String(editConnection.sshPort),
      sshUsername: editConnection.sshUsername,
      sshAuthType: editConnection.sshAuthType,
      sshPassword: editConnection.sshPassword,
      sshPrivateKeyPath: editConnection.sshPrivateKeyPath,
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
        ...sshFields(form),
      },
    });
  }, [form, postMessage]);

  const handleSave = useCallback(() => {
    if (!form.name.trim()) { return; }
    const separatorField = form.driverType === 'redis' ? { separator: form.separator || ':' } : {};
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
          ...sshFields(form),
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
          ...sshFields(form),
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
            placeholder={form.driverType === 'redis' || form.driverType === 'mongodb' || form.driverType === 'kafka' ? 'Password (optional)' : undefined}
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
                  <option value="privateKey">Private Key</option>
                </select>
              </div>

              {form.sshAuthType === 'password' ? (
                <div className="form-group">
                  <label>SSH Password</label>
                  <input
                    type="password"
                    value={form.sshPassword}
                    onChange={(e) => updateField('sshPassword', e.target.value)}
                  />
                </div>
              ) : (
                <div className="form-group">
                  <label>Private Key Path</label>
                  <input
                    value={form.sshPrivateKeyPath}
                    onChange={(e) => updateField('sshPrivateKeyPath', e.target.value)}
                    placeholder="~/.ssh/id_rsa"
                  />
                </div>
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
