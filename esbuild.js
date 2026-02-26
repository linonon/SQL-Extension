const esbuild = require('esbuild');

const isWatch = process.argv.includes('--watch');

/** @type {import('esbuild').BuildOptions} */
const extensionOptions = {
  entryPoints: ['./src/extension.ts'],
  bundle: true,
  outfile: './dist/extension.js',
  external: ['vscode'],
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
  format: 'cjs',
  platform: 'node',
  target: 'node18',
  sourcemap: isWatch,
  minify: !isWatch
};

async function main() {
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
