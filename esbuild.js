const fs = require('fs');
const esbuild = require('esbuild');
const { version } = require('./package.json');

const isWatch = process.argv.includes('--watch');

/** @type {import('esbuild').BuildOptions} */
const extensionOptions = {
  entryPoints: ['./src/extension.ts'],
  bundle: true,
  outfile: './dist/extension.js',
  // ssh2 的可选原生 addon 在 try/catch 里加载, 缺失时回退纯 JS 实现; esbuild 无法打包 .node
  external: ['vscode', '*.node'],
  format: 'cjs',
  platform: 'node',
  target: 'node18',
  sourcemap: isWatch,
  minify: !isWatch
};

/** @type {import('esbuild').BuildOptions} */
const mcpServerOptions = {
  entryPoints: ['./src/mcp/server.ts'],
  bundle: true,
  outfile: './dist/mcp-server.js',
  external: ['*.node'],
  define: { __EXTENSION_VERSION__: JSON.stringify(version) },
  format: 'cjs',
  platform: 'node',
  target: 'node18',
  sourcemap: isWatch,
  minify: !isWatch
};

async function main() {
  // 先删本脚本的产物: 正式构建不出 sourcemap, watch 构建留下的旧 .map 与新产物对不上. 只删自己的文件, 不清整个 dist
  for (const { outfile } of [extensionOptions, mcpServerOptions]) {
    for (const file of [outfile, `${outfile}.map`]) { fs.rmSync(file, { force: true }); }
  }
  if (isWatch) {
    const [extCtx, mcpCtx] = await Promise.all([
      esbuild.context(extensionOptions),
      esbuild.context(mcpServerOptions),
    ]);
    await Promise.all([extCtx.watch(), mcpCtx.watch()]);
  } else {
    await Promise.all([
      esbuild.build(extensionOptions),
      esbuild.build(mcpServerOptions),
    ]);
  }
}

main().catch((err) => {
  process.stderr.write(err.message);
  process.exit(1);
});
