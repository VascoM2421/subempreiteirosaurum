const express = require('express');
const multer = require('multer');
const { ZipArchive } = require('archiver');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const {
  EMPRESA_DOCS,
  TRABALHADOR_DOCS,
  EMPRESA_DOCS_COM_VALIDADE,
  TRABALHADOR_DOCS_COM_VALIDADE,
  DIAS_AVISO_VALIDADE,
  ALLOWED_EXTENSIONS,
  ALLOWED_MIME_TYPES,
  MAX_FILE_SIZE_BYTES,
  isEmpresaDocKey,
  isTrabalhadorDocKey,
  docTrabalhadorObrigatorio,
} = require('./subDocTypes');

const EM_PRODUCAO = process.env.NODE_ENV === 'production';
const PORT = process.env.PORT || 3200;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const SUBS_DIR = path.join(DATA_DIR, 'subempreiteiros');
const DB_PATH = path.join(DATA_DIR, 'db.json');

// ---------- Password de administração (AURUM) ----------
// Obrigatória em produção — a app recusa-se a arrancar sem ela, para nunca ficar
// acessível com uma password conhecida (mesmo padrão do ponto-app).
let ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
if (!ADMIN_PASSWORD) {
  if (EM_PRODUCAO) {
    console.error('ERRO FATAL: ADMIN_PASSWORD nao esta definida em producao. A app nao vai arrancar por seguranca. Define a variavel de ambiente ADMIN_PASSWORD no Render.');
    process.exit(1);
  }
  ADMIN_PASSWORD = 'admin123';
  console.warn('AVISO (dev): ADMIN_PASSWORD nao definida — a usar "admin123" apenas em desenvolvimento local.');
}

