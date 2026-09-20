'use strict';

// 容器内健康探针（仅用 Node 内置模块，无第三方依赖）。
//
// 为什么不用 wget/curl 请求 localhost：容器内 localhost 可能解析到 ::1（IPv6），
// 而应用监听在 0.0.0.0（仅 IPv4），导致服务正常时健康检查仍失败、容器被误判 unhealthy。
// 本探针固定通过 127.0.0.1 请求 /api/stories，仅当请求在超时内返回 2xx
// 且响应体可解析为 JSON 数组时退出 0；连接失败、超时、非 2xx、畸形响应一律退出非 0。
//
// 可用环境变量（均有默认值，Compose 下无需配置）：
//   HEALTHCHECK_PORT       目标端口，缺省回退到 PORT，再缺省 3000
//   HEALTHCHECK_PATH       请求路径，默认 /api/stories
//   HEALTHCHECK_TIMEOUT_MS 整体请求超时（毫秒），默认 3000

const http = require('http');

const PORT = parseInt(process.env.HEALTHCHECK_PORT || process.env.PORT || '3000', 10);
const PATH = process.env.HEALTHCHECK_PATH || '/api/stories';
const TIMEOUT_MS = parseInt(process.env.HEALTHCHECK_TIMEOUT_MS || '3000', 10);

function fail(reason) {
  console.error(`[healthcheck] unhealthy: ${reason}`);
  process.exit(1);
}

const req = http.request(
  {
    host: '127.0.0.1',
    port: PORT,
    path: PATH,
    method: 'GET',
    timeout: TIMEOUT_MS,
  },
  (res) => {
    const chunks = [];
    res.on('data', (chunk) => chunks.push(chunk));
    res.on('end', () => {
      if (res.statusCode < 200 || res.statusCode >= 300) {
        return fail(`HTTP 状态码非 2xx: ${res.statusCode}`);
      }
      let body;
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch (err) {
        return fail(`响应体不是合法 JSON: ${err.message}`);
      }
      if (!Array.isArray(body)) {
        return fail('响应 JSON 不是数组（期望剧情列表）');
      }
      console.log(`[healthcheck] ok: GET ${PATH} -> ${res.statusCode}, ${body.length} 条剧情`);
      process.exit(0);
    });
    res.on('error', (err) => fail(`读取响应失败: ${err.message}`));
  }
);

req.on('timeout', () => {
  // destroy 会触发 error 事件，统一走 fail()
  req.destroy(new Error(`请求超时（>${TIMEOUT_MS}ms）`));
});
req.on('error', (err) => fail(`请求失败: ${err.message}`));
req.end();
