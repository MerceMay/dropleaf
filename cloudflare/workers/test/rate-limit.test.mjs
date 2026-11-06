// 登录限流：**先占名额，再验密码**（V2 复审 P2）。
//
// 背景：旧实现是「SELECT COUNT 判额度 → 验密码 → 失败再 INSERT」。两次独立操作，
// 并发提交 12 个错误密码时 12 个请求全都在计数时看到「还没满」，于是 12 次全部
// 进入密码校验并返回 401；下一次才 429。
//
// 修法：先 INSERT 占位，再数（计数含自己这一条）→ 第 6 个及以后的请求在占位时
// 就超额，直接 429，密码校验一次都不跑。并发下可能偏严（多个请求同时占位都被拒），
// 那是安全的方向。
import worker from './.build/index.mjs';
import { makeEnv, makeChecker } from './harness.mjs';

const { check, summary } = makeChecker();

function attempt(env, password, ip = '127.0.0.1') {
  return worker.fetch(
    new Request('http://worker.local/auth/token?room=default', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': ip },
      body: JSON.stringify({ password }),
    }),
    env,
    {},
  );
}

console.log('\n-- A. 顺序尝试：5 次错误放行，第 6 次 429 --');
{
  const { env } = makeEnv();
  env.AUTH_PASSWORD = 'pw123';
  const statuses = [];
  for (let i = 1; i <= 6; i += 1) {
    statuses.push((await attempt(env, `wrong-${i}`)).status);
  }
  check('前 5 次进入密码校验（401）', statuses.slice(0, 5), [401, 401, 401, 401, 401]);
  check('第 6 次被限流（429）', statuses[5], 429);
}

console.log('\n-- B. 并发 12 次错误密码：进入密码校验的绝不超过 5 次 --');
{
  const { env } = makeEnv();
  env.AUTH_PASSWORD = 'pw123';
  const responses = await Promise.all(
    Array.from({ length: 12 }, (_, i) => attempt(env, `concurrent-${i}`)),
  );
  const statuses = responses.map((r) => r.status);
  const checks = statuses.filter((s) => s === 401).length;
  const limited = statuses.filter((s) => s === 429).length;
  check('12 个请求都有结论（401 或 429）', checks + limited, 12);
  check('密码校验次数 ≤ 5（复审时是 12）', checks <= 5, true);
  check('其余全部 429', limited, 12 - checks);
  check('至少有一个 429', limited >= 1, true);
}

console.log('\n-- C. 成功登录清空名额 --');
{
  const { env } = makeEnv();
  env.AUTH_PASSWORD = 'pw123';

  check('先失败 3 次', [
    (await attempt(env, 'bad-1')).status,
    (await attempt(env, 'bad-2')).status,
    (await attempt(env, 'bad-3')).status,
  ], [401, 401, 401]);

  check('正确密码 → 200', (await attempt(env, 'pw123')).status, 200);
  check('名额已清空，可再次失败', (await attempt(env, 'bad-4')).status, 401);
}

console.log('\n-- D. 已限流时正确密码也先被挡（窗口内 429） --');
{
  const { env } = makeEnv();
  env.AUTH_PASSWORD = 'pw123';
  for (let i = 0; i < 5; i += 1) await attempt(env, `bad-${i}`);
  const res = await attempt(env, 'pw123');
  check('满额后正确密码 → 429（等窗口过去）', res.status, 429);
}

console.log('\n-- E. 限流按 IP 隔离 --');
{
  const { env } = makeEnv();
  env.AUTH_PASSWORD = 'pw123';
  for (let i = 0; i < 5; i += 1) await attempt(env, `bad-${i}`, '10.0.0.1');
  check('同一 IP 第 6 次 429', (await attempt(env, 'bad', '10.0.0.1')).status, 429);
  check('另一个 IP 不受影响', (await attempt(env, 'pw123', '10.0.0.2')).status, 200);
}

summary('登录限流（原子占位）');