function compararSegredo(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

// ---------- Passwords por subempreiteiro (scrypt + salt) ----------
function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return { salt, hash };
}
function verifyPassword(password, salt, hash) {
  const tentativa = crypto.scryptSync(password, salt, 64).toString('hex');
  const a = Buffer.from(tentativa, 'hex');
  const b = Buffer.from(hash, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// ---------- Protecao contra forca-bruta nos logins (em memoria, por IP) ----------
const LOGIN_JANELA_MS = 15 * 60 * 1000;
const LOGIN_MAX_TENTATIVAS = 8;
const LOGIN_BLOQUEIO_MS = 15 * 60 * 1000;
const tentativasLogin = new Map();

function ipDoPedido(req) {
  return req.ip || (req.connection && req.connection.remoteAddress) || 'desconhecido';
}
function limitarLogin(req, res, next) {
  const ip = ipDoPedido(req);
  const agora = Date.now();
  const reg = tentativasLogin.get(ip);
  if (reg && reg.bloqueadoAte > agora) {
    const segundos = Math.ceil((reg.bloqueadoAte - agora) / 1000);
    res.setHeader('Retry-After', String(segundos));
    return res.status(429).json({ erro: `Demasiadas tentativas falhadas. Tenta novamente dentro de ${Math.ceil(segundos / 60)} minuto(s).` });
  }
  req._ipLogin = ip;
  next();
}
function registarFalhaLogin(req) {
  const ip = req._ipLogin || ipDoPedido(req);
  const agora = Date.now();
  let reg = tentativasLogin.get(ip);
  if (!reg || (agora - reg.janelaInicio) > LOGIN_JANELA_MS) {
    reg = { falhas: 0, janelaInicio: agora, bloqueadoAte: 0 };
  }
  reg.falhas += 1;
  if (reg.falhas >= LOGIN_MAX_TENTATIVAS) reg.bloqueadoAte = agora + LOGIN_BLOQUEIO_MS;
  tentativasLogin.set(ip, reg);
}
function limparFalhasLogin(req) {
  tentativasLogin.delete(req._ipLogin || ipDoPedido(req));
}

// ---------- Sessões (em memória — reinício do servidor termina todas as sessões) ----------
const SESSAO_DURACAO_MS = 30 * 24 * 60 * 60 * 1000; // 30 dias
const sessoes = new Map();
function criarSessao(dados) {
  const token = crypto.randomBytes(32).toString('hex');
  sessoes.set(token, { ...dados, expiraEm: Date.now() + SESSAO_DURACAO_MS });
  return token;
}
function obterSessao(token) {
  if (!token) return null;
  const sessao = sessoes.get(token);
  if (!sessao) return null;
  if (sessao.expiraEm < Date.now()) { sessoes.delete(token); return null; }
  return sessao;
}
function destruirSessao(token) {
  if (token) sessoes.delete(token);
}

function parseCookies(req) {
  const header = req.headers.cookie;
  const cookies = {};
  if (!header) return cookies;
  header.split(';').forEach((parte) => {
    const idx = parte.indexOf('=');
    if (idx === -1) return;
    const nome = parte.slice(0, idx).trim();
    const valor = parte.slice(idx + 1).trim();
    cookies[nome] = decodeURIComponent(valor);
  });
  return cookies;
}
function definirCookie(res, nome, valor, opcoes = {}) {
  const partes = [`${nome}=${encodeURIComponent(valor)}`, 'Path=/', 'HttpOnly', 'SameSite=Lax'];
  if (EM_PRODUCAO) partes.push('Secure');
  if (opcoes.maxAgeMs) partes.push(`Max-Age=${Math.floor(opcoes.maxAgeMs / 1000)}`);
  if (opcoes.apagar) partes.push('Max-Age=0');
  const anteriores = res.getHeader('Set-Cookie');
  const lista = anteriores ? (Array.isArray(anteriores) ? anteriores : [anteriores]) : [];
  lista.push(partes.join('; '));
  res.setHeader('Set-Cookie', lista);
}

const COOKIE_SUB = 'sub_sessao';
const COOKIE_ADMIN = 'sub_admin_sessao';

function exigirSubempreiteiro(req, res, next) {
  const cookies = parseCookies(req);
  const sessao = obterSessao(cookies[COOKIE_SUB]);
  if (!sessao || sessao.tipo !== 'subempreiteiro') return res.status(401).json({ erro: 'Sessão inválida. Inicia sessão novamente.' });
  const db = readDb();
  const sub = db.subempreiteiros[sessao.subempreiteiroId];
  if (!sub || !sub.ativo) return res.status(401).json({ erro: 'Conta inválida ou desativada. Contacta a AURUM.' });
  req.subempreiteiroId = sessao.subempreiteiroId;
  next();
}
function exigirAdmin(req, res, next) {
  const cookies = parseCookies(req);
  const sessao = obterSessao(cookies[COOKIE_ADMIN]);
  if (!sessao || sessao.tipo !== 'admin') return res.status(401).json({ erro: 'Sessão de administração inválida.' });
  next();
}

// ---------- Base de dados (data/db.json) ----------
function ensureDirs() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.mkdirSync(SUBS_DIR, { recursive: true });
}
function readDb() {
  if (!fs.existsSync(DB_PATH)) writeDb({ subempreiteiros: {} });
  const db = JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
  db.subempreiteiros ||= {};
  return db;
}
function writeDb(db) {
  fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2));
}

ensureDirs();

// Semear os subempreiteiros já conhecidos da Financeira, só se ainda não existirem.
// Sem credenciais por omissão — a administração define username/password no painel de
// admin antes de os entregar. Isto NÃO liga ao vivo à Financeira (que corre só local,
// sem login) — é só um ponto de partida; novos subempreiteiros acrescentam-se à mão.
const SEED_SUBEMPREITEIROS = ['Fassada Profi', 'Invernoaxadrezado', 'Diego SA Fachadas'];
(function seedSubempreiteiros() {
  const db = readDb();
  let alterado = false;
  for (const nome of SEED_SUBEMPREITEIROS) {
    if (Object.values(db.subempreiteiros).some((s) => s.nome === nome)) continue;
    const id = crypto.randomUUID();
    db.subempreiteiros[id] = {
      id, nome, username: null, salt: null, passwordHash: null,
      passwordAlterada: false, ativo: true, criadoEm: new Date().toISOString(),
      docs: {}, trabalhadores: [],
    };
    alterado = true;
  }
  if (alterado) writeDb(db);
})();

