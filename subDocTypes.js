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
  { key: 'declaracao_remuneracoes', label: 'Declaração de Remunerações' },
  { key: 'comprovativo_tsu', label: 'Comprovativo de Pagamento de TSU' },
];

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
};
