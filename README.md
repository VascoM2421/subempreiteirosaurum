# Portal de Subempreiteiros — AURUM

App online para os subempreiteiros da AURUM carregarem os seus próprios documentos de
compliance: os da empresa deles (alvará, seguros, certidões) e os de cada trabalhador que
trazem para as obras (Cartão de Cidadão, Ficha de Aptidão Médica, EPI, Admissão na
Segurança Social).

Diferente da Gestão Documental interna (rede local, sem login), esta app fica acessível
pela internet — por isso tem login próprio por subempreiteiro, mais um login separado de
administração para a AURUM gerir contas e rever o que foi carregado.

## Arrancar localmente

```
npm install
node server.js
```

Fica disponível em `http://localhost:3200`. Em desenvolvimento local, sem `ADMIN_PASSWORD`
definida, a app usa `admin123` como password de administração (só localmente — nunca em
produção).

Ao arrancar pela primeira vez, semeia automaticamente os 3 subempreiteiros já conhecidos da
Financeira (Fassada Profi, Invernoaxadrezado, Diego SA Fachadas) **sem credenciais** — entra
como administração e usa "Definir credenciais" para cada um antes de lhes dares o acesso.
Esta lista **não está ligada ao vivo** à app Financeira (que corre só localmente, sem login,
e nunca deve ficar exposta à internet) — se aparecer um subempreiteiro novo lá, acrescenta-o
aqui à mão pelo painel de administração.

## Deploy no Render.com (recomendado)

1. Cria uma conta em https://render.com (grátis para criar conta).
2. Cria um repositório no GitHub só com o conteúdo desta pasta `subempreiteiros-app/`.
3. No Render: **New +** → **Web Service** → liga o repositório GitHub criado.
4. Configuração do serviço:
   - **Build Command:** `npm install`
   - **Start Command:** `node server.js`
   - **Plan:** escolhe o plano **Starter** (pago, ~7 USD/mês) — o plano gratuito tem disco
     temporário e **perderias todos os documentos carregados** sempre que o serviço
     reiniciar ou fizeres um novo deploy. É o mesmo motivo pelo qual a app do Ponto usa este
     plano.
5. Em **Disks**, adiciona um disco persistente (ex: 2 GB, dá para muitos documentos) montado
   em `/opt/render/project/src/data`.
6. Em **Environment**, define:
   - `ADMIN_PASSWORD` — password forte para a administração (obrigatória; a app recusa-se a
     arrancar em produção sem ela).
   - `NODE_ENV` = `production`
7. Depois do deploy, o Render dá-te um URL tipo `https://subempreiteiros-aurum.onrender.com`,
   já com HTTPS automático — é esse o link a entregar a cada subempreiteiro, junto do
   utilizador e password que definires para eles.

## Gerir subempreiteiros

- Entra como administração no ecrã de login ("Entrar como AURUM").
- **Definir credenciais / Repor password:** escolhe um utilizador e uma password simples
  para o subempreiteiro; no primeiro acesso, ele é obrigado a trocar essa password por uma
  própria antes de poder usar a app.
- **Descarregar (.zip):** obtém tudo o que esse subempreiteiro já carregou (empresa +
  trabalhadores) numa só pasta comprimida.
- **Ativar/Desativar:** desativar impede o login sem apagar nada — usa isto em vez de
  remover, a não ser que queiras mesmo apagar os dados desse subempreiteiro.
- A coluna "Em falta" mostra, para cada subempreiteiro, que documentos da empresa ou de que
  trabalhadores ainda faltam carregar.

## Notas de segurança

- Sessões guardadas em memória — reiniciar o servidor termina todas as sessões (login outra
  vez é rápido e sem impacto nos dados, que ficam persistidos em `data/`).
- Passwords guardadas com hash (`scrypt` + salt), nunca em texto simples.
- Proteção contra tentativas de login em série (bloqueio temporário por IP ao fim de várias
  falhas).