// ---------- Upload de ficheiros ----------
function fileFilter(req, file, cb) {
  const ext = path.extname(file.originalname).toLowerCase();
  if (!ALLOWED_EXTENSIONS.includes(ext) || !ALLOWED_MIME_TYPES.includes(file.mimetype)) {
    cb(new Error('Tipo de ficheiro não permitido. Usa PDF, PNG ou JPG.'));
    return;
  }
  cb(null, true);
}
function makeUpload(destinationFn, filenameFn) {
  return multer({
    storage: multer.diskStorage({
      destination: (req, file, cb) => {
        try {
          const dir = destinationFn(req);
          fs.mkdirSync(dir, { recursive: true });
          cb(null, dir);
        } catch (err) {
          cb(err);
        }
      },
      filename: (req, file, cb) => {
        const ext = path.extname(file.originalname).toLowerCase();
        cb(null, `${filenameFn(req)}${ext}`);
      },
    }),
    fileFilter,
    limits: { fileSize: MAX_FILE_SIZE_BYTES },
  });
}
function assignFileId(req, res, next) {
  req.fileId = crypto.randomUUID();
  next();
}
function handleMulterError(err, res) {
  if (err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE') {
    return res.status(400).json({ erro: 'Ficheiro demasiado grande (máximo 20MB).' });
  }
  return res.status(400).json({ erro: err.message || 'Falha no upload.' });
}
function ficheiroPath(pastaFicheiros, docKey, fileId, ext) {
  return path.join(pastaFicheiros, `${docKey}__${fileId}${ext}`);
}
function empresaDir(subId) {
  return path.join(SUBS_DIR, subId, 'empresa');
}
function trabalhadorDir(subId, trabId) {
  return path.join(SUBS_DIR, subId, 'trabalhadores', trabId);
}

function enviarFicheiro(req, res, filePath, filename) {
  const tipo = req.query.inline === '1' ? 'inline' : 'attachment';
  const asciiSeguro = filename.replace(/[^\x20-\x7E]/g, '_');
  const utf8Codificado = encodeURIComponent(filename);
  res.setHeader('Content-Disposition', `${tipo}; filename="${asciiSeguro}"; filename*=UTF-8''${utf8Codificado}`);
  res.sendFile(filePath, (err) => {
    if (err && !res.headersSent) res.status(404).json({ erro: 'Ficheiro não encontrado.' });
  });
}

function validarDataValidade(valor) {
  if (valor === null || valor === undefined || valor === '') return null;
  if (typeof valor !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(valor)) return undefined;
  const ano = Number(valor.slice(0, 4));
  if (ano < 1900 || ano > 2200) return undefined;
  return valor;
}

function docPreenchido(docs, docKey) {
  return Boolean(docs && docs[docKey] && docs[docKey].length > 0);
}

// ---------- App ----------
const app = express();
app.set('trust proxy', 1);
app.use(express.json());

app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'same-origin');
  if (EM_PRODUCAO) res.setHeader('Strict-Transport-Security', 'max-age=15552000; includeSubDomains');
  next();
});

// ---------- Login / sessão (subempreiteiro) ----------
app.post('/api/login', limitarLogin, (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ erro: 'Indica utilizador e password.' });
  const db = readDb();
  const entrada = Object.entries(db.subempreiteiros).find(
    ([, s]) => s.username && s.username.toLowerCase() === String(username).toLowerCase(),
  );
  if (!entrada) { registarFalhaLogin(req); return res.status(401).json({ erro: 'Utilizador ou password inválidos.' }); }
  const [id, sub] = entrada;
  if (!sub.ativo) return res.status(401).json({ erro: 'Conta desativada. Contacta a AURUM.' });
  if (!verifyPassword(password, sub.salt, sub.passwordHash)) {
    registarFalhaLogin(req);
    return res.status(401).json({ erro: 'Utilizador ou password inválidos.' });
  }
  limparFalhasLogin(req);
  const token = criarSessao({ tipo: 'subempreiteiro', subempreiteiroId: id });
  definirCookie(res, COOKIE_SUB, token, { maxAgeMs: SESSAO_DURACAO_MS });
  res.json({ ok: true, nome: sub.nome });
});

app.post('/api/logout', (req, res) => {
  const cookies = parseCookies(req);
  destruirSessao(cookies[COOKIE_SUB]);
  definirCookie(res, COOKIE_SUB, '', { apagar: true });
  res.json({ ok: true });
});

app.get('/api/eu', exigirSubempreiteiro, (req, res) => {
  const db = readDb();
  const sub = db.subempreiteiros[req.subempreiteiroId];
  res.json({ nome: sub.nome, passwordAlterada: Boolean(sub.passwordAlterada), docs: sub.docs || {} });
});

