// TEST ONLY: deterministic browser PKCE fixture. Never production identity.
// Usage: node scripts/native-oidc-fixture.mjs <port|0> <dev-access-token-file>
// The access token must come from the separately running dev API. This provider
// issues ephemeral nonce-bound ID tokens and never writes signing keys to disk.
import http from 'node:http';
import {createHash, generateKeyPairSync, randomBytes, sign} from 'node:crypto';
import {readFileSync} from 'node:fs';

const port = Number(process.argv[2]);
if (!Number.isInteger(port) || port < 0 || port > 65535 || !process.argv[3]) {
  throw new Error('Usage: native-oidc-fixture.mjs <port|0> <dev-access-token-file>');
}
let issuer = `http://127.0.0.1:${port}`;
const client = '388199923079774215';
const redirect = 'pipod://auth/callback';
const pair = generateKeyPairSync('rsa', {modulusLength: 2048});
const key = pair.privateKey;
const jwk = {publicJwk: {...pair.publicKey.export({format: 'jwk'}), kid: randomBytes(12).toString('hex'), alg: 'RS256', use: 'sig'}};
const access = readFileSync(process.argv[3], 'utf8').trim();
const subject = JSON.parse(Buffer.from(access.split('.')[1], 'base64url')).sub;
const pending = new Map(), codes = new Map(), refreshes = new Map();
const opaque = () => randomBytes(32).toString('base64url');
const hash = value => createHash('sha256').update(value).digest('base64url');
function idToken(nonce) {
  const now = Math.floor(Date.now() / 1000);
  const header = Buffer.from(JSON.stringify({alg: 'RS256', typ: 'JWT', kid: jwk.publicJwk.kid})).toString('base64url');
  const payload = Buffer.from(JSON.stringify({iss: issuer, sub: subject, aud: client, azp: client, iat: now, exp: now + 300, nonce, name: 'Native fixture user'})).toString('base64url');
  const data = `${header}.${payload}`;
  return `${data}.${sign('RSA-SHA256', Buffer.from(data), key).toString('base64url')}`;
}
function json(res, status, body) {
  res.writeHead(status, {'Content-Type': 'application/json', 'Cache-Control': 'no-store'});
  res.end(JSON.stringify(body));
}
function go(res, destination) {
  res.writeHead(302, {Location: destination, 'Cache-Control': 'no-store'}); res.end();
}
function tokens(res, record) {
  const token = `fixture+${opaque()}+rotate`;
  refreshes.set(token, {...record, expires: Date.now() + 3600000});
  json(res, 200, {access_token: access, token_type: 'Bearer', expires_in: 300, refresh_token: token, id_token: idToken(record.nonce)});
}
async function body(req) {
  let text = '';
  for await (const chunk of req) { text += chunk; if (text.length > 16384) throw new Error('Oversize'); }
  return new URLSearchParams(text);
}
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, issuer);
    if (req.method === 'GET' && url.pathname === '/.well-known/openid-configuration') {
      return json(res, 200, {issuer, authorization_endpoint: `${issuer}/authorize`, token_endpoint: `${issuer}/token`, jwks_uri: `${issuer}/jwks`, revocation_endpoint: `${issuer}/revoke`, end_session_endpoint: `${issuer}/logout`, response_types_supported: ['code'], subject_types_supported: ['public'], id_token_signing_alg_values_supported: ['RS256'], code_challenge_methods_supported: ['S256'], token_endpoint_auth_methods_supported: ['none']});
    }
    if (req.method === 'GET' && url.pathname === '/jwks') return json(res, 200, {keys: [jwk.publicJwk]});
    if (req.method === 'GET' && url.pathname === '/authorize') {
      const p = url.searchParams;
      if (p.get('client_id') !== client || p.get('redirect_uri') !== redirect || p.get('response_type') !== 'code' || p.get('code_challenge_method') !== 'S256' || !/^[A-Za-z0-9_-]{43}$/.test(p.get('code_challenge') ?? '') || !p.get('nonce') || !p.get('state')) return json(res, 400, {error: 'invalid_request'});
      const ticket = opaque();
      pending.set(ticket, {state: p.get('state'), nonce: p.get('nonce'), challenge: p.get('code_challenge'), expires: Date.now() + 300000});
      res.writeHead(200, {'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self' pipod:; frame-ancestors 'none'"});
      return res.end(`<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>Native sign-in fixture</title><style>body{font:20px system-ui;padding:24px;line-height:1.5}button{font:inherit;display:block;margin:20px 0;padding:16px}h1{font-size:26px}</style></head><body><h1>TEST ONLY: native sign-in</h1><p>This local fixture tests browser authorization, PKCE, and secure token storage. It is not Zitadel and requires no password.</p><form method="post" action="/continue"><input type="hidden" name="ticket" value="${ticket}"><button name="decision" value="continue">Continue as fixture user</button><button name="decision" value="cancel">Cancel sign-in</button></form></body></html>`);
    }
    if (req.method === 'POST' && url.pathname === '/continue') {
      const p = await body(req), ticket = p.get('ticket'), record = pending.get(ticket); pending.delete(ticket);
      if (!record || record.expires < Date.now()) {
        console.log('Consent rejected', {ticketPresent: Boolean(ticket), known: Boolean(record), expired: Boolean(record && record.expires < Date.now())});
        return json(res, 400, {error: 'invalid_request'});
      }
      console.log('Consent accepted', {cancelled: p.get('decision') !== 'continue'});
      const callback = new URL(redirect); callback.searchParams.set('state', record.state);
      if (p.get('decision') !== 'continue') callback.searchParams.set('error', 'access_denied');
      else { const code = opaque(); codes.set(code, record); callback.searchParams.set('code', code); }
      return go(res, callback.href);
    }
    if (req.method === 'POST' && url.pathname === '/token') {
      const p = await body(req);
      if (p.get('client_id') !== client) return json(res, 400, {error: 'invalid_client'});
      if (p.get('grant_type') === 'authorization_code') {
        const code = p.get('code'), record = codes.get(code); codes.delete(code);
        if (!record || record.expires < Date.now() || p.get('redirect_uri') !== redirect || hash(p.get('code_verifier') ?? '') !== record.challenge) return json(res, 400, {error: 'invalid_grant'});
        console.log('PKCE exchange accepted');
        return tokens(res, record);
      }
      if (p.get('grant_type') === 'refresh_token') {
        const token = p.get('refresh_token'), record = refreshes.get(token); refreshes.delete(token);
        if (!record || record.expires < Date.now()) return json(res, 400, {error: 'invalid_grant'});
        return tokens(res, record);
      }
      return json(res, 400, {error: 'unsupported_grant_type'});
    }
    if (req.method === 'POST' && url.pathname === '/revoke') { const p = await body(req); refreshes.delete(p.get('token')); return json(res, 200, {}); }
    if (req.method === 'GET' && url.pathname === '/logout') {
      if (url.searchParams.get('post_logout_redirect_uri') !== redirect || url.searchParams.get('client_id') !== client) return json(res, 400, {error: 'invalid_request'});
      return go(res, redirect);
    }
    json(res, 404, {error: 'not_found'});
  } catch { json(res, 400, {error: 'invalid_request'}); }
});
// Bound fixture state and never print requests, codes, tokens, or authorization URLs.
setInterval(() => { for (const map of [pending, codes, refreshes]) for (const [key, value] of map) if (value.expires < Date.now()) map.delete(key); }, 60000).unref();
server.listen(port, '127.0.0.1', () => {
  issuer = `http://127.0.0.1:${server.address().port}`;
  console.log(JSON.stringify({issuer, testOnly: true}));
});
