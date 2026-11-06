// 构建收尾：盖「构建输入指纹」的章（dist/build-source.json）。
//
// DropLeaf：自托管服务端（rust/）与 shortcuts 同步已不在交付范围，
// 上游 tools/sync-web-assets.mjs 的「同步进 static/」整段删除 ——
// Workers 部署直接用 web/dist（cloudflare/deploy.sh 拷进 workers/assets）。
// 指纹章保留原算法（源码 sha256），它是「dist 是不是这份源码构建出来的」的可核对凭据。
import { readdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const distDir = join(here, 'dist');
const BUILD_STAMP = join(distDir, 'build-source.json');

// 「前端源码」= 指纹算哪些东西。跳过 node_modules / dist / .vite（本机产物）与
// build-source.json（章本身，避免自指）。短cuts 派生目录已随上游功能一起删除。
const NEVER_HASHED = new Set(['.DS_Store', 'build-source.json']);
const SKIP = ['node_modules', 'dist', '.vite'];

function files(dir) {
  const out = [];
  const stack = ['.'];
  while (stack.length) {
    const current = stack.pop();
    for (const entry of readdirSync(join(dir, current), { withFileTypes: true })) {
      const rel = current === '.' ? entry.name : `${current}/${entry.name}`;
      if (NEVER_HASHED.has(entry.name)) continue;
      if (entry.isDirectory()) {
        if (SKIP.includes(entry.name)) continue;
        stack.push(rel);
        continue;
      }
      out.push(rel);
    }
  }
  return out.sort();
}

function sourceFingerprint() {
  const hash = createHash('sha256');
  for (const rel of files(here)) {
    hash.update(`web/${rel}\0`);
    hash.update(readFileSync(join(here, rel)));
    hash.update('\0');
  }
  return hash.digest('hex');
}

if (!existsSync(distDir)) {
  console.error('✗ dist/ 不存在 —— vite build 没跑成，不盖章');
  process.exit(1);
}

const stamp = sourceFingerprint();
writeFileSync(
  BUILD_STAMP,
  `${JSON.stringify({ source: stamp, builtAt: new Date().toISOString() }, null, 2)}\n`,
);
console.log(`  stamp  构建输入指纹 ${stamp.slice(0, 12)} → ${relative(process.cwd(), BUILD_STAMP)}`);