app.post('/api/alterar-password', exigirSubempreiteiro, (req, res) => {
  const db = readDb();
  const sub = db.subempreiteiros[req.subempreiteiroId];
  const { passwordAtual, passwordNova } = req.body || {};
  if (!passwordAtual || !passwordNova) return res.status(400).json({ erro: 'Indica a password atual e a nova.' });
  if (!verifyPassword(String(passwordAtual), sub.salt, sub.passwordHash)) {
    return res.status(401).json({ erro: 'A password atual está incorreta.' });
  }
  if (String(passwordNova).length < 6) return res.status(400).json({ erro: 'A nova password deve ter pelo menos 6 caracteres.' });
  const { salt, hash } = hashPassword(String(passwordNova));
  sub.passwordHash = hash;
  sub.salt = salt;
  sub.passwordAlterada = true;
  writeDb(db);
  res.json({ ok: true });
});

// ---------- Login / sessão (admin AURUM) ----------
app.post('/api/admin/login', limitarLogin, (req, res) => {
  const { password } = req.body || {};
  if (!password || !compararSegredo(String(password), ADMIN_PASSWORD)) {
    registarFalhaLogin(req);
    return res.status(401).json({ erro: 'Password incorreta.' });
  }
  limparFalhasLogin(req);
  const token = criarSessao({ tipo: 'admin' });
  definirCookie(res, COOKIE_ADMIN, token, { maxAgeMs: SESSAO_DURACAO_MS });
  res.json({ ok: true });
});

app.post('/api/admin/logout', (req, res) => {
  const cookies = parseCookies(req);
  destruirSessao(cookies[COOKIE_ADMIN]);
  definirCookie(res, COOKIE_ADMIN, '', { apagar: true });
  res.json({ ok: true });
});

app.get('/api/admin/eu', exigirAdmin, (_req, res) => res.json({ ok: true }));

// ---------- Config (tipos de documento) ----------
app.get('/api/config', (_req, res) => {
  res.json({
    empresaDocs: EMPRESA_DOCS,
    trabalhadorDocs: TRABALHADOR_DOCS,
    empresaDocsComValidade: EMPRESA_DOCS_COM_VALIDADE,
    trabalhadorDocsComValidade: TRABALHADOR_DOCS_COM_VALIDADE,
    diasAvisoValidade: DIAS_AVISO_VALIDADE,
  });
});

// ================= DOCUMENTOS DA EMPRESA (subempreiteiro autenticado) =================

const uploadEmpresaNovo = makeUpload(
  (req) => empresaDir(req.subempreiteiroId),
  (req) => `${req.params.docKey}__${req.fileId}`,
);
const uploadEmpresaSubstituir = makeUpload(
  (req) => empresaDir(req.subempreiteiroId),
  (req) => `${req.params.docKey}__${req.params.fileId}`,
);

app.post('/api/docs/:docKey', exigirSubempreiteiro, assignFileId, (req, res) => {
  const { docKey } = req.params;
  if (!isEmpresaDocKey(docKey)) return res.status(400).json({ erro: 'Tipo de documento inválido.' });
  uploadEmpresaNovo.single('file')(req, res, (err) => {
    if (err) return handleMulterError(err, res);
    if (!req.file) return res.status(400).json({ erro: 'Nenhum ficheiro enviado.' });
    const db = readDb();
    const sub = db.subempreiteiros[req.subempreiteiroId];
    if (!Array.isArray(sub.docs[docKey])) sub.docs[docKey] = [];
    const entrada = { id: req.fileId, originalName: req.file.originalname, ext: path.extname(req.file.originalname).toLowerCase(), uploadedAt: new Date().toISOString() };
    sub.docs[docKey].push(entrada);
    writeDb(db);
    res.status(201).json({ ok: true, doc: entrada });
  });
});

