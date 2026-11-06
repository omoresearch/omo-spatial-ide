const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const net = require('node:net');

const security = require('../src/node/standalone-security.ts');
const hostSource = fs.readFileSync(path.resolve(__dirname, '../../runtime/omo_spatial_host.py'), 'utf8');
const protocol = fs.readFileSync(path.resolve(__dirname, '../src/common/runtime-protocol.ts'), 'utf8');

test('standalone HTTP and WS guards fail closed on non-loopback authority', () => {
  const cases = [
    [{ host: '127.0.0.1:8780', origin: 'http://127.0.0.1:8780' }, true],
    [{ host: '[::1]:8780', origin: 'http://[::1]:8780' }, true],
    [{ host: 'localhost:8780', origin: 'http://localhost:8780' }, true],
    [{ host: 'evil.example:8780', origin: 'http://evil.example:8780' }, false],
    [{ host: '127.0.0.1:8780', origin: 'http://evil.example:8780' }, false],
    [{ host: '127.0.0.1:8780', origin: 'null' }, false],
    [{ host: '127.0.0.1:8780', origin: 'http://127.0.0.1:8780, http://evil.example' }, false],
    [{ origin: 'http://127.0.0.1:8780' }, false],
    [{ host: ['127.0.0.1:8780', 'evil.example'], origin: 'http://127.0.0.1:8780' }, false],
    [{ host: '127.0.0.1:8780', origin: ['http://127.0.0.1:8780', 'http://evil.example'] }, false],
    [{ host: '127.0.0.1:8780', origin: [] }, false],
    [{ host: '127.0.0.1:8780', origin: 'http://user@127.0.0.1:8780/path' }, false],
    [{ host: '127.0.0.1:8780', origin: 'http://127.0.0.1:8780/' }, false],
    [{ host: '127.0.0.1:8780', origin: 'http://127.0.0.1:8780?query' }, false],
    [{ host: '127.0.0.1:8780', origin: 'http://127.0.0.1:8780#fragment' }, false],
  ];
  for (const [headers, expected] of cases) {
    assert.equal(security.allowStandaloneHttp(headers), expected, JSON.stringify(headers));
    assert.equal(security.allowStandaloneWebSocket(headers), expected, JSON.stringify(headers));
  }
  assert.equal(security.allowStandaloneHttp({ host: 'evil.example' }, true), true, 'team mode delegates');
});

test('the guard is exercised on real HTTP requests and WebSocket upgrades', async () => {
  const server = http.createServer((req, res) => {
    const result = security.checkStandaloneLoopback(req.headers);
    res.writeHead(result.allowed ? 200 : 403, { 'content-type': 'text/plain' });
    res.end(result.detail);
  });
  server.on('upgrade', (req, socket) => {
    if (!security.allowStandaloneWebSocket(req.headers)) {
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      return;
    }
    socket.end('HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const get = headers => new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port, path: '/', headers }, res => {
      res.resume(); res.once('end', () => resolve(res.statusCode));
    });
    req.once('error', reject); req.end();
  });
  try {
    assert.equal(await get({ Host: `127.0.0.1:${port}`, Origin: `http://127.0.0.1:${port}` }), 200);
    assert.equal(await get({ Host: `evil.example:${port}`, Origin: `http://evil.example:${port}` }), 403);
    const wsResult = await new Promise((resolve, reject) => {
      const socket = net.connect(port, '127.0.0.1', () => socket.write(
        `GET /services/omo-runtime HTTP/1.1\r\nHost: evil.example:${port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nOrigin: http://evil.example:${port}\r\n\r\n`));
      let data = '';
      socket.on('data', chunk => { data += chunk; });
      socket.once('close', () => resolve(data.split('\r\n', 1)[0]));
      socket.once('error', reject);
    });
    assert.equal(wsResult, 'HTTP/1.1 403 Forbidden');
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});


test('R2 protocol is additive and host contains the safety boundaries', () => {
  assert.match(protocol, /stationId\?: string/);
  assert.match(protocol, /takeClipboardNotification/);
  assert.match(protocol, /truecolor\?: RuntimeColorMetadata/);
  assert.match(protocol, /setIdleSleep/);
  assert.match(hostSource, /VIEW_RESERVATIONS/);
  assert.match(hostSource, /userGestureRequired/);
  assert.match(hostSource, /writeOnly/);
  assert.match(hostSource, /assert_hermes_turn_lease_free\(profile\)/);
  assert.doesNotMatch(hostSource, /clipboard_paste\(|clipboard_copy\(/);
  assert.doesNotMatch(hostSource, /send-keys.*Enter.*clipboard/);
});

test('vendored bridge remains outside the R2 source edit set', () => {
  const bridge = path.resolve(__dirname, '../../runtime/bridge');
  assert.ok(fs.existsSync(bridge));
  assert.equal(require('node:child_process').execFileSync('git', ['diff', '--name-only', '--', 'runtime/bridge'], { encoding: 'utf8' }), '');
});
