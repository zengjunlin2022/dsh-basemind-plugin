import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { downloadVerified, DownloadError } from '../lib/binary/download.js';

const ASSET = Buffer.from('pretend-this-is-a-basemind-release-archive\n'.repeat(64));
const ASSET_SHA = createHash('sha256').update(ASSET).digest('hex');
const ALLOWED_HOSTS = ['127.0.0.1'];

/** A temp directory under os.tmpdir() that is removed after the test. */
async function withTempDir(t) {
  const dir = await mkdtemp(path.join(tmpdir(), 'dsh-bm-download-'));
  t.after(async () => {
    await rm(dir, { recursive: true, force: true });
  });
  return dir;
}

/** A loopback HTTP server that is closed after the test. */
async function withServer(t, handler) {
  const server = createServer(handler);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address();
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  return { port, base: 'http://127.0.0.1:' + port };
}

/** The mock release mirror: one asset plus every failure mode under test. */
function makeHandler({ externalUrl } = {}) {
  const hits = new Map();
  const count = (url) => {
    hits.set(url, (hits.get(url) ?? 0) + 1);
  };

  const handler = (req, res) => {
    count(req.url);

    if (req.url === '/asset') {
      res.writeHead(200, { 'content-length': String(ASSET.length) });
      res.end(ASSET);
      return;
    }
    if (req.url === '/forbidden') {
      res.writeHead(403);
      res.end('forbidden');
      return;
    }
    if (req.url === '/notfound') {
      res.writeHead(404);
      res.end('missing');
      return;
    }
    if (req.url === '/badrequest') {
      res.writeHead(400);
      res.end('bad request');
      return;
    }
    if (req.url === '/ratelimit') {
      res.writeHead(429);
      res.end('slow down');
      return;
    }
    if (req.url === '/error') {
      res.writeHead(500);
      res.end('boom');
      return;
    }
    if (req.url === '/redirect') {
      res.writeHead(302, { location: '/asset' });
      res.end();
      return;
    }
    if (req.url === '/redirect-external') {
      res.writeHead(302, { location: externalUrl });
      res.end();
      return;
    }
    if (req.url === '/redirect-loop') {
      res.writeHead(302, { location: '/redirect-loop' });
      res.end();
      return;
    }
    if (req.url === '/redirect-nowhere') {
      res.writeHead(302);
      res.end();
      return;
    }
    if (req.url === '/too-large') {
      res.writeHead(200, { 'content-length': String(50 * 1024) });
      res.end(ASSET);
      return;
    }
    if (req.url === '/destroy') {
      res.writeHead(200, { 'content-length': '100000' });
      res.write(ASSET.subarray(0, 16));
      setTimeout(() => req.socket.destroy(), 5);
      return;
    }
    if (req.url === '/chunked-large') {
      res.writeHead(200);
      res.write(ASSET.subarray(0, 128));
      res.end(ASSET.subarray(0, 128));
      return;
    }
    if (req.url === '/slow') {
      return; // never responds
    }
    res.writeHead(404);
    res.end('unknown route');
  };

  return { hits, handler };
}

/** Start a download with the test defaults; returns the promise and the sleeps. */
function attempt(options) {
  const sleeps = [];
  const promise = downloadVerified({
    fetchImpl: fetch,
    allowedHosts: ALLOWED_HOSTS,
    allowInsecure: true,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    ...options,
  });
  return { promise, sleeps };
}

/** Assert that a download promise rejects with a specific DownloadError code. */
async function expectFailure(promise, code, expected = {}) {
  await assert.rejects(promise, (error) => {
    assert.ok(error instanceof DownloadError, 'expected a DownloadError, got ' + String(error));
    assert.equal(error.code, code, 'error.message');
    if (expected.status !== undefined) assert.equal(error.status, expected.status, 'error.status');
    if (expected.message !== undefined) assert.match(error.message, expected.message);
    return true;
  });
}

// ------------------------------------------------------------------ success ---

test('downloads the asset, hashes the stream and writes it to destFile', async (t) => {
  const dir = await withTempDir(t);
  const { hits, handler } = makeHandler();
  const server = await withServer(t, handler);
  const dest = path.join(dir, 'basemind-x86_64-unknown-linux-gnu.tar.gz');

  const { promise, sleeps } = attempt({ url: server.base + '/asset', destFile: dest, sha256: ASSET_SHA });
  const result = await promise;

  assert.deepEqual(result, { sha256: ASSET_SHA, bytes: ASSET.length });
  assert.deepEqual(await readFile(dest), ASSET);
  assert.equal(hits.get('/asset'), 1);
  assert.deepEqual(sleeps, []);
});