app.post('/api/docs/:docKey/:fileId', exigirSubempreiteiro, (req, res) => {
  const { docKey, fileId } = req.params;
  const db = readDb();
  const sub = db.subempreiteiros[req.subempreiteiroId];
  const lista = sub.docs[docKey] || [];
  const entradaAntiga = lista.find((f) => f.id === fileId);
  if (!entradaAntiga) return res.status(404).json({ erro: 'Documento não encontrado.' });
  uploadEmpresaSubstituir.single('file')(req, res, (err) => {
    if (err) return handleMulterError(err, res);
    if (!req.file) return res.status(400).json({ erro: 'Nenhum ficheiro enviado.' });
    const db2 = readDb();
    const lista2 = db2.subempreiteiros[req.subempreiteiroId].docs[docKey];
    const idx = lista2.findIndex((f) => f.id === fileId);
    const novaExt = path.extname(req.file.originalname).toLowerCase();
    if (entradaAntiga.ext !== novaExt) fs.rm(ficheiroPath(empresaDir(req.subempreiteiroId), docKey, fileId, entradaAntiga.ext), { force: true }, () => {});
    lista2[idx] = { id: fileId, originalName: req.file.originalname, ext: novaExt, uploadedAt: new Date().toISOString() };
    writeDb(db2);
    res.json({ ok: true, doc: lista2[idx] });
  });
});

app.get('/api/docs/:docKey/:fileId', exigirSubempreiteiro, (req, res) => {
  const { docKey, fileId } = req.params;
  const db = readDb();
  const sub = db.subempreiteiros[req.subempreiteiroId];
  const entrada = (sub.docs[docKey] || []).find((f) => f.id === fileId);
  if (!entrada) return res.status(404).json({ erro: 'Documento não encontrado.' });
  enviarFicheiro(req, res, ficheiroPath(empresaDir(req.subempreiteiroId), docKey, fileId, entrada.ext), `${docKey}${entrada.ext}`);
});

app.patch('/api/docs/:docKey/:fileId/validade', exigirSubempreiteiro, (req, res) => {
  const { docKey, fileId } = req.params;
  const db = readDb();
  const sub = db.subempreiteiros[req.subempreiteiroId];
  const entrada = (sub.docs[docKey] || []).find((f) => f.id === fileId);
  if (!entrada) return res.status(404).json({ erro: 'Documento não encontrado.' });
  const valor = validarDataValidade(req.body && req.body.dataValidade);
  if (valor === undefined) return res.status(400).json({ erro: 'Data inválida.' });
  entrada.dataValidade = valor;
  writeDb(db);
  res.json({ ok: true, doc: entrada });
});

app.delete('/api/docs/:docKey/:fileId', exigirSubempreiteiro, (req, res) => {
  const { docKey, fileId } = req.params;
  const db = readDb();
  const sub = db.subempreiteiros[req.subempreiteiroId];
  const lista = sub.docs[docKey] || [];
  const idx = lista.findIndex((f) => f.id === fileId);
  if (idx === -1) return res.status(404).json({ erro: 'Documento não encontrado.' });
  const entrada = lista[idx];
  fs.rm(ficheiroPath(empresaDir(req.subempreiteiroId), docKey, fileId, entrada.ext), { force: true }, () => {});
  lista.splice(idx, 1);
  writeDb(db);
  res.json({ ok: true });
});

// ================= TRABALHADORES (do subempreiteiro autenticado) =================

app.get('/api/trabalhadores', exigirSubempreiteiro, (req, res) => {
  const db = readDb();
  res.json(db.subempreiteiros[req.subempreiteiroId].trabalhadores || []);
});

app.post('/api/trabalhadores', exigirSubempreiteiro, (req, res) => {
  const nome = (req.body && req.body.nome ? String(req.body.nome) : '').trim();
  if (!nome) return res.status(400).json({ erro: 'O nome do trabalhador é obrigatório.' });
  const db = readDb();
  const sub = db.subempreiteiros[req.subempreiteiroId];
  const trabalhador = { id: crypto.randomUUID(), nome, docs: {}, criadoEm: new Date().toISOString() };
  sub.trabalhadores.push(trabalhador);
  writeDb(db);
  res.status(201).json(trabalhador);
});

app.patch('/api/trabalhadores/:tid', exigirSubempreiteiro, (req, res) => {
  const db = readDb();
  const trab = (db.subempreiteiros[req.subempreiteiroId].trabalhadores || []).find((t) => t.id === req.params.tid);
  if (!trab) return res.status(404).json({ erro: 'Trabalhador não encontrado.' });
  const nome = (req.body && req.body.nome ? String(req.body.nome) : '').trim();
  if (!nome) return res.status(400).json({ erro: 'O nome não pode ficar vazio.' });
  trab.nome = nome;
  writeDb(db);
  res.json(trab);
});

