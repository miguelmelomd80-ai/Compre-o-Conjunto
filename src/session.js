// Sessão do painel: cookie assinado com HMAC (sem dependências externas).
const crypto = require('node:crypto');

const COOKIE = 'cdc_session';
const MAX_AGE = 60 * 60 * 24 * 7; // 7 dias

function secret() {
  const s = process.env.SESSION_SECRET;
  if (!s && process.env.NODE_ENV === 'production') throw new Error('Defina SESSION_SECRET');
  return s || 'dev-secret-nao-use-em-producao';
}

const sign = v => crypto.createHmac('sha256', secret()).update(v).digest('base64url');

function setSession(req, res, storeId) {
  const payload = Buffer.from(JSON.stringify({ s: String(storeId), e: Date.now() + MAX_AGE * 1000 })).toString('base64url');
  const secure = req.secure || req.headers['x-forwarded-proto'] === 'https';
  // SameSite=None permite abrir o painel dentro do admin da Nuvemshop (iframe) quando em HTTPS.
  const attrs = [`${COOKIE}=${payload}.${sign(payload)}`, 'Path=/', 'HttpOnly', `Max-Age=${MAX_AGE}`,
    secure ? 'SameSite=None; Secure' : 'SameSite=Lax'];
  res.setHeader('Set-Cookie', attrs.join('; '));
}

function getSession(req) {
  const raw = (req.headers.cookie || '').split(/;\s*/).find(c => c.startsWith(COOKIE + '='));
  if (!raw) return null;
  const [payload, sig] = raw.slice(COOKIE.length + 1).split('.');
  if (!payload || !sig) return null;
  const expected = sign(payload);
  if (sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString());
    return data.e > Date.now() ? data.s : null;
  } catch { return null; }
}

function clearSession(res) {
  res.setHeader('Set-Cookie', `${COOKIE}=; Path=/; Max-Age=0`);
}

module.exports = { setSession, getSession, clearSession };
