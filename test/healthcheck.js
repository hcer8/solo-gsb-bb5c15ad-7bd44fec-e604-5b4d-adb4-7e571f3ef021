'use strict';

// 健康探针回归测试（node test/healthcheck.js）
// 以真实子进程运行 healthcheck.js，覆盖：
//   ✓ 2xx + JSON 数组        -> 退出 0
//   ✗ 连接失败（端口无人监听）-> 退出非 0
//   ✗ 请求超时（服务器挂起）  -> 退出非 0
//   ✗ 非 2xx 状态码          -> 退出非 0
//   ✗ 2xx 但响应体不是 JSON   -> 退出非 0
//   ✗ 2xx 但 JSON 不是数组    -> 退出非 0
const assert = require('assert');
const http = require('http');
const path = require('path');
const { spawn } = require('child_process');

const PROBE = path.join(__dirname, '..', 'healthcheck.js');

let passed = 0;
const ok = (name, cond) => { assert.ok(cond, name); passed++; console.log(`  ✓ ${name}`); };

// 启动一个行为可定制的临时 HTTP 服务器，返回 { server, port }
function startServer(handler) {
  return new Promise((resolve, reject) => {
    const server = http.createServer(handler);
    server.on('error', reject);
    // 只监听 IPv4 回环，与容器内 0.0.0.0（IPv4）场景一致
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

// 以子进程运行探针，返回退出码
function runProbe(env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [PROBE], {
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stderr }));
  });
}

// 找一个当前无人监听的端口（先监听再关闭）
function unusedPort() {
  return new Promise((resolve, reject) => {
    const srv = http.createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

async function main() {
  // ---------- 正常：2xx + JSON 数组 ----------
  console.log('健康探针：');
  {
    const { server, port } = await startServer((req, res) => {
      assert.strictEqual(req.url, '/api/stories', '探针应请求 /api/stories');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify([{ id: 'demo' }]));
    });
    const { code } = await runProbe({ HEALTHCHECK_PORT: String(port), HEALTHCHECK_TIMEOUT_MS: '2000' });
    server.close();
    ok('2xx + JSON 数组 -> 退出 0', code === 0);
  }

  // ---------- 失败：连接被拒绝 ----------
  {
    const port = await unusedPort();
    const { code } = await runProbe({ HEALTHCHECK_PORT: String(port), HEALTHCHECK_TIMEOUT_MS: '2000' });
    ok('连接失败（端口无人监听）-> 退出非 0', code !== 0 && code !== null);
  }

  // ---------- 失败：服务器接受连接但永不响应（超时） ----------
  {
    const { server, port } = await startServer(() => { /* 挂起，永不响应 */ });
    const { code, stderr } = await runProbe({ HEALTHCHECK_PORT: String(port), HEALTHCHECK_TIMEOUT_MS: '300' });
    server.close();
    ok('请求超时 -> 退出非 0', code !== 0 && code !== null);
    ok('超时原因写入 stderr', /超时|timeout/i.test(stderr));
  }

  // ---------- 失败：非 2xx ----------
  {
    const { server, port } = await startServer((req, res) => {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end('[]');
    });
    const { code } = await runProbe({ HEALTHCHECK_PORT: String(port), HEALTHCHECK_TIMEOUT_MS: '2000' });
    server.close();
    ok('非 2xx（500）-> 退出非 0', code !== 0 && code !== null);
  }

  // ---------- 失败：2xx 但响应体不是合法 JSON ----------
  {
    const { server, port } = await startServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('not-json{');
    });
    const { code } = await runProbe({ HEALTHCHECK_PORT: String(port), HEALTHCHECK_TIMEOUT_MS: '2000' });
    server.close();
    ok('2xx 但响应体畸形（非 JSON）-> 退出非 0', code !== 0 && code !== null);
  }

  // ---------- 失败：2xx 且合法 JSON 但不是数组 ----------
  {
    const { server, port } = await startServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'oops' }));
    });
    const { code } = await runProbe({ HEALTHCHECK_PORT: String(port), HEALTHCHECK_TIMEOUT_MS: '2000' });
    server.close();
    ok('2xx 但 JSON 不是数组 -> 退出非 0', code !== 0 && code !== null);
  }

  console.log(`\n全部 ${passed} 项断言通过 ✔`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