test('accepts an upper-case expected digest', async (t) => {
  const dir = await withTempDir(t);
  const server = await withServer(t, makeHandler().handler);
  const dest = path.join(dir, 'asset.tar.gz');

  const result = await attempt({ url: server.base + '/asset', destFile: dest, sha256: ASSET_SHA.toUpperCase() }).promise;
  assert.equal(result.sha256, ASSET_SHA);
});

test('follows a redirect to the allowlisted asset host', async (t) => {
  const dir = await withTempDir(t);
  const { hits, handler } = makeHandler();
  const server = await withServer(t, handler);
  const dest = path.join(dir, 'asset.tar.gz');

  const result = await attempt({ url: server.base + '/redirect', destFile: dest, sha256: ASSET_SHA }).promise;

  assert.equal(result.sha256, ASSET_SHA);
  assert.equal(hits.get('/redirect'), 1);
  assert.equal(hits.get('/asset'), 1);
  assert.deepEqual(await readFile(dest), ASSET);
});

// -------------------------------------------------------------- http statuses ---

test('403 fails immediately with the status and no retry', async (t) => {
  const dir = await withTempDir(t);
  const { hits, handler } = makeHandler();
  const server = await withServer(t, handler);
  const dest = path.join(dir, 'asset.tar.gz');

  const { promise, sleeps } = attempt({ url: server.base + '/forbidden', destFile: dest, sha256: ASSET_SHA });
  await expectFailure(promise, 'http-status', { status: 403 });

  assert.equal(hits.get('/forbidden'), 1);
  assert.deepEqual(sleeps, []);
  assert.equal(existsSync(dest), false);
});

test('404 fails immediately and never writes a destination file', async (t) => {
  const dir = await withTempDir(t);
  const { hits, handler } = makeHandler();
  const server = await withServer(t, handler);
  const dest = path.join(dir, 'asset.tar.gz');

  const { promise, sleeps } = attempt({ url: server.base + '/notfound', destFile: dest, sha256: ASSET_SHA });
  await expectFailure(promise, 'http-status', { status: 404 });

  assert.equal(hits.get('/notfound'), 1);
  assert.deepEqual(sleeps, []);
  assert.deepEqual(await readdir(dir), []);
});

test('400 is not retried (only 429 and 5xx are)', async (t) => {
  const dir = await withTempDir(t);
  const { hits, handler } = makeHandler();
  const server = await withServer(t, handler);

  const { promise, sleeps } = attempt({ url: server.base + '/badrequest', destFile: path.join(dir, 'a'), sha256: ASSET_SHA });
  await expectFailure(promise, 'http-status', { status: 400 });

  assert.equal(hits.get('/badrequest'), 1);
  assert.deepEqual(sleeps, []);
});

test('429 is retried twice: three requests, sleeps of 1 s then 4 s', async (t) => {
  const dir = await withTempDir(t);
  const { hits, handler } = makeHandler();
  const server = await withServer(t, handler);

  const { promise, sleeps } = attempt({ url: server.base + '/ratelimit', destFile: path.join(dir, 'a'), sha256: ASSET_SHA });
  await expectFailure(promise, 'http-status', { status: 429 });

  assert.equal(hits.get('/ratelimit'), 3);
  assert.deepEqual(sleeps, [1000, 4000]);
});

test('500 is retried twice: three requests, sleeps of 1 s then 4 s', async (t) => {
  const dir = await withTempDir(t);
  const { hits, handler } = makeHandler();
  const server = await withServer(t, handler);

  const { promise, sleeps } = attempt({ url: server.base + '/error', destFile: path.join(dir, 'a'), sha256: ASSET_SHA });
  await expectFailure(promise, 'http-status', { status: 500 });

  assert.equal(hits.get('/error'), 3);
  assert.deepEqual(sleeps, [1000, 4000]);
});

test('a retried download that eventually succeeds returns the verified asset', async (t) => {
  const dir = await withTempDir(t);
  let count = 0;
  const handler = (req, res) => {
    count += 1;
    if (count === 1) {
      res.writeHead(503);
      res.end('try again');
      return;
    }
    res.writeHead(200, { 'content-length': String(ASSET.length) });
    res.end(ASSET);
  };
  const server = await withServer(t, handler);
  const dest = path.join(dir, 'asset.tar.gz');

  const { promise, sleeps } = attempt({ url: server.base + '/asset', destFile: dest, sha256: ASSET_SHA });
  const result = await promise;

  assert.equal(result.sha256, ASSET_SHA);
  assert.equal(count, 2);
  assert.deepEqual(sleeps, [1000]);
  assert.deepEqual(await readFile(dest), ASSET);
});

// ---------------------------------------------------------- transport errors ---

