// Autenticação do painel. Três formas de entrar:
// 1) Dentro do admin da Nuvemshop (app incorporado): token de sessão do Nexo (JWT assinado com o Client Secret)
// 2) Cookie de sessão do lojista (depois da instalação ou abrindo o app fora do admin)
// 3) Login da agência (e-mail + senha) — acessa todas as lojas que instalaram o app
const crypto = require('node:crypto');

const COOKIE = 'cdc_session';
const MAX_AGE = 60 * 60 * 24 * 7; // 7 dias

function secret() {
  const s = process.env.SESSION_SECRET;
  if (!s && process.env.NODE_ENV === 'production') throw new Error('Defina SESSION_SECRET');
  return s || 'dev-secret-nao-use-em-producao';
}

const hmac = (key, v) => crypto.createHmac('sha256', key).update(v).digest('base64url');
function safeEqual(a, b) {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

// ---------- Cookie ----------
// payload: { s: storeId | null, a: true se for a agência, e: expiração }
function setSession(req, res, data) {
  const payload = Buffer.from(JSON.stringify({ s: data.s != null ? String(data.s) : null, a: !!data.a, e: Date.now() + MAX_AGE * 1000 }))
    .toString('base64url');
  const secure = req.secure || req.headers['x-forwarded-proto'] === 'https';
  // SameSite=None permite usar o painel dentro do iframe do admin da Nuvemshop (em HTTPS).
  const attrs = [`${COOKIE}=${payload}.${hmac(secret(), payload)}`, 'Path=/', 'HttpOnly', `Max-Age=${MAX_AGE}`,
    secure ? 'SameSite=None; Secure' : 'SameSite=Lax'];
  res.setHeader('Set-Cookie', attrs.join('; '));
}

function readCookie(req) {
  const raw = (req.headers.cookie || '').split(/;\s*/).find(c => c.startsWith(COOKIE + '='));
  if (!raw) return null;
  const [payload, sig] = raw.slice(COOKIE.length + 1).split('.');
  if (!payload || !sig || !safeEqual(sig, hmac(secret(), payload))) return null;
  try {
    const d = JSON.parse(Buffer.from(payload, 'base64url').toString());
    return d.e > Date.now() ? { storeId: d.s, agency: !!d.a } : null;
  } catch { return null; }
}

function clearSession(res) {
  res.setHeader('Set-Cookie', `${COOKIE}=; Path=/; Max-Age=0`);
}

// ---------- Token do Nexo (app incorporado ao admin) ----------
function verifyNexoToken(token) {
  const key = process.env.NUVEMSHOP_CLIENT_SECRET;
  if (!key || !token) return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  try {
    const header = JSON.parse(Buffer.from(parts[0], 'base64url').toString());
    if (header.alg !== 'HS256') return null;
    if (!safeEqual(parts[2], hmac(key, `${parts[0]}.${parts[1]}`))) return null;
    const p = JSON.parse(Buffer.from(parts[1], 'base64url').toString());
    if (p.exp && p.exp * 1000 < Date.now()) return null;
    const storeId = p.storeId ?? p.store_id ?? p.user_id ?? p.sub;
    return storeId != null ? { storeId: String(storeId), agency: false, embedded: true } : null;
  } catch { return null; }
}

// Quem está acessando? Token do Nexo tem prioridade sobre o cookie.
function getAuth(req) {
  const h = req.get('authorization') || '';
  if (h.startsWith('Bearer ')) return verifyNexoToken(h.slice(7));
  return readCookie(req);
}

// ---------- Login da agência ----------
function checkAgencyLogin(email, password) {
  const E = process.env.AGENCY_EMAIL, P = process.env.AGENCY_PASSWORD;
  if (!E || !P) return false;
  const ok1 = safeEqual(String(email || '').trim().toLowerCase(), E.trim().toLowerCase());
  const ok2 = safeEqual(hmac('pw', String(password || '')), hmac('pw', P));
  return ok1 && ok2;
}

// Limite simples de tentativas de login por IP (10 a cada 15 min)
const attempts = new Map();
function loginAllowed(ip) {
  const now = Date.now();
  const list = (attempts.get(ip) || []).filter(t => now - t < 15 * 60 * 1000);
  attempts.set(ip, list);
  return list.length < 10;
}
function registerFailure(ip) { attempts.set(ip, [...(attempts.get(ip) || []), Date.now()]); }

module.exports = { setSession, clearSession, getAuth, verifyNexoToken, checkAgencyLogin, loginAllowed, registerFailure, hmac };
