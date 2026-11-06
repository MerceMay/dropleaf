import { cpSync, readdirSync, rmSync } from 'node:fs';
import { execSync } from 'node:child_process';

execSync('npm --prefix web run build', { stdio: 'inherit' });
const assets = new URL('../cloudflare/workers/assets/', import.meta.url);
try {
    for (const entry of readdirSync(assets)) rmSync(new URL(encodeURIComponent(entry), assets), { recursive: true, force: true });
} catch (error) {
    if (error.code !== 'ENOENT') throw error;
}
cpSync(new URL('../web/dist/', import.meta.url), assets, { recursive: true });