test('a socket destroyed mid-body fails as network, retries twice and cleans the partial file', async (t) => {
  const dir = await withTempDir(t);
  const { hits, handler } = makeHandler();
  const server = await withServer(t, handler);
  const dest = path.join(dir, 'asset.tar.gz');

  const { promise, sleeps } = attempt({ url: server.base + '/destroy', destFile: dest, sha256: ASSET_SHA });
  await expectFailure(promise, 'network');

  assert.equal(hits.get('/destroy'), 3);
  assert.deepEqual(sleeps, [1000, 4000]);
  assert.equal(existsSync(dest), false, 'the partial file is removed');
});

test('a server that never responds hits the total timeout once and cleans up', async (t) => {
  const dir = await withTempDir(t);
  const { hits, handler } = makeHandler();
  const server = await withServer(t, handler);
  const dest = path.join(dir, 'asset.tar.gz');

  const { promise, sleeps } = attempt({
    url: server.base + '/slow',
    destFile: dest,
    sha256: ASSET_SHA,
    totalTimeoutMs: 120,
    connectTimeoutMs: 60,
  });
  await expectFailure(promise, 'timeout');

  assert.equal(hits.get('/slow'), 1, 'a timeout is not retried');
  assert.deepEqual(sleeps, []);
  assert.equal(existsSync(dest), false);
});

test('a caller abort fails as aborted and removes the partial file', async (t) => {
  const dir = await withTempDir(t);
  const { hits, handler } = makeHandler();
  const server = await withServer(t, handler);
  const dest = path.join(dir, 'asset.tar.gz');
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 30);

  const { promise, sleeps } = attempt({
    url: server.base + '/slow',
    destFile: dest,
    sha256: ASSET_SHA,
    signal: controller.signal,
    totalTimeoutMs: 5000,
  });
  await expectFailure(promise, 'aborted');

  assert.equal(hits.get('/slow'), 1);
  assert.deepEqual(sleeps, []);
  assert.equal(existsSync(dest), false);
});

test('an already-aborted signal never starts a request', async (t) => {
  const dir = await withTempDir(t);
  const { hits, handler } = makeHandler();
  const server = await withServer(t, handler);

  const { promise } = attempt({
    url: server.base + '/asset',
    destFile: path.join(dir, 'a'),
    sha256: ASSET_SHA,
    signal: AbortSignal.abort(),
  });
  await expectFailure(promise, 'aborted');

  assert.equal(hits.get('/asset'), undefined);
});

// ----------------------------------------------------------------- redirects ---

test('a redirect to a host outside the allowlist is refused before it is fetched', async (t) => {
  const dir = await withTempDir(t);
  const external = makeHandler();
  const externalServer = await withServer(t, external.handler);
  const { hits, handler } = makeHandler({ externalUrl: 'http://localhost:' + externalServer.port + '/asset' });
  const server = await withServer(t, handler);

  const { promise } = attempt({
    url: server.base + '/redirect-external',
    destFile: path.join(dir, 'a'),
    sha256: ASSET_SHA,
  });
  await expectFailure(promise, 'redirect', { message: /localhost/ });

  assert.equal(hits.get('/redirect-external'), 1);
  assert.equal(external.hits.get('/asset'), undefined, 'the disallowed host is never contacted');
});

test('more than five redirects fails with a redirect error', async (t) => {
  const dir = await withTempDir(t);
  const { hits, handler } = makeHandler();
  const server = await withServer(t, handler);

  const { promise } = attempt({ url: server.base + '/redirect-loop', destFile: path.join(dir, 'a'), sha256: ASSET_SHA });
  await expectFailure(promise, 'redirect', { message: /redirect/ });

  assert.equal(hits.get('/redirect-loop'), 6);
});

test('a redirect without a location header fails as redirect', async (t) => {
  const dir = await withTempDir(t);
  const { handler } = makeHandler();
  const server = await withServer(t, handler);

  const { promise } = attempt({ url: server.base + '/redirect-nowhere', destFile: path.join(dir, 'a'), sha256: ASSET_SHA });
  await expectFailure(promise, 'redirect');
});

// -------------------------------------------------------------------- limits ---

test('a declared Content-Length above maxBytes fails before any body is written', async (t) => {
  const dir = await withTempDir(t);
  const { hits, handler } = makeHandler();
  const server = await withServer(t, handler);
  const dest = path.join(dir, 'asset.tar.gz');

  const { promise, sleeps } = attempt({
    url: server.base + '/too-large',
    destFile: dest,
    sha256: ASSET_SHA,
    maxBytes: 1024,
  });
  await expectFailure(promise, 'too-large');

  assert.equal(hits.get('/too-large'), 1);
  assert.deepEqual(sleeps, []);
  assert.equal(existsSync(dest), false);
});

test('a stream that grows past maxBytes without Content-Length fails and is removed', async (t) => {
  const dir = await withTempDir(t);
  const { hits, handler } = makeHandler();
  const server = await withServer(t, handler);
  const dest = path.join(dir, 'asset.tar.gz');

  const { promise } = attempt({
    url: server.base + '/chunked-large',
    destFile: dest,
    sha256: ASSET_SHA,
    maxBytes: 64,
  });
  await expectFailure(promise, 'too-large');

  assert.equal(hits.get('/chunked-large'), 1);
  assert.equal(existsSync(dest), false);
});

