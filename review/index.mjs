import { appendFile, readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const AUDIENCE = 'bomoon-bot:review';
const SHA = /^[0-9a-f]{40}$/;
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const positive = value => Number.isSafeInteger(value) && value > 0;
const fail = message => { throw new ActionError(message); };
export class ActionError extends Error {}

function serviceOrigin(value) {
  let url;
  try { url = new URL(value); } catch { fail('service-url must be a trusted HTTPS origin.'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' ||
      url.search || url.hash || !/^https:\/\/[^/?#@\\\s]+\/?$/.test(value)) {
    fail('service-url must be a trusted HTTPS origin, without path, query, fragment, or userinfo.');
  }
  return url.origin;
}

function githubCheckUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.hostname === 'github.com' && !url.port &&
      !url.username && !url.password && !/[\r\n]/.test(value);
  } catch { return false; }
}

function secret(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 32768 && !/[\r\n]/.test(value);
}

// All failures use controlled messages: fetch/JSON exceptions may contain credentials or URLs.
export async function run({ env = process.env, fetch: fetchFn = globalThis.fetch,
  read = readFile, output = async values => {
    if (!env.GITHUB_OUTPUT) fail('GitHub output file is unavailable.');
    await appendFile(env.GITHUB_OUTPUT, Object.entries(values).map(([k, v]) => `${k}=${v}\n`).join(''));
  }, mask = value => console.log(`::add-mask::${value.replaceAll('%', '%25').replaceAll('\r', '%0D').replaceAll('\n', '%0A')}`),
  now = Date.now, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)),
  deadlineMs = 25 * 60 * 1000, requestTimeoutMs = 15000, pollMs = 10000 } = {}) {
  const deadline = now() + deadlineMs;
  const remaining = () => {
    const ms = deadline - now();
    if (ms <= 0) fail('Review deadline exceeded; inspect the App check on GitHub.');
    return ms;
  };
  async function pause(ms) {
    await sleep(Math.min(ms, remaining()));
    remaining();
  }
  async function request(url, options, label) {
    for (let attempt = 0; attempt < 4; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), Math.min(requestTimeoutMs, remaining()));
      let retry = false;
      try {
        const response = await fetchFn(url, { ...options, redirect: 'manual', signal: controller.signal });
        if (response.status === 429 || (response.status >= 500 && response.status <= 599)) {
          retry = true;
          // Release the body before retrying; never print upstream error bodies.
          await response.body?.cancel();
        } else {
          if (response.status < 200 || response.status >= 300) fail(`${label} was rejected (HTTP ${response.status}).`);
          let data;
          try { data = await response.json(); } catch { fail(`${label} returned invalid JSON.`); }
          remaining();
          return { status: response.status, data };
        }
      } catch (error) {
        if (error instanceof ActionError) throw error;
        retry = true;
      } finally {
        clearTimeout(timer);
      }
      if (retry && attempt < 3) await pause(1000 * 2 ** attempt);
    }
    fail(`${label} failed after bounded retries.`);
  }

  if (env.GITHUB_EVENT_NAME !== 'pull_request') fail('Only pull_request events are supported.');
  let event;
  try { event = JSON.parse(await read(env.GITHUB_EVENT_PATH, 'utf8')); }
  catch { fail('Cannot read GitHub pull request event.'); }
  const pr = event?.number;
  const head = event?.pull_request?.head?.sha;
  const repo = env.GITHUB_REPOSITORY;
  if (!positive(pr) || !SHA.test(head ?? '') || !REPOSITORY.test(repo ?? '') ||
      event?.repository?.full_name !== repo || event?.pull_request?.number !== pr ||
      event?.pull_request?.base?.repo?.full_name !== repo) fail('Invalid GitHub pull request context.');
  if (event.pull_request.state !== 'open') fail('Pull request is not open.');
  if (event.pull_request.draft === true) {
    await output({ conclusion: 'skipped', 'check-url': '', 'head-sha': head });
    return { conclusion: 'skipped', exitCode: 0 };
  }
  const origin = serviceOrigin(env['INPUT_SERVICE-URL']);
  const githubToken = env['INPUT_GITHUB-TOKEN'];
  if (!secret(githubToken)) fail('github-token is required.');
  mask(githubToken);
  if (!secret(env.ACTIONS_ID_TOKEN_REQUEST_TOKEN) || !env.ACTIONS_ID_TOKEN_REQUEST_URL) {
    fail('GitHub OIDC is unavailable; grant id-token: write. Fork OIDC is not supported.');
  }
  mask(env.ACTIONS_ID_TOKEN_REQUEST_TOKEN);
  let oidcUrl;
  try { oidcUrl = new URL(env.ACTIONS_ID_TOKEN_REQUEST_URL); }
  catch { fail('Invalid GitHub OIDC request URL.'); }
  if (oidcUrl.protocol !== 'https:' || oidcUrl.username || oidcUrl.password || oidcUrl.hash) {
    fail('Invalid GitHub OIDC request URL.');
  }
  oidcUrl.searchParams.set('audience', AUDIENCE);
  const { data: oidc } = await request(oidcUrl.href, {
    headers: { Authorization: `Bearer ${env.ACTIONS_ID_TOKEN_REQUEST_TOKEN}` },
  }, 'GitHub OIDC request');
  if (!secret(oidc?.value)) fail('GitHub OIDC returned an invalid token.');
  mask(oidc.value);
  const { data: accepted, status } = await request(`${origin}/github/review`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${oidc.value}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ pr, head_sha: head }),
  }, 'Review request');
  if (status !== 202 || !accepted ||
      Object.keys(accepted).sort().join(',') !== 'app_id,check_id,check_url,head_sha' ||
      !positive(accepted.check_id) || !positive(accepted.app_id) || accepted.head_sha !== head ||
      !githubCheckUrl(accepted.check_url)) fail('Review service returned an invalid response.');

  // This fixed origin is the only destination that ever receives github-token.
  const api = `https://api.github.com/repos/${repo.split('/').map(encodeURIComponent).join('/')}`;
  const headers = { Authorization: `Bearer ${githubToken}`, Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'bomoon-bot-review-action' };
  for (;;) {
    remaining();
    const { data: check } = await request(`${api}/check-runs/${accepted.check_id}`, { headers }, 'GitHub check read');
    if (check?.id !== accepted.check_id || check?.head_sha !== head || check?.app?.id !== accepted.app_id) {
      fail('GitHub check identity does not match the requested review.');
    }
    if (check.status === 'completed') {
      if (typeof check.conclusion !== 'string' || !/^[a-z_]+$/.test(check.conclusion)) {
        fail('GitHub check has an invalid terminal conclusion.');
      }
      const { data: current } = await request(`${api}/pulls/${pr}`, { headers }, 'GitHub pull request read');
      if (current?.head?.sha !== head || current?.state !== 'open' || current?.draft !== false) {
        fail('Pull request changed, closed, or became draft; this review is stale.');
      }
      await output({ conclusion: check.conclusion, 'check-url': accepted.check_url, 'head-sha': head });
      return { conclusion: check.conclusion, exitCode: ['success', 'neutral'].includes(check.conclusion) ? 0 : 1 };
    }
    if (!['queued', 'in_progress', 'waiting', 'pending', 'requested'].includes(check.status)) {
      fail('GitHub check returned an invalid status.');
    }
    await pause(pollMs);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const result = await run();
    console.log(result.conclusion === 'skipped' ? 'Draft pull request: review skipped.' : `Review check conclusion: ${result.conclusion}.`);
    process.exitCode = result.exitCode;
  } catch (error) {
    console.error(`::error::${error instanceof ActionError ? error.message : 'Review action failed.'}`);
    process.exitCode = 1;
  }
}
