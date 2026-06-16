import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { ConnectionForm } from './ConnectionForm';
import { mockPostMessage } from '../../__test__/setup';
import type { ExtensionMessage } from '../../types/messages';

describe('ConnectionForm', () => {
  beforeEach(() => {
    mockPostMessage.mockClear();
  });

  it('应该渲染所有表单字段和按钮', () => {
    render(<ConnectionForm />);

    expect(screen.getByText('New Connection')).toBeInTheDocument();
    expect(screen.getByText('Connection Name')).toBeInTheDocument();
    expect(screen.getByText('Database Type')).toBeInTheDocument();
    expect(screen.getByText('Host')).toBeInTheDocument();
    expect(screen.getByText('Port')).toBeInTheDocument();
    expect(screen.getByText('Username')).toBeInTheDocument();
    expect(screen.getByText('Password')).toBeInTheDocument();
    expect(screen.getByText('Database')).toBeInTheDocument();
    expect(screen.getByText('Test Connection')).toBeInTheDocument();
    expect(screen.getByText('Save')).toBeInTheDocument();
  });

  it('应该使用正确的默认值初始化表单', () => {
    render(<ConnectionForm />);

    expect(screen.getByPlaceholderText('My Database')).toHaveValue('');
    expect(screen.getByRole('combobox')).toHaveValue('mysql');
    expect(screen.getByPlaceholderText('localhost')).toHaveValue('localhost');
    expect(screen.getByDisplayValue('3306')).toHaveValue(3306); // type="number" 是 number 类型
    expect(screen.getByDisplayValue('root')).toHaveValue('root');
    expect(screen.getByPlaceholderText('(optional)')).toHaveValue('');
    // Password input 没有 placeholder, 用 type 查询
    const allInputs = screen.getAllByRole('textbox');
    const formElement = allInputs[0].closest('.connection-form');
    const passwordInput = formElement?.querySelector('input[type="password"]') as HTMLInputElement;
    expect(passwordInput).toHaveValue('');
  });

  it('应该在切换数据库类型时自动更新 port', () => {
    render(<ConnectionForm />);

    const dbTypeSelect = screen.getByRole('combobox');
    const portInput = screen.getByDisplayValue('3306');

    // 初始 MySQL port 3306
    expect(portInput).toHaveValue(3306);

    // 切换到 PostgreSQL
    fireEvent.change(dbTypeSelect, { target: { value: 'postgresql' } });
    expect(screen.getByDisplayValue('5432')).toHaveValue(5432);

    // 切换回 MySQL
    fireEvent.change(dbTypeSelect, { target: { value: 'mysql' } });
    expect(screen.getByDisplayValue('3306')).toHaveValue(3306);
  });

  it('应该在用户手动修改 port 后不再自动更新', () => {
    render(<ConnectionForm />);

    const dbTypeSelect = screen.getByRole('combobox');
    const portInput = screen.getByDisplayValue('3306');

    // 手动修改 port
    fireEvent.change(portInput, { target: { value: '9999' } });
    expect(screen.getByDisplayValue('9999')).toHaveValue(9999);

    // 切换数据库类型, port 不应该变化
    fireEvent.change(dbTypeSelect, { target: { value: 'postgresql' } });
    expect(screen.getByDisplayValue('9999')).toHaveValue(9999);
  });

  it('应该在 name 为空时禁用 Save 按钮', () => {
    render(<ConnectionForm />);

    const saveButton = screen.getByText('Save');
    expect(saveButton).toBeDisabled();
  });

  it('应该在填写 name 后启用 Save 按钮', () => {
    render(<ConnectionForm />);

    const nameInput = screen.getByPlaceholderText('My Database');
    const saveButton = screen.getByText('Save');

    fireEvent.change(nameInput, { target: { value: 'My Database' } });
    expect(saveButton).not.toBeDisabled();
  });

  it('应该在点击 Test Connection 按钮时发送 testConnection 消息', () => {
    render(<ConnectionForm />);

    const hostInput = screen.getByPlaceholderText('localhost');
    const usernameInput = screen.getByDisplayValue('root');
    const databaseInput = screen.getByPlaceholderText('(optional)');
    const testButton = screen.getByText('Test Connection');

    // 找到 password input (type="password")
    const allInputs = screen.getAllByRole('textbox');
    const formElement = allInputs[0].closest('.connection-form');
    const passwordInput = formElement?.querySelector('input[type="password"]') as HTMLInputElement;

    fireEvent.change(hostInput, { target: { value: '192.168.1.100' } });
    fireEvent.change(usernameInput, { target: { value: 'admin' } });
    fireEvent.change(passwordInput, { target: { value: 'secret123' } });
    fireEvent.change(databaseInput, { target: { value: 'prod_db' } });

    fireEvent.click(testButton);

    expect(mockPostMessage).toHaveBeenCalledWith({
      type: 'testConnection',
      config: {
        driverType: 'mysql',
        host: '192.168.1.100',
        port: 3306,
        username: 'admin',
        password: 'secret123',
        database: 'prod_db',
        sshEnabled: false,
        sshHost: '',
        sshPort: 22,
        sshUsername: '',
        sshAuthType: 'password',
        sshPassword: '',
        sshPrivateKeyPath: '',
      },
    });
  });

  it('应该在测试中显示 Testing... 并禁用按钮', () => {
    render(<ConnectionForm />);

    const testButton = screen.getByText('Test Connection');

    fireEvent.click(testButton);

    expect(screen.getByText('Testing...')).toBeInTheDocument();
    expect(testButton).toBeDisabled();
  });

  it('应该在收到 connectionTestResult 成功消息后显示成功提示', async () => {
    render(<ConnectionForm />);

    const testButton = screen.getByText('Test Connection');
    fireEvent.click(testButton);

    const successMessage: ExtensionMessage = {
      type: 'connectionTestResult',
      success: true,
    };

    window.dispatchEvent(new MessageEvent('message', { data: successMessage }));

    await waitFor(() => {
      expect(screen.getByText('Connection successful!')).toBeInTheDocument();
    });

    // 测试完成后恢复按钮状态
    expect(screen.getByText('Test Connection')).not.toBeDisabled();
  });

  it('应该在收到 connectionTestResult 失败消息后显示错误提示', async () => {
    render(<ConnectionForm />);

    const testButton = screen.getByText('Test Connection');
    fireEvent.click(testButton);

    const errorMessage: ExtensionMessage = {
      type: 'connectionTestResult',
      success: false,
      error: 'Connection timeout',
    };

    window.dispatchEvent(new MessageEvent('message', { data: errorMessage }));

    await waitFor(() => {
      expect(screen.getByText('Connection failed: Connection timeout')).toBeInTheDocument();
    });
  });

  it('应该在点击 Save 按钮时发送 saveConnection 消息', () => {
    render(<ConnectionForm />);

    const nameInput = screen.getByPlaceholderText('My Database');
    const dbTypeSelect = screen.getByRole('combobox');
    const hostInput = screen.getByPlaceholderText('localhost');
    const portInput = screen.getByDisplayValue('3306');
    const usernameInput = screen.getByDisplayValue('root');
    const databaseInput = screen.getByPlaceholderText('(optional)');
    const saveButton = screen.getByText('Save');

    // 找到 password input
    const allInputs = screen.getAllByRole('textbox');
    const formElement = allInputs[0].closest('.connection-form');
    const passwordInput = formElement?.querySelector('input[type="password"]') as HTMLInputElement;

    fireEvent.change(nameInput, { target: { value: '  Production DB  ' } });
    fireEvent.change(dbTypeSelect, { target: { value: 'postgresql' } });
    fireEvent.change(hostInput, { target: { value: 'db.example.com' } });
    fireEvent.change(portInput, { target: { value: '5432' } });
    fireEvent.change(usernameInput, { target: { value: 'postgres' } });
    fireEvent.change(passwordInput, { target: { value: 'pass123' } });
    fireEvent.change(databaseInput, { target: { value: 'main_db' } });

    fireEvent.click(saveButton);

    expect(mockPostMessage).toHaveBeenCalledWith({
      type: 'saveConnection',
      config: {
        name: 'Production DB', // 应该 trim 空格
        driverType: 'postgresql',
        host: 'db.example.com',
        port: 5432,
        username: 'postgres',
        password: 'pass123',
        database: 'main_db',
        sshEnabled: false,
        sshHost: '',
        sshPort: 22,
        sshUsername: '',
        sshAuthType: 'password',
        sshPassword: '',
        sshPrivateKeyPath: '',
      },
    });
  });

  it('应该在修改字段后清除测试结果', async () => {
    render(<ConnectionForm />);

    const testButton = screen.getByText('Test Connection');
    fireEvent.click(testButton);

    const successMessage: ExtensionMessage = {
      type: 'connectionTestResult',
      success: true,
    };

    window.dispatchEvent(new MessageEvent('message', { data: successMessage }));

    await waitFor(() => {
      expect(screen.getByText('Connection successful!')).toBeInTheDocument();
    });

    // 修改字段
    const hostInput = screen.getByPlaceholderText('localhost');
    fireEvent.change(hostInput, { target: { value: 'new-host' } });

    // 测试结果应该被清除
    expect(screen.queryByText('Connection successful!')).not.toBeInTheDocument();
  });

  it('应该在 name 只有空格时禁用 Save 按钮', () => {
    render(<ConnectionForm />);

    const nameInput = screen.getByPlaceholderText('My Database');
    const saveButton = screen.getByText('Save');

    fireEvent.change(nameInput, { target: { value: '   ' } });

    expect(saveButton).toBeDisabled();
  });

  describe('Redis 连接', () => {
    it('切换 Redis 时 port 变 6379', () => {
      render(<ConnectionForm />);

      const dbTypeSelect = screen.getByRole('combobox');
      fireEvent.change(dbTypeSelect, { target: { value: 'redis' } });

      expect(screen.getByDisplayValue('6379')).toHaveValue(6379);
    });

    it('Redis 显示 Username (Redis 6 ACL, 可选)', () => {
      render(<ConnectionForm />);

      const dbTypeSelect = screen.getByRole('combobox');
      fireEvent.change(dbTypeSelect, { target: { value: 'redis' } });

      expect(screen.getByText('Username')).toBeInTheDocument();
      const formGroup = screen.getByText('Username').closest('.form-group');
      const usernameInput = formGroup?.querySelector('input') as HTMLInputElement;
      expect(usernameInput.placeholder).toBe('(optional)');
    });

    it('Redis 显示 DB Index 下拉 (0-15)', () => {
      render(<ConnectionForm />);

      const dbTypeSelect = screen.getByRole('combobox');
      fireEvent.change(dbTypeSelect, { target: { value: 'redis' } });

      expect(screen.getByText('DB Index')).toBeInTheDocument();
      // 第二个 combobox 是 db index select
      const selects = screen.getAllByRole('combobox');
      const dbSelect = selects[selects.length - 1];
      expect(dbSelect).toBeInTheDocument();
      // 16 个选项 (db0-db15)
      expect(dbSelect.querySelectorAll('option')).toHaveLength(16);
    });

    it('切回 MySQL 恢复正常字段', () => {
      render(<ConnectionForm />);

      const dbTypeSelect = screen.getByRole('combobox');

      // 先切到 Redis: Database 变成 DB Index 下拉
      fireEvent.change(dbTypeSelect, { target: { value: 'redis' } });
      expect(screen.getByText('DB Index')).toBeInTheDocument();
      expect(screen.queryByText('Database')).not.toBeInTheDocument();

      // 切回 MySQL: 恢复 Database 文本字段和默认 port
      fireEvent.change(dbTypeSelect, { target: { value: 'mysql' } });
      expect(screen.getByText('Username')).toBeInTheDocument();
      expect(screen.getByText('Database')).toBeInTheDocument();
      expect(screen.getByDisplayValue('3306')).toHaveValue(3306);
    });

    it('Redis Password 有 placeholder', () => {
      render(<ConnectionForm />);

      const dbTypeSelect = screen.getByRole('combobox');
      fireEvent.change(dbTypeSelect, { target: { value: 'redis' } });

      const formElement = screen.getByText('Password').closest('.form-group');
      const pwInput = formElement?.querySelector('input[type="password"]') as HTMLInputElement;
      expect(pwInput.placeholder).toBe('Password (optional)');
    });
  });
});
