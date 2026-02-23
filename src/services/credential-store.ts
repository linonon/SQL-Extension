import * as vscode from 'vscode';

const KEY_PREFIX = 'sqlext.password.';
const SSH_KEY_PREFIX = 'sqlext.sshPassword.';

export class CredentialStore {
  constructor(private readonly secrets: vscode.SecretStorage) {}

  async getPassword(connectionId: string): Promise<string | undefined> {
    return this.secrets.get(`${KEY_PREFIX}${connectionId}`);
  }

  async setPassword(connectionId: string, password: string): Promise<void> {
    await this.secrets.store(`${KEY_PREFIX}${connectionId}`, password);
  }

  async deletePassword(connectionId: string): Promise<void> {
    await this.secrets.delete(`${KEY_PREFIX}${connectionId}`);
  }

  async getSSHPassword(connectionId: string): Promise<string | undefined> {
    return this.secrets.get(`${SSH_KEY_PREFIX}${connectionId}`);
  }

  async setSSHPassword(connectionId: string, password: string): Promise<void> {
    await this.secrets.store(`${SSH_KEY_PREFIX}${connectionId}`, password);
  }

  async deleteSSHPassword(connectionId: string): Promise<void> {
    await this.secrets.delete(`${SSH_KEY_PREFIX}${connectionId}`);
  }
}