app.delete('/api/trabalhadores/:tid', exigirSubempreiteiro, (req, res) => {
  const db = readDb();
  const sub = db.subempreiteiros[req.subempreiteiroId];
  const antes = sub.trabalhadores.length;
  sub.trabalhadores = sub.trabalhadores.filter((t) => t.id !== req.params.tid);
  if (sub.trabalhadores.length === antes) return res.status(404).json({ erro: 'Trabalhador não encontrado.' });
  writeDb(db);
  fs.rm(trabalhadorDir(req.subempreiteiroId, req.params.tid), { recursive: true, force: true }, () => {});
  res.json({ ok: true });
});

// ---- documentos de um trabalhador ----

const uploadTrabalhadorNovo = makeUpload(
  (req) => trabalhadorDir(req.subempreiteiroId, req.params.tid),
  (req) => `${req.params.docKey}__${req.fileId}`,
);
const uploadTrabalhadorSubstituir = makeUpload(
  (req) => trabalhadorDir(req.subempreiteiroId, req.params.tid),
  (req) => `${req.params.docKey}__${req.params.fileId}`,
);

function encontrarTrabalhador(db, subId, tid) {
  const sub = db.subempreiteiros[subId];
  return sub && (sub.trabalhadores || []).find((t) => t.id === tid);
}

app.post('/api/trabalhadores/:tid/docs/:docKey', exigirSubempreiteiro, assignFileId, (req, res) => {
  const { tid, docKey } = req.params;
  if (!isTrabalhadorDocKey(docKey)) return res.status(400).json({ erro: 'Tipo de documento inválido.' });
  if (!encontrarTrabalhador(readDb(), req.subempreiteiroId, tid)) return res.status(404).json({ erro: 'Trabalhador não encontrado.' });
  uploadTrabalhadorNovo.single('file')(req, res, (err) => {
    if (err) return handleMulterError(err, res);
    if (!req.file) return res.status(400).json({ erro: 'Nenhum ficheiro enviado.' });
    const db = readDb();
    const trab = encontrarTrabalhador(db, req.subempreiteiroId, tid);
    if (!Array.isArray(trab.docs[docKey])) trab.docs[docKey] = [];
    const entrada = { id: req.fileId, originalName: req.file.originalname, ext: path.extname(req.file.originalname).toLowerCase(), uploadedAt: new Date().toISOString() };
    trab.docs[docKey].push(entrada);
    writeDb(db);
    res.status(201).json({ ok: true, doc: entrada });
  });
});

app.post('/api/trabalhadores/:tid/docs/:docKey/:fileId', exigirSubempreiteiro, (req, res) => {
  const { tid, docKey, fileId } = req.params;
  const db = readDb();
  const trab = encontrarTrabalhador(db, req.subempreiteiroId, tid);
  if (!trab) return res.status(404).json({ erro: 'Trabalhador não encontrado.' });
  const entradaAntiga = (trab.docs[docKey] || []).find((f) => f.id === fileId);
  if (!entradaAntiga) return res.status(404).json({ erro: 'Documento não encontrado.' });
  uploadTrabalhadorSubstituir.single('file')(req, res, (err) => {
    if (err) return handleMulterError(err, res);
    if (!req.file) return res.status(400).json({ erro: 'Nenhum ficheiro enviado.' });
    const db2 = readDb();
    const trab2 = encontrarTrabalhador(db2, req.subempreiteiroId, tid);
    const lista2 = trab2.docs[docKey];
    const idx = lista2.findIndex((f) => f.id === fileId);
    const novaExt = path.extname(req.file.originalname).toLowerCase();
    if (entradaAntiga.ext !== novaExt) fs.rm(ficheiroPath(trabalhadorDir(req.subempreiteiroId, tid), docKey, fileId, entradaAntiga.ext), { force: true }, () => {});
    lista2[idx] = { id: fileId, originalName: req.file.originalname, ext: novaExt, uploadedAt: new Date().toISOString() };
    writeDb(db2);
    res.json({ ok: true, doc: lista2[idx] });
  });
});

