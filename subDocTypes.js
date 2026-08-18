// Fonte única de verdade para os tipos de documento desta app — cópia autónoma do
// docTypes.js da Gestão Documental (esta app corre isolada no Render, sem acesso às
// pastas das outras apps AURUM).

const EMPRESA_DOCS = [
  { key: 'alvara', label: 'Alvará/Certificado' },
  { key: 'apolice_at', label: 'Apólice de Seguro de Acidentes de Trabalho' },
  { key: 'recibo_at', label: 'Recibo de Seguro de Acidentes de Trabalho' },
  { key: 'apolice_rc', label: 'Apólice de Seguro de Responsabilidade Civil' },
  { key: 'recibo_rc', label: 'Recibo de Seguro de Responsabilidade Civil' },
  { key: 'registo_criminal_empresa', label: 'Registo Criminal da Empresa' },
  { key: 'registo_criminal_gerente', label: 'Registo Criminal do Gerente da Empresa' },
  { key: 'certidao_seg_social', label: 'Certidão de não Dívida à Segurança Social' },
  { key: 'certidao_financas', label: 'Certidão de não Dívida às Finanças' },
  { key: 'certidao_permanente', label: 'Certidão Permanente' },
  { key: 'declaracao_remuneracoes', label: 'Declaração de Remunerações', mensal: true },
  { key: 'comprovativo_tsu', label: 'Comprovativo de Pagamento de TSU', mensal: true },
];

const MESES_PT = ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'];

// Documentos mensais (declaração de remunerações, TSU) referem-se ao mês anterior até este
// dia do mês — o contabilista só costuma ter estes documentos prontos depois de o mês
// fechar. A partir deste dia, já se pede o do mês atual.
const DIA_TROCA_MES_DOCS_MENSAIS = 20;

// Devolve o rótulo do documento, com o mês incluído para os documentos mensais
// (ex: "Declaração de Remunerações de junho"). Os restantes documentos ficam inalterados.
function labelDocEmpresa(tipo, hoje) {
  if (!tipo.mensal) return tipo.label;
  const mesAtual = hoje.getMonth();
  const mes = hoje.getDate() >= DIA_TROCA_MES_DOCS_MENSAIS ? mesAtual : (mesAtual + 11) % 12;
  return `${tipo.label} de ${MESES_PT[mes]}`;
}

const TRABALHADOR_DOCS = [
  { key: 'cartao_cidadao', label: 'Cartão de Cidadão', obrigatorio: true },
  { key: 'aptidao_medica', label: 'Ficha de Aptidão Médica', obrigatorio: true },
  { key: 'epi', label: 'Ficha de Equipamentos de Proteção Individual', obrigatorio: true },
  { key: 'seg_social', label: 'Admissão na Segurança Social', obrigatorio: false },
];

// Documentos com data de validade — mostram aviso quando essa data se aproxima ou já passou.
const EMPRESA_DOCS_COM_VALIDADE = ['recibo_at', 'recibo_rc', 'registo_criminal_empresa', 'registo_criminal_gerente', 'certidao_seg_social', 'certidao_financas'];
const TRABALHADOR_DOCS_COM_VALIDADE = ['cartao_cidadao', 'aptidao_medica'];
const DIAS_AVISO_VALIDADE = 30;

const ALLOWED_EXTENSIONS = ['.pdf', '.png', '.jpg', '.jpeg'];
const ALLOWED_MIME_TYPES = ['application/pdf', 'image/png', 'image/jpeg'];
const MAX_FILE_SIZE_BYTES = 20 * 1024 * 1024; // 20MB

// Palavras/frases típicas de cada tipo de documento — usadas para avisar quando um ficheiro
// parece ter sido carregado no sítio errado (ex: um comprovativo de TSU em vez de um recibo
// de seguro). Baseado em documentos reais da AURUM — ver nota no plano sobre a limitação de
// não conseguir distinguir Acidentes de Trabalho de Responsabilidade Civil (ambos os recibos
// são talões "2ª via" sem o tipo de seguro escrito por extenso; só a apólice o menciona).
const PALAVRAS_CHAVE_EMPRESA_DOCS = {
  alvara: ['alvará', 'classe máxima', 'instituto da construção', 'nipc'],
  apolice_at: ['apólice', 'condições contratuais', 'acidentes de trabalho', 'tomador do seguro'],
  recibo_at: ['recibo', 'prémio', 'companhia de seguros', 'apólice'],
  apolice_rc: ['apólice', 'responsabilidade civil', 'condições contratuais', 'segurado'],
  recibo_rc: ['recibo', 'prémio', 'companhia de seguros', 'apólice'],
  registo_criminal_empresa: ['identificação criminal', 'registo criminal', 'certificado de registo'],
  registo_criminal_gerente: ['identificação criminal', 'registo criminal', 'certificado de registo'],
  certidao_seg_social: ['segurança social', 'situação contributiva', 'declaração'],
  certidao_financas: ['autoridade tributária', 'situação tributária', 'serviço de finanças', 'certidão'],
  certidao_permanente: ['certidão permanente', 'conservatória', 'registo comercial'],
  declaracao_remuneracoes: ['declaração de remunerações', 'remunerações'],
  comprovativo_tsu: ['tsu', 'taxa social única', 'comprovativo de pagamento'],
};

// Remove acentos e baixa para minúsculas — o OCR troca ou perde acentos com frequência
// ("remunerações" -> "remuneracoes"), por isso a comparação nunca deve depender deles.
function semAcentoMinusculo(s) {
  return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

function contarAcertos(textoNormalizado, palavras) {
  return palavras.reduce((n, p) => n + (textoNormalizado.includes(semAcentoMinusculo(p)) ? 1 : 0), 0);
}

// Verifica se o texto extraído de um documento bate certo com o tipo de campo onde foi
// carregado. Devolve { ok: true } quando não há motivo para duvidar (incluindo quando o
// texto não bate com o vocabulário conhecido de NENHUM tipo — preferível não avisar do que
// avisar sem certeza nenhuma), ou { ok: false, tipoSugerido } quando outro tipo bate
// claramente melhor e o tipo esperado não bateu em nada.
function classificarDocumento(texto, docKeyEsperado) {
  const textoNormalizado = semAcentoMinusculo(texto);
  const pontuacoes = Object.entries(PALAVRAS_CHAVE_EMPRESA_DOCS).map(([key, palavras]) => ({
    key,
    pontos: contarAcertos(textoNormalizado, palavras),
  }));
  const pontuacaoEsperada = (pontuacoes.find((p) => p.key === docKeyEsperado) || {}).pontos || 0;
  const melhor = pontuacoes.reduce((a, b) => (b.pontos > a.pontos ? b : a), { key: null, pontos: 0 });
  if (pontuacaoEsperada > 0) return { ok: true };
  if (melhor.pontos > 0 && melhor.key !== docKeyEsperado) return { ok: false, tipoSugerido: melhor.key };
  return { ok: true };
}

function isEmpresaDocKey(key) {
  return EMPRESA_DOCS.some((d) => d.key === key);
}

function isTrabalhadorDocKey(key) {
  return TRABALHADOR_DOCS.some((d) => d.key === key);
}

function docTrabalhadorObrigatorio(docKey) {
  const tipo = TRABALHADOR_DOCS.find((d) => d.key === docKey);
  return Boolean(tipo && tipo.obrigatorio !== false);
}

module.exports = {
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
  labelDocEmpresa,
  classificarDocumento,
};
