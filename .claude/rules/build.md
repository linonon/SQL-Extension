# Build Rules

- **修改 webview 源码后必须重新构建**: Webview 从 `webview-ui/dist/` 加载构建产物, 不是源码. 修改 `webview-ui/src/` 下的任何文件后, 必须执行 `cd webview-ui && npm run build` 重新构建, 否则改动不会生效.
- **修改 extension host 源码后必须重新构建**: Extension host 从 `dist/extension.js` 加载, 修改 `src/` 下的文件后, 必须执行 `npm run build` (根目录 esbuild) 重新构建.