app.get('/api/trabalhadores/:tid/docs/:docKey/:fileId', exigirSubempreiteiro, (req, res) => {
  const { tid, docKey, fileId } = req.params;
  const trab = encontrarTrabalhador(readDb(), req.subempreiteiroId, tid);
  const entrada = trab && (trab.docs[docKey] || []).find((f) => f.id === fileId);
  if (!entrada) return res.status(404).json({ erro: 'Documento não encontrado.' });
  enviarFicheiro(req, res, ficheiroPath(trabalhadorDir(req.subempreiteiroId, tid), docKey, fileId, entrada.ext), `${docKey}${entrada.ext}`);
});

app.patch('/api/trabalhadores/:tid/docs/:docKey/:fileId/validade', exigirSubempreiteiro, (req, res) => {
  const { tid, docKey, fileId } = req.params;
  const db = readDb();
  const trab = encontrarTrabalhador(db, req.subempreiteiroId, tid);
  const entrada = trab && (trab.docs[docKey] || []).find((f) => f.id === fileId);
  if (!entrada) return res.status(404).json({ erro: 'Documento não encontrado.' });
  const valor = validarDataValidade(req.body && req.body.dataValidade);
  if (valor === undefined) return res.status(400).json({ erro: 'Data inválida.' });
  entrada.dataValidade = valor;
  writeDb(db);
  res.json({ ok: true, doc: entrada });
});

app.delete('/api/trabalhadores/:tid/docs/:docKey/:fileId', exigirSubempreiteiro, (req, res) => {
  const { tid, docKey, fileId } = req.params;
  const db = readDb();
  const trab = encontrarTrabalhador(db, req.subempreiteiroId, tid);
  if (!trab) return res.status(404).json({ erro: 'Trabalhador não encontrado.' });
  const lista = trab.docs[docKey] || [];
  const idx = lista.findIndex((f) => f.id === fileId);
  if (idx === -1) return res.status(404).json({ erro: 'Documento não encontrado.' });
  const entrada = lista[idx];
  fs.rm(ficheiroPath(trabalhadorDir(req.subempreiteiroId, tid), docKey, fileId, entrada.ext), { force: true }, () => {});
  lista.splice(idx, 1);
  writeDb(db);
  res.json({ ok: true });
});

// ================= ADMIN (AURUM) =================

function resumoFaltas(sub) {
  const faltamEmpresa = EMPRESA_DOCS.filter((d) => !docPreenchido(sub.docs, d.key)).map((d) => d.label);
  const trabalhadoresComFalta = (sub.trabalhadores || [])
    .map((t) => ({
      nome: t.nome,
      faltam: TRABALHADOR_DOCS.filter((d) => docTrabalhadorObrigatorio(d.key) && !docPreenchido(t.docs, d.key)).map((d) => d.label),
    }))
    .filter((t) => t.faltam.length > 0);
  return { faltamEmpresa, trabalhadoresComFalta };
}

app.get('/api/admin/subempreiteiros', exigirAdmin, (_req, res) => {
  const db = readDb();
  const lista = Object.values(db.subempreiteiros).map((sub) => ({
    id: sub.id,
    nome: sub.nome,
    username: sub.username,
    temCredenciais: Boolean(sub.username && sub.passwordHash),
    passwordAlterada: Boolean(sub.passwordAlterada),
    ativo: sub.ativo,
    numTrabalhadores: (sub.trabalhadores || []).length,
    ...resumoFaltas(sub),
  }));
  res.json(lista);
});

app.post('/api/admin/subempreiteiros', exigirAdmin, (req, res) => {
  const nome = (req.body && req.body.nome ? String(req.body.nome) : '').trim();
  if (!nome) return res.status(400).json({ erro: 'O nome é obrigatório.' });
  const db = readDb();
  const id = crypto.randomUUID();
  db.subempreiteiros[id] = {
    id, nome, username: null, salt: null, passwordHash: null,
    passwordAlterada: false, ativo: true, criadoEm: new Date().toISOString(),
    docs: {}, trabalhadores: [],
  };
  writeDb(db);
  res.status(201).json(db.subempreiteiros[id]);
});

