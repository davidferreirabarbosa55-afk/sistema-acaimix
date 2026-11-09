// Função da Vercel: recebe todas as chamadas /api/* (veja "rewrites" no vercel.json).
//
// Rede de segurança: se o código não carregar (arquivo faltando, erro de sintaxe, variável estranha),
// em vez de a Vercel mostrar só "FUNCTION_INVOCATION_FAILED", respondemos um erro claro e
// escrevemos o motivo no log (Vercel › seu projeto › Logs).
'use strict';

let tratar = null;
let erroAoCarregar = null;
try {
  ({ tratar } = require('../src/rotas'));
} catch (e) {
  erroAoCarregar = e;
  console.error('[inicialização] o código da API não carregou:', e);
}

// Erros que escapariam de qualquer try/catch vão para o log em vez de derrubar o processo em silêncio.
process.on('unhandledRejection', (e) => console.error('[promessa sem tratamento]', e));

module.exports = async (req, res) => {
  if (erroAoCarregar) {
    res.statusCode = 500;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    return res.end(JSON.stringify({ erro: 'A API não iniciou. Veja os Logs da Vercel.', detalhe: String(erroAoCarregar.message || erroAoCarregar) }));
  }
  return tratar(req, res);
};