// ---------------------------------------------------------------- checksum ---

test('a sha256 mismatch deletes the file and never leaves an unverified binary behind', async (t) => {
  const dir = await withTempDir(t);
  const { hits, handler } = makeHandler();
  const server = await withServer(t, handler);
  const dest = path.join(dir, 'basemind');

  const wrong = 'f'.repeat(64);
  const { promise, sleeps } = attempt({ url: server.base + '/asset', destFile: dest, sha256: wrong });
  await expectFailure(promise, 'checksum-mismatch', { message: /refusing to use an unverified binary/ });

  assert.equal(hits.get('/asset'), 1);
  assert.deepEqual(sleeps, []);
  assert.equal(existsSync(dest), false);
  await assert.rejects(stat(dest), /ENOENT/, 'no file remains for a later --version probe');
  assert.deepEqual(await readdir(dir), [], 'the staging directory is left empty');
});

// ------------------------------------------------------------- url and io -----

test('refuses non-https URLs and hosts outside the allowlist', async (t) => {
  const dir = await withTempDir(t);
  const dest = path.join(dir, 'a');

  await expectFailure(
    attempt({ url: 'http://127.0.0.1/asset', destFile: dest, sha256: ASSET_SHA, allowInsecure: false }).promise,
    'bad-url',
    { message: /https only/ },
  );
  await expectFailure(attempt({ url: 'ftp://127.0.0.1/asset', destFile: dest, sha256: ASSET_SHA }).promise, 'bad-url');
  await expectFailure(
    attempt({ url: 'https://evil.example/basemind.zip', destFile: dest, sha256: ASSET_SHA }).promise,
    'bad-url',
    { message: /evil\.example/ },
  );
  await expectFailure(attempt({ url: 'not a url', destFile: dest, sha256: ASSET_SHA }).promise, 'bad-url');
});

test('rejects a missing or non-hex expected digest before touching the network', async (t) => {
  const dir = await withTempDir(t);
  const dest = path.join(dir, 'a');
  const { hits, handler } = makeHandler();
  const server = await withServer(t, handler);

  await expectFailure(attempt({ url: server.base + '/asset', destFile: dest, sha256: '' }).promise, 'bad-url');
  await expectFailure(attempt({ url: server.base + '/asset', destFile: dest, sha256: 'abc' }).promise, 'bad-url');
  assert.equal(hits.get('/asset'), undefined);

  await expectFailure(attempt({ url: server.base + '/asset', destFile: '', sha256: ASSET_SHA }).promise, 'io');
  await expectFailure(attempt({ url: server.base + '/asset', destFile: dest, sha256: ASSET_SHA, fetchImpl: null }).promise, 'network');
});

test('an ENOSPC from the injected file system surfaces as an io failure', async (t) => {
  const dir = await withTempDir(t);
  const server = await withServer(t, makeHandler().handler);
  const dest = path.join(dir, 'asset.tar.gz');

  const unlinked = [];
  const fs = {
    open: async () => {
      const error = new Error('no space left on device');
      error.code = 'ENOSPC';
      throw error;
    },
    unlink: async (file) => {
      unlinked.push(file);
    },
  };

  const { promise } = attempt({ url: server.base + '/asset', destFile: dest, sha256: ASSET_SHA, fs });
  await expectFailure(promise, 'io', { message: /ENOSPC|no space left/ });
  assert.deepEqual(unlinked, [dest], 'the failed destination is discarded');
});

test('the injected file system receives exactly the streamed bytes', async (t) => {
  const dir = await withTempDir(t);
  const server = await withServer(t, makeHandler().handler);
  const chunks = [];
  let closed = 0;
  const fs = {
    open: async () => ({
      write: async (chunk) => {
        chunks.push(Buffer.from(chunk));
      },
      close: async () => {
        closed += 1;
      },
    }),
    unlink: async () => {},
  };

  const result = await attempt({ url: server.base + '/asset', destFile: '/injected/basemind', sha256: ASSET_SHA, fs }).promise;

  assert.equal(result.bytes, ASSET.length);
  assert.deepEqual(Buffer.concat(chunks), ASSET);
  assert.equal(closed, 1);
  assert.equal(existsSync(path.join(dir, 'basemind')), false);
});

test('DownloadError carries the failure code and is an Error', () => {
  const error = new DownloadError('http-status', 'HTTP 404', { status: 404 });
  assert.ok(error instanceof Error);
  assert.equal(error.name, 'DownloadError');
  assert.equal(error.code, 'http-status');
  assert.equal(error.status, 404);
  assert.equal(error.message, 'HTTP 404');
});
