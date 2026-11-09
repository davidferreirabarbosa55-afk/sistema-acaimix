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

function cabecalhos(extra = {}) {
  if (!URL_SUPABASE || !CHAVE) throw new Error('Configure SUPABASE_URL e SUPABASE_SECRET_KEY nas variáveis de ambiente.');
  const h = { apikey: CHAVE, ...extra };
  // Chaves antigas (service_role, formato JWT "eyJ...") também vão no Authorization.
  if (CHAVE.startsWith('eyJ')) h.Authorization = `Bearer ${CHAVE}`;
  return h;
}

// Chama uma função "api_*" do banco. Erros de regra de negócio viram ErroHttp com a mensagem do banco.
async function rpc(funcao, p = {}) {
  const resp = await fetch(`${URL_SUPABASE}/rest/v1/rpc/${funcao}`, {
    method: 'POST',
    headers: cabecalhos({ 'Content-Type': 'application/json', Accept: 'application/json' }),
    body: JSON.stringify({ p }),
    signal: AbortSignal.timeout(10_000),
  });
  const texto = await resp.text();
  let dados = null;
  try { dados = texto ? JSON.parse(texto) : null; } catch { /* resposta não-JSON */ }
  if (resp.ok) return dados;

  const codigo = dados?.code || '';
  if (/^PT\d{3}$/.test(codigo)) throw new ErroHttp(Number(codigo.slice(2)), dados.message);
  if (codigo === 'P0001') throw new ErroHttp(400, dados.message);
  console.error(`[supabase] ${funcao} falhou: HTTP ${resp.status} ${codigo} ${dados?.message || texto.slice(0, 200)}`);
  throw new ErroHttp(503, 'Não foi possível acessar o banco de dados agora. Tente novamente.');
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

module.exports = { rpc, enviarFoto, apagarFoto, prefixoPublico, ErroHttp, URL_SUPABASE };
