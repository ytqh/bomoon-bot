import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { run, ActionError } from './index.mjs';

const head = 'a'.repeat(40);
const accepted = { check_id: 12, check_url: 'https://github.com/example/project/runs/12', head_sha: head, app_id: 34 };
const check = { id: 12, head_sha: head, app: { id: 34 }, status: 'completed', conclusion: 'success' };
const current = { head: { sha: head }, state: 'open', draft: false };
const event = { number: 7, repository: { full_name: 'example/project' }, pull_request: {
  number: 7, head: { sha: head }, base: { repo: { full_name: 'example/project' } }, state: 'open', draft: false,
} };
const clone = value => structuredClone(value);
function setup(overrides = {}) {
  const calls = [], outputs = [], masks = [];
  const responses = [
    { data: { value: 'oidc-secret' } }, { status: 202, data: clone(accepted) },
    { data: clone(check) }, { data: clone(current) },
  ];
  let clock = 0;
  const options = {
    env: { GITHUB_EVENT_NAME: 'pull_request', GITHUB_REPOSITORY: 'example/project', GITHUB_EVENT_PATH: '/event.json',
      'INPUT_SERVICE-URL': 'https://review.example.test', 'INPUT_GITHUB-TOKEN': 'github-secret',
      ACTIONS_ID_TOKEN_REQUEST_URL: 'https://oidc.example.test/token?existing=1',
      ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'request-secret' },
    read: async () => JSON.stringify(event),
    fetch: async (url, options) => {
      calls.push({ url, ...options });
      const response = responses.shift();
      assert.ok(response, 'Unexpected HTTP request');
      if (response.error) throw response.error;
      return new Response(JSON.stringify(response.data ?? {}), { status: response.status ?? 200 });
    },
    output: async values => outputs.push(values), mask: value => masks.push(value),
    now: () => clock, sleep: async ms => { clock += ms; },
    ...overrides,
  };
  return { options, calls, responses, outputs, masks, run: () => run(options) };
}

test('exact wire, credential separation, no checkout, terminal outputs', async () => {
  const h = setup();
  assert.deepEqual(await h.run(), { conclusion: 'success', exitCode: 0 });
  assert.equal(h.calls.length, 4);
  assert.equal(new URL(h.calls[0].url).searchParams.get('audience'), 'bomoon-bot:review');
  assert.equal(h.calls[0].headers.Authorization, 'Bearer request-secret');
  assert.equal(h.calls[1].url, 'https://review.example.test/github/review');
  assert.equal(h.calls[1].method, 'POST');
  assert.deepEqual(JSON.parse(h.calls[1].body), { pr: 7, head_sha: head });
  assert.equal(h.calls[1].headers.Authorization, 'Bearer oidc-secret');
  for (const call of h.calls) {
    assert.equal(call.redirect, 'manual');
    assert.ok(call.signal instanceof AbortSignal);
    if (call.headers.Authorization === 'Bearer github-secret') assert.equal(new URL(call.url).origin, 'https://api.github.com');
    if (call.headers.Authorization === 'Bearer oidc-secret') assert.equal(new URL(call.url).origin, 'https://review.example.test');
  }
  assert.equal(h.calls[2].url, 'https://api.github.com/repos/example/project/check-runs/12');
  assert.equal(h.calls[3].url, 'https://api.github.com/repos/example/project/pulls/7');
  assert.deepEqual(h.outputs, [{ conclusion: 'success', 'check-url': accepted.check_url, 'head-sha': head }]);
  assert.deepEqual(h.masks, ['github-secret', 'request-secret', 'oidc-secret']);
});

for (const conclusion of ['success', 'neutral', 'failure', 'cancelled', 'timed_out', 'skipped', 'action_required', 'stale', 'startup_failure']) {
  test(`terminal ${conclusion} has truthful output and exit code`, async () => {
    const h = setup();
    h.responses[2].data.conclusion = conclusion;
    const result = await h.run();
    assert.equal(result.exitCode, ['success', 'neutral'].includes(conclusion) ? 0 : 1);
    assert.equal(h.outputs[0].conclusion, conclusion);
  });
}

test('draft skips explicitly before authentication', async () => {
  const draft = clone(event); draft.pull_request.draft = true;
  const h = setup({ read: async () => JSON.stringify(draft), env: {
    GITHUB_EVENT_NAME: 'pull_request', GITHUB_REPOSITORY: 'example/project',
  } });
  assert.deepEqual(await h.run(), { conclusion: 'skipped', exitCode: 0 });
  assert.equal(h.calls.length, 0);
  assert.equal(h.outputs[0].conclusion, 'skipped');
});

for (const [name, change, expected] of [
  ['unsupported event', h => { h.options.env.GITHUB_EVENT_NAME = 'pull_request_target'; }, /Only pull_request/],
  ['missing OIDC', h => { delete h.options.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN; }, /OIDC is unavailable/],
  ['invalid PR', h => { h.options.read = async () => JSON.stringify({ ...event, number: -1 }); }, /Invalid GitHub/],
  ['uppercase head', h => { const e = clone(event); e.pull_request.head.sha = 'A'.repeat(40); h.options.read = async () => JSON.stringify(e); }, /Invalid GitHub/],
  ['wrong repository', h => { h.options.env.GITHUB_REPOSITORY = 'other/repo'; }, /Invalid GitHub/],
]) {
  test(`${name} fails before any HTTP request`, async () => {
    const h = setup(); change(h);
    await assert.rejects(h.run(), expected);
    assert.equal(h.calls.length, 0);
  });
}

