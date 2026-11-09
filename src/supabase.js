// Acesso ao Supabase sem bibliotecas: chamadas HTTP às funções do banco (RPC) e ao Storage.
//
// A chave SECRETA fica só no servidor (variável de ambiente). Ela nunca vai para o navegador.
'use strict';

const URL_SUPABASE = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
const CHAVE = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const BUCKET = 'fotos';

class ErroHttp extends Error {
  constructor(status, msg) { super(msg); this.status = status; }
}

// Confere as variáveis de ambiente SEM revelar seus valores. Devolve a lista de problemas (vazia = ok).
function problemasDeConfiguracao() {
  const p = [];
  if (!URL_SUPABASE) p.push('Falta a variável SUPABASE_URL.');
  else if (!/^https:\/\/[a-z0-9-]+\.supabase\.co$/.test(URL_SUPABASE) && !/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(URL_SUPABASE)) {
    p.push('SUPABASE_URL em formato inesperado. Use só o endereço do projeto, ex.: https://abcdxyz.supabase.co (sem /rest/v1 no final).');
  }
  if (!CHAVE) p.push('Falta a variável SUPABASE_SECRET_KEY.');
  else if (CHAVE.startsWith('sb_publishable_')) p.push('SUPABASE_SECRET_KEY contém a chave PÚBLICA (sb_publishable_). Use a chave secreta (sb_secret_).');
  else if (CHAVE.startsWith('eyJ') && papelDoJwt(CHAVE) === 'anon') p.push('SUPABASE_SECRET_KEY contém a chave "anon". Use a chave secreta (sb_secret_) ou a service_role.');
  else if (/\s/.test(CHAVE)) p.push('SUPABASE_SECRET_KEY tem espaços ou quebra de linha. Copie a chave de novo, sem espaços.');
  return p;
}
function papelDoJwt(jwt) {
  try { return JSON.parse(Buffer.from(jwt.split('.')[1], 'base64url').toString()).role; } catch { return null; }
}

function cabecalhos(extra = {}) {
  const problemas = problemasDeConfiguracao();
  if (problemas.length) {
    console.error('[configuração] ' + problemas.join(' '));
    throw new ErroHttp(503, 'O sistema ainda não está configurado. Veja /api/saude.');
  }
  const h = { apikey: CHAVE, ...extra };
  // Chaves antigas (service_role, formato JWT "eyJ...") também vão no Authorization.
  if (CHAVE.startsWith('eyJ')) h.Authorization = `Bearer ${CHAVE}`;
  return h;
}

// Explica em português o que costuma estar errado quando o Supabase recusa a chamada.
function motivoDaFalha(status, codigo, mensagem) {
  if (status === 401 || status === 403 || codigo === '42501') return 'O Supabase recusou a chave. Confira se SUPABASE_SECRET_KEY é a chave SECRETA deste projeto.';
  if (codigo === 'PGRST202' || codigo === '42883' || (status === 404 && /function/i.test(mensagem))) return 'As funções do banco não existem. Rode o arquivo supabase/schema.sql no SQL Editor do Supabase.';
  if (codigo === 'PGRST002' || status === 503) return 'O Supabase está indisponível ou o projeto está pausado. Abra o painel do Supabase e clique em "Resume project", se for o caso.';
  return `Resposta inesperada do Supabase (HTTP ${status} ${codigo}).`;
}

// Chama uma função "api_*" do banco. Erros de regra de negócio viram ErroHttp com a mensagem do banco.
async function rpc(funcao, p = {}) {
  let resp;
  try {
    resp = await fetch(`${URL_SUPABASE}/rest/v1/rpc/${funcao}`, {
      method: 'POST',
      headers: cabecalhos({ 'Content-Type': 'application/json', Accept: 'application/json' }),
      body: JSON.stringify({ p }),
      signal: AbortSignal.timeout(10_000),
    });
  } catch (e) {
    if (e instanceof ErroHttp) throw e;
    const motivo = `Não consegui conectar em ${URL_SUPABASE} (${e.cause?.code || e.name}: ${e.cause?.message || e.message}). Confira SUPABASE_URL.`;
    console.error(`[supabase] ${funcao}: ${motivo}`);
    throw Object.assign(new ErroHttp(503, 'Não foi possível acessar o banco de dados agora. Tente novamente.'), { motivo });
  }
  const texto = await resp.text();
  let dados = null;
  try { dados = texto ? JSON.parse(texto) : null; } catch { /* resposta não-JSON */ }
  if (resp.ok) return dados;

  const codigo = dados?.code || '';
  if (/^PT\d{3}$/.test(codigo)) throw new ErroHttp(Number(codigo.slice(2)), dados.message);
  if (codigo === 'P0001') throw new ErroHttp(400, dados.message);
  const motivo = motivoDaFalha(resp.status, codigo, dados?.message || texto);
  console.error(`[supabase] ${funcao} falhou: HTTP ${resp.status} ${codigo} ${dados?.message || texto.slice(0, 200)} → ${motivo}`);
  throw Object.assign(new ErroHttp(503, 'Não foi possível acessar o banco de dados agora. Tente novamente.'), { motivo });
}

// ---------- Storage (fotos) ----------
const urlPublica = (caminho) => `${URL_SUPABASE}/storage/v1/object/public/${BUCKET}/${caminho}`;
const prefixoPublico = () => `${URL_SUPABASE}/storage/v1/object/public/${BUCKET}/`;

async function enviarFoto(caminho, buffer, tipo) {
  const resp = await fetch(`${URL_SUPABASE}/storage/v1/object/${BUCKET}/${caminho}`, {
    method: 'POST',
    headers: cabecalhos({ 'Content-Type': tipo, 'Cache-Control': 'max-age=31536000', 'x-upsert': 'false' }),
    body: buffer,
    signal: AbortSignal.timeout(20_000),
  });
  if (!resp.ok) {
    console.error('[supabase] envio de foto falhou:', resp.status, (await resp.text()).slice(0, 200));
    throw new ErroHttp(502, 'Não foi possível salvar a foto agora. Tente novamente.');
  }
  return urlPublica(caminho);
}

// Apaga uma foto que NÓS enviamos (ignora a logo padrão e endereços de outros lugares).
async function apagarFoto(url) {
  if (!url || !url.startsWith(prefixoPublico())) return;
  const caminho = url.slice(prefixoPublico().length);
  try {
    await fetch(`${URL_SUPABASE}/storage/v1/object/${BUCKET}`, {
      method: 'DELETE',
      headers: cabecalhos({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ prefixes: [caminho] }),
      signal: AbortSignal.timeout(10_000),
    });
  } catch (e) { console.error('[supabase] não apagou foto antiga:', e.message); }
}

module.exports = { rpc, enviarFoto, apagarFoto, prefixoPublico, problemasDeConfiguracao, ErroHttp, URL_SUPABASE };