app.post('/api/admin/subempreiteiros/:id/credenciais', exigirAdmin, (req, res) => {
  const db = readDb();
  const sub = db.subempreiteiros[req.params.id];
  if (!sub) return res.status(404).json({ erro: 'Subempreiteiro não encontrado.' });
  const username = (req.body && req.body.username ? String(req.body.username) : '').trim();
  const password = req.body && req.body.password ? String(req.body.password) : '';
  if (!username) return res.status(400).json({ erro: 'O utilizador é obrigatório.' });
  if (password.length < 6) return res.status(400).json({ erro: 'A password deve ter pelo menos 6 caracteres.' });
  const emUsoPorOutro = Object.entries(db.subempreiteiros).some(
    ([id, s]) => id !== req.params.id && s.username && s.username.toLowerCase() === username.toLowerCase(),
  );
  if (emUsoPorOutro) return res.status(400).json({ erro: 'Já existe outro subempreiteiro com esse utilizador.' });
  const { salt, hash } = hashPassword(password);
  sub.username = username;
  sub.salt = salt;
  sub.passwordHash = hash;
  sub.passwordAlterada = false; // força a definir uma password própria no próximo login
  writeDb(db);
  res.json({ ok: true, username, password });
});

app.patch('/api/admin/subempreiteiros/:id', exigirAdmin, (req, res) => {
  const db = readDb();
  const sub = db.subempreiteiros[req.params.id];
  if (!sub) return res.status(404).json({ erro: 'Subempreiteiro não encontrado.' });
  if (req.body && req.body.nome !== undefined) {
    const nome = String(req.body.nome).trim();
    if (!nome) return res.status(400).json({ erro: 'O nome não pode ficar vazio.' });
    sub.nome = nome;
  }
  if (req.body && req.body.ativo !== undefined) sub.ativo = Boolean(req.body.ativo);
  writeDb(db);
  res.json(sub);
});

app.delete('/api/admin/subempreiteiros/:id', exigirAdmin, (req, res) => {
  const db = readDb();
  if (!db.subempreiteiros[req.params.id]) return res.status(404).json({ erro: 'Subempreiteiro não encontrado.' });
  delete db.subempreiteiros[req.params.id];
  writeDb(db);
  fs.rm(path.join(SUBS_DIR, req.params.id), { recursive: true, force: true }, () => {});
  res.json({ ok: true });
});

app.get('/api/admin/subempreiteiros/:id/export', exigirAdmin, (req, res) => {
  const db = readDb();
  const sub = db.subempreiteiros[req.params.id];
  if (!sub) return res.status(404).json({ erro: 'Subempreiteiro não encontrado.' });
  const pasta = String(sub.nome).replace(/[\\/:*?"<>|]/g, '').trim() || 'subempreiteiro';
  res.attachment(`${pasta}.zip`);
  const archive = new ZipArchive({ zlib: { level: 9 } });
  archive.on('error', (err) => res.status(500).end(String(err)));
  archive.pipe(res);

  for (const [docKey, lista] of Object.entries(sub.docs)) {
    (lista || []).forEach((doc, idx) => {
      const filePath = ficheiroPath(empresaDir(sub.id), docKey, doc.id, doc.ext);
      if (fs.existsSync(filePath)) {
        const nome = lista.length > 1 ? `${docKey}_${idx + 1}${doc.ext}` : `${docKey}${doc.ext}`;
        archive.file(filePath, { name: `${pasta}/empresa/${nome}` });
      }
    });
  }
  for (const trab of sub.trabalhadores || []) {
    const pastaTrab = String(trab.nome).replace(/[\\/:*?"<>|]/g, '').trim() || 'trabalhador';
    for (const [docKey, lista] of Object.entries(trab.docs || {})) {
      (lista || []).forEach((doc, idx) => {
        const filePath = ficheiroPath(trabalhadorDir(sub.id, trab.id), docKey, doc.id, doc.ext);
        if (fs.existsSync(filePath)) {
          const nome = lista.length > 1 ? `${docKey}_${idx + 1}${doc.ext}` : `${docKey}${doc.ext}`;
          archive.file(filePath, { name: `${pasta}/trabalhadores/${pastaTrab}/${nome}` });
        }
      });
    }
  }
  archive.finalize();
});

// ---------- Frontend estático ----------
app.use(express.static(path.join(__dirname, 'public')));
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api/')) return next();
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`\n  Portal de Subempreiteiros a correr em http://localhost:${PORT}\n`);
});
