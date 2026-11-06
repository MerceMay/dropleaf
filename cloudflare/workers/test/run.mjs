#!/usr/bin/env node
// run.sh 的等价 Node 实现：Git Bash 非交互子 shell 找不到 node（PATH 挂载怪癖），
// 用 node 自身驱动测试序列最稳。语义与 run.sh 一一对应。
import { execFileSync } from 'node:child_process';
import { rmSync, mkdirSync } from 'node:fs';
import process from 'node:process';

const entries = [
  'handlers/content', 'handlers/file', 'handlers/text', 'handlers/draft',
  'durable-objects/websocket-room', 'auth', 'utils', 'file-cleanup', 'index',
];
const tests = [
  'receive-path', 'device-name', 'asset-routing', 'history-name', 'content-list',
  'revoke-method', 'cors-origins', 'auth-room', 'board-column', 'text-body',
  'deploy-subdomain', 'file-cleanup', 'upload-quota', 'upload-multi', 'draft-save',
  'session-logout', 'attachment-headers', 'cookie-csrf', 'rate-limit', 'do-revocation', 'review-round2', 'epoch-outage',
];

rmSync('test/.build', { recursive: true, force: true });
mkdirSync('test/.build', { recursive: true });

console.log('── 打包处理器（供端到端测试导入）');
for (const entry of entries) {
  execFileSync(
    process.execPath,
    [
      'node_modules/esbuild/bin/esbuild',
      `src/${entry}.js`,
      '--bundle', '--format=esm', '--platform=neutral',
      `--outfile=test/.build/${entry.split('/').pop()}.mjs`,
      '--log-level=warning',
    ],
    { stdio: 'inherit' },
  );
}

let failed = 0;
for (const t of tests) {
  console.log(`\n── ${t}`);
  try {
    execFileSync(process.execPath, ['--no-warnings', `test/${t}.test.mjs`], { stdio: 'inherit' });
  } catch {
    failed += 1;
  }
}
if (failed > 0) {
  console.error(`\n${failed} 个测试套件失败`);
  process.exit(1);
}
console.log('\n全部测试套件 ✅');
