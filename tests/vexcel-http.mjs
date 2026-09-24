import test from 'node:test';
import assert from 'node:assert/strict';
import { requestJson, requestBytes, HttpRequestError } from '../scripts/vexcel-http.mjs';

const secretUrl = 'https://example.test/tile?token=TOP_SECRET';
const reply = (status, data, retryAfter) => ({
  ok: status >= 200 && status < 300,
  status,
  headers: { get: (name) => name === 'retry-after' ? retryAfter : null },
  json: async () => data,
  arrayBuffer: async () => Uint8Array.from(data).buffer,
});

test('returns parsed JSON and Buffer bytes', async () => {
  assert.deepEqual(await requestJson(async () => reply(200, { result: 1 }), secretUrl), { result: 1 });
  const bytes = await requestBytes(async () => reply(200, [0xff, 0xd8, 0xd9]), secretUrl);
  assert.ok(Buffer.isBuffer(bytes));
  assert.deepEqual([...bytes], [0xff, 0xd8, 0xd9]);
});

test('timeout remains active during hanging JSON and binary bodies, including uncooperative readers', async () => {
  for (const [request, method] of [[requestJson, 'json'], [requestBytes, 'arrayBuffer']]) {
    let calls = 0;
    const fetcher = async (_url, init) => {
      calls++;
      assert.equal(init.signal.aborted, false);
      return { ok: true, status: 200, [method]: () => new Promise(() => {}) };
    };
    const started = Date.now();
    await assert.rejects(request(fetcher, secretUrl, {}, { timeoutMs: 20, retries: 1, wait: async () => {} }),
      { code: 'TIMEOUT', retryable: true });
    assert.equal(calls, 2);
    assert.ok(Date.now() - started < 1500, 'a hanging body should not block forever');
  }
});

test('caller abort interrupts body consumption and never retries', async () => {
  const caller = new AbortController();
  let calls = 0;
  const fetching = requestBytes(async (_url, init) => {
    calls++;
    assert.notEqual(init.signal, caller.signal);
    return { ok: true, status: 200, arrayBuffer: () => {
      caller.abort('TOP_SECRET');
      return new Promise(() => {});
    } };
  }, secretUrl, { signal: caller.signal }, { retries: 3, timeoutMs: 1000 });
  await assert.rejects(fetching, { code: 'ABORTED', retryable: false });
  assert.equal(calls, 1);
  await assert.rejects(requestJson(() => { throw new Error('should not fetch'); }, secretUrl,
    {}, { signal: caller.signal }), { code: 'ABORTED' });
});

test('both signal options work and timeout covers a fetch that never resolves', async () => {
  const caller = new AbortController();
  const other = new AbortController();
  const fetching = requestJson(async () => new Promise(() => {}), secretUrl,
    { signal: caller.signal }, { signal: other.signal, retries: 0, timeoutMs: 15 });
  await assert.rejects(fetching, { code: 'TIMEOUT' });
  const body = requestJson(async () => ({ ok: true, status: 200,
    json: () => { other.abort(); return new Promise(() => {}); } }),
  secretUrl, { signal: caller.signal }, { signal: other.signal });
  await assert.rejects(body, { code: 'ABORTED' });
});

test('caller abort interrupts retry backoff even when injected wait hangs', async () => {
  const caller = new AbortController();
  let calls = 0;
  await assert.rejects(requestJson(async () => {
    calls++;
    return reply(503, null);
  }, secretUrl, {}, { signal: caller.signal, retries: 3, wait: () => {
    caller.abort();
    return new Promise(() => {});
  } }), { code: 'ABORTED' });
  assert.equal(calls, 1);
});

test('retries network failures, 429, 5xx and truncated binary reads with bounded backoff', async () => {
  const delays = [];
  let calls = 0;
  const result = await requestBytes(async () => {
    calls++;
    if (calls === 1) throw new Error('TOP_SECRET network failure');
    if (calls === 2) return reply(429, null, '99999');
    if (calls === 3) return reply(502, null);
    if (calls === 4) return { ok: true, status: 200, arrayBuffer: () => {
      throw new TypeError('TOP_SECRET truncated body');
    } };
    return reply(200, [1, 2]);
  }, secretUrl, {}, { retries: 4, wait: async (ms) => { delays.push(ms); } });
  assert.deepEqual([...result], [1, 2]);
  assert.equal(calls, 5);
  assert.deepEqual(delays, [200, 5000, 800, 1600]);
});

test('permanent status and invalid JSON fail without retry or leaking URLs and bodies', async () => {
  for (const [make, expectedCode, expectedStatus] of [
    [() => reply(401, null), 'HTTP_STATUS', 401],
    [() => ({ ok: true, status: 200, json: () => {
      throw new SyntaxError('Unexpected TOP_SECRET from response body');
    } }), 'INVALID_JSON', undefined],
  ]) {
    let calls = 0;
    await assert.rejects(requestJson(async () => { calls++; return make(); }, secretUrl, {},
      { retries: 3, wait: async () => {} }), (error) => {
      assert.ok(error instanceof HttpRequestError);
      assert.equal(error.code, expectedCode);
      assert.equal(error.status, expectedStatus);
      assert.equal(error.retryable, false);
      assert.doesNotMatch(`${error.stack}\n${JSON.stringify(error)}`, /TOP_SECRET|example\.test|response body/);
      return true;
    });
    assert.equal(calls, 1);
  }
});

test('exhausted retriable failures are classified without exposing exception details', async () => {
  for (const [fetcher, code, status] of [
    [async () => reply(503, null), 'HTTP_STATUS', 503],
    [async () => { throw new Error('TOP_SECRET in URL or request body'); }, 'NETWORK', undefined],
    [async () => { throw new HttpRequestError('TOP_SECRET fake internal error', 'HTTP_STATUS'); }, 'NETWORK', undefined],
  ]) {
    await assert.rejects(requestJson(fetcher, secretUrl, {}, { retries: 1, wait: async () => {} }), (error) => {
      assert.equal(error.code, code);
      assert.equal(error.status, status);
      assert.equal(error.retryable, true);
      assert.doesNotMatch(`${error.stack}\n${JSON.stringify(error)}`, /TOP_SECRET|example\.test/);
      return true;
    });
  }
});
