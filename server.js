import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store } from './src/store.js';
import { DomainError } from './src/errors.js';
import {
  captureParts,
  captureScore,
  captureSuite,
  withdraw,
} from './src/collector.js';
import {
  assemble,
  buildStatus,
  downloadPlan,
  issueVoucher,
  readVersionFile,
  resendScore,
  retryAssembly,
  revisePart,
  voucherDownload,
} from './src/service.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, 'public');
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, '.data'));
const PORT = Number.parseInt(process.env.PORT ?? '3000', 10);
const HOST = '127.0.0.1';
const MAX_BODY = 512 * 1024;

export function createApp({ dataDir = DATA_DIR } = {}) {
  const store = new Store(dataDir);

  const sendJson = (res, status, payload) => {
    const body = JSON.stringify(payload, null, 2);
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'content-length': Buffer.byteLength(body),
      'cache-control': 'no-store',
    });
    res.end(body);
  };

  const readBody = (req) =>
    new Promise((resolve, reject) => {
      const chunks = [];
      let size = 0;
      req.on('data', (chunk) => {
        size += chunk.length;
        if (size > MAX_BODY) {
          reject(new DomainError('body-too-large', '请求体过大', 413));
          req.destroy();
          return;
        }
        chunks.push(chunk);
      });
      req.on('end', () => {
        if (chunks.length === 0) return resolve({});
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
        } catch (error) {
          reject(new DomainError('bad-json', `请求体不是合法 JSON：${error.message}`, 400));
        }
      });
      req.on('error', reject);
    });

  const handleApi = async (req, res, url) => {
    const segments = url.pathname.split('/').filter(Boolean);
    const method = req.method ?? 'GET';

    if (method === 'GET' && url.pathname === '/api/status') {
      return sendJson(res, 200, { ok: true, status: buildStatus(store) });
    }

    if (method === 'GET' && url.pathname === '/api/events') {
      return sendJson(res, 200, { ok: true, events: store.events });
    }

    if (method === 'POST' && url.pathname === '/api/capture/parts') {
      const body = await readBody(req);
      return sendJson(res, 201, { ok: true, result: captureParts(store, body), status: buildStatus(store) });
    }

    if (method === 'POST' && url.pathname === '/api/capture/score') {
      const body = await readBody(req);
      return sendJson(res, 201, { ok: true, result: captureScore(store, body), status: buildStatus(store) });
    }

    if (method === 'POST' && url.pathname === '/api/capture/suite') {
      const body = await readBody(req);
      return sendJson(res, 201, { ok: true, result: captureSuite(store, body), status: buildStatus(store) });
    }

    if (method === 'POST' && url.pathname === '/api/assemble') {
      await readBody(req);
      const result = assemble(store);
      return sendJson(res, result.ok ? 200 : 422, { ...result, status: buildStatus(store) });
    }

    if (method === 'POST' && url.pathname === '/api/withdraw') {
      const body = await readBody(req);
      const result = withdraw(store, body);
      const after = assemble(store);
      // Top-level mirrors for the page; nested result is the canonical payload.
      return sendJson(res, 200, {
        ok: true,
        result,
        evidence: result.evidence,
        file: result.file,
        after,
        status: buildStatus(store),
      });
    }

    if (method === 'POST' && url.pathname === '/api/resend-score') {
      const body = await readBody(req);
      const result = resendScore(store, body);
      return sendJson(res, result.ok ? 200 : 422, { ...result, status: buildStatus(store) });
    }

    if (method === 'POST' && url.pathname === '/api/retry') {
      const body = await readBody(req);
      const result = retryAssembly(store, body);
      return sendJson(res, result.ok ? 200 : 422, { ...result, status: buildStatus(store) });
    }

    if (method === 'POST' && url.pathname === '/api/revise-part') {
      const body = await readBody(req);
      const result = revisePart(store, body);
      return sendJson(res, result.ok ? 200 : 422, { ...result, status: buildStatus(store) });
    }

    if (method === 'POST' && url.pathname === '/api/vouchers') {
      const body = await readBody(req);
      return sendJson(res, 201, { ok: true, result: issueVoucher(store, body), status: buildStatus(store) });
    }

    if (
      method === 'GET' &&
      segments[0] === 'api' &&
      segments[1] === 'versions' &&
      segments[3] === 'files' &&
      segments[4]
    ) {
      const { buffer, situation, name, sha256: digest } = readVersionFile(store, segments[2], segments[4]);
      res.writeHead(200, {
        'content-type': 'text/plain; charset=utf-8',
        'content-length': buffer.length,
        'x-content-sha256': digest,
        'x-version-situation': situation,
        'cache-control': 'no-store',
        'content-disposition': `inline; filename="${encodeURIComponent(name)}"`,
      });
      return res.end(buffer);
    }

    if (method === 'GET' && segments[0] === 'api' && segments[1] === 'vouchers' && segments[3] === 'plan') {
      const plan = downloadPlan(store, segments[2]);
      return sendJson(res, 200, { ok: true, plan });
    }

    if (method === 'GET' && segments[0] === 'api' && segments[1] === 'download') {
      const [, , voucherId, slot] = segments;
      const { buffer, file, situation } = voucherDownload(store, voucherId, slot);
      res.writeHead(200, {
        'content-type': 'text/plain; charset=utf-8',
        'content-length': buffer.length,
        'content-disposition': `attachment; filename="${encodeURIComponent(file.name)}"`,
        'x-content-sha256': file.sha256,
        'x-voucher-situation': situation,
        'cache-control': 'no-store',
      });
      return res.end(buffer);
    }

    if (method === 'POST' && url.pathname === '/api/demo/reset') {
      fs.rmSync(dataDir, { recursive: true, force: true });
      fs.mkdirSync(dataDir, { recursive: true });
      store.reset();
      return sendJson(res, 200, { ok: true, status: buildStatus(store) });
    }

    throw new DomainError('not-found', `没有这个接口：${method} ${url.pathname}`, 404);
  };

  const staticTypes = new Map([
    ['.html', 'text/html; charset=utf-8'],
    ['.js', 'text/javascript; charset=utf-8'],
    ['.css', 'text/css; charset=utf-8'],
    ['.svg', 'image/svg+xml'],
    ['.json', 'application/json; charset=utf-8'],
  ]);

  const serveStatic = (req, res, url) => {
    let pathname = decodeURIComponent(url.pathname);
    if (pathname === '/') pathname = '/index.html';
    const target = path.normalize(path.join(PUBLIC_DIR, pathname));
    if (!target.startsWith(PUBLIC_DIR + path.sep) && target !== PUBLIC_DIR) {
      sendJson(res, 403, { ok: false, error: { code: 'forbidden', message: '禁止访问该路径' } });
      return;
    }
    if (!fs.existsSync(target) || !fs.statSync(target).isFile()) {
      sendJson(res, 404, { ok: false, error: { code: 'not-found', message: '文件不存在' } });
      return;
    }
    const body = fs.readFileSync(target);
    res.writeHead(200, {
      'content-type': staticTypes.get(path.extname(target)) ?? 'application/octet-stream',
      'content-length': body.length,
      'cache-control': 'no-cache',
    });
    res.end(body);
  };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? HOST}`);
    try {
      if (url.pathname.startsWith('/api/')) {
        await handleApi(req, res, url);
      } else if (req.method === 'GET' || req.method === 'HEAD') {
        serveStatic(req, res, url);
      } else {
        throw new DomainError('method-not-allowed', `${req.method} 不被支持`, 405);
      }
    } catch (error) {
      if (error instanceof DomainError) {
        sendJson(res, error.status ?? 400, {
          ok: false,
          error: {
            code: error.code,
            message: error.message,
            details: error.details ?? null,
          },
          status: buildStatus(store),
        });
        return;
      }
      if (res.headersSent) {
        res.destroy();
        return;
      }
      console.error(error);
      sendJson(res, 500, {
        ok: false,
        error: { code: 'internal', message: '服务器内部错误' },
      });
    }
  });

  return { server, store };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { server } = createApp();
  server.listen(PORT, HOST, () => {
    console.log(`谱件发行工作台已启动：http://${HOST}:${PORT}`);
    console.log(`数据目录：${DATA_DIR}`);
  });
}
