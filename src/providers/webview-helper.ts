import * as vscode from 'vscode';
import * as crypto from 'crypto';

export function getWebviewContent(
  webview: vscode.Webview,
  extensionUri: vscode.Uri
): string {
  const distUri = vscode.Uri.joinPath(extensionUri, 'webview-ui', 'dist');
  const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(distUri, 'assets', 'index.js'));
  const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(distUri, 'assets', 'index.css'));
  const nonce = crypto.randomBytes(16).toString('hex');

  return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <meta http-equiv="Content-Security-Policy"
      content="default-src 'none';
               style-src ${webview.cspSource} 'unsafe-inline';
               script-src 'nonce-${nonce}' ${webview.cspSource};
               font-src ${webview.cspSource};
               img-src 'none';
               connect-src 'none';
               frame-src 'none';
               object-src 'none';" />
    <link rel="stylesheet" href="${styleUri}" />
    <title>Database Explorer</title>
  </head>
  <body>
    <div id="root"></div>
    <script nonce="${nonce}" src="${scriptUri}"></script>
  </body>
</html>`;
}

export function getWebviewOptions(extensionUri: vscode.Uri): vscode.WebviewOptions & vscode.WebviewPanelOptions {
  return {
    enableScripts: true,
    retainContextWhenHidden: true,
    localResourceRoots: [
      vscode.Uri.joinPath(extensionUri, 'webview-ui', 'dist'),
    ],
  };
}