for (const url of ['http://review.example.test', 'https://review.example.test/path', 'https://review.example.test/a/..',
  'https://user@review.example.test', 'https://@review.example.test', 'https://review.example.test?x=1',
  'https://review.example.test#', 'https://review.example.test\\path', ' https://review.example.test']) {
  test(`invalid service origin rejected: ${url}`, async () => {
    const h = setup(); h.options.env['INPUT_SERVICE-URL'] = url;
    await assert.rejects(h.run(), /HTTPS origin/);
    assert.equal(h.calls.length, 0);
  });
}

for (const patch of [ { check_id: 0 }, { app_id: -1 }, { head_sha: 'b'.repeat(40) },
  { check_url: 'https://evil.example.test/check' }, { check_url: 'https://github.com@evil.example.test/check' },
  { extra: true } ]) {
  test(`invalid acceptance rejected: ${JSON.stringify(patch)}`, async () => {
    const h = setup(); Object.assign(h.responses[1].data, patch);
    await assert.rejects(h.run(), /invalid response/);
    assert.equal(h.calls.length, 2); assert.equal(h.outputs.length, 0);
  });
}

test('requires HTTP 202 acceptance', async () => {
  const h = setup(); h.responses[1].status = 200;
  await assert.rejects(h.run(), /invalid response/);
});
for (const patch of [{ head_sha: 'b'.repeat(40) }, { app: { id: 99 } }, { id: 99 }]) {
  test('check identity mismatch fails closed', async () => {
    const h = setup(); Object.assign(h.responses[2].data, patch);
    await assert.rejects(h.run(), /identity/); assert.equal(h.outputs.length, 0);
  });
}
for (const patch of [{ head: { sha: 'b'.repeat(40) } }, { state: 'closed' }, { draft: true }, { draft: undefined }]) {
  test('terminal check requires current open non-draft PR at same head', async () => {
    const h = setup(); Object.assign(h.responses[3].data, patch);
    await assert.rejects(h.run(), /stale/); assert.equal(h.outputs.length, 0);
  });
}

test('polls nonterminal checks', async () => {
  const h = setup(); h.responses.splice(2, 0, { data: { ...check, status: 'in_progress', conclusion: null } });
  assert.equal((await h.run()).exitCode, 0);
  assert.equal(h.calls.length, 5);
});

test('pending check reaches finite overall deadline with no success output', async () => {
  const h = setup({ deadlineMs: 20, pollMs: 20 }); h.responses[2].data.status = 'in_progress';
  await assert.rejects(h.run(), /deadline exceeded/); assert.equal(h.outputs.length, 0);
});

for (const retry of [{ error: new Error('sensitive network details') }, { status: 429 }, { status: 503 }]) {
  test('retries POST only bounded transient errors with identical body', async () => {
    const h = setup(); h.responses.splice(1, 0, retry);
    assert.equal((await h.run()).exitCode, 0);
    assert.equal(h.calls[1].body, h.calls[2].body);
  });
}
for (const status of [400, 401, 403, 409, 302]) {
  test(`does not retry POST HTTP ${status}`, async () => {
    const h = setup(); h.responses[1] = { status, data: { error: 'private details' } };
    await assert.rejects(h.run(), new RegExp(`Review request was rejected \\(HTTP ${status}\\)`));
    assert.equal(h.calls.length, 2);
  });
}

test('network failure retries exactly four times without leaking exception', async () => {
  const h = setup(); h.responses.splice(1, 0, ...Array.from({ length: 4 }, () => ({ error: new Error('secret') })));
  await assert.rejects(h.run(), error => error instanceof ActionError && error.message === 'Review request failed after bounded retries.');
  assert.equal(h.calls.length, 5);
});

test('invalid JSON returns controlled error', async () => {
  const h = setup({ fetch: async () => new Response('sensitive invalid JSON') });
  await assert.rejects(h.run(), error => error.message === 'GitHub OIDC request returned invalid JSON.');
});

// Exercise real fetch redirect/abort behavior against a local HTTP fixture. The
// injected transport maps HTTPS test destinations to loopback; production never does.
async function fixture(t, handler) {
  const server = createServer(handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  return `http://127.0.0.1:${server.address().port}`;
}

test('real fetch refuses redirect and never forwards credentials to its target', async t => {
  let redirected = 0, requests = 0;
  const origin = await fixture(t, (req, res) => {
    requests++;
    if (req.url === '/target') { redirected++; res.end('{}'); }
    else { res.writeHead(302, { Location: '/target' }); res.end(); }
  });
  const h = setup({ fetch: (_url, options) => fetch(`${origin}/redirect`, options) });
  await assert.rejects(h.run(), /was rejected \(HTTP 302\)/);
  assert.equal(redirected, 0);
  assert.equal(requests, 1);
});

test('real fetch aborts each hung request at request timeout', async t => {
  let requests = 0;
  const origin = await fixture(t, () => { requests++; });
  const h = setup({ requestTimeoutMs: 30, fetch: (_url, options) => fetch(origin, options) });
  await assert.rejects(h.run(), /failed after bounded retries/);
  assert.ok(requests > 0 && requests <= 4);
});
