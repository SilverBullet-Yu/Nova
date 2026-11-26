'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const config = fs.readFileSync(require.resolve('../deploy/nginx.conf.example'), 'utf8');

test('反向代理示例限制请求体、慢连接和并发，并保留可信代理头', () => {
  assert.match(config, /client_max_body_size\s+1m;/);
  assert.match(config, /client_header_timeout\s+10s;/);
  assert.match(config, /client_body_timeout\s+30s;/);
  assert.match(config, /proxy_read_timeout\s+130s;/);
  assert.match(config, /limit_req_zone\s+\$binary_remote_addr\s+zone=nova_api_req/);
  assert.match(config, /limit_conn_zone\s+\$binary_remote_addr\s+zone=nova_api_conn/);
  assert.match(config, /proxy_set_header\s+X-Forwarded-For\s+\$proxy_add_x_forwarded_for;/);
  assert.match(config, /proxy_pass\s+http:\/\/127\.0\.0\.1:8787;/);
});

test('旧撤销位置不新增速率限制，只保留连接与超时保护', () => {
  const match = config.match(/location\s*=\s*\/api\/replan\/undo\s*\{([\s\S]*?)\n\s*\}/);
  assert.ok(match, '缺少撤销接口的独立代理位置');
  assert.doesNotMatch(match[1], /limit_req\s/);
  assert.match(match[1], /limit_conn\s+nova_api_conn\s+64;/);
  assert.match(match[1], /proxy_read_timeout\s+130s;/);
});
