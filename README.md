# Compre o Conjunto (app Nuvemshop)

O app coloca um bloco **"Compre o conjunto"** na página de produto da loja. Nele o cliente vê as outras peças do look, escolhe cor e tamanho de cada uma, confere o total e coloca tudo no carrinho com um clique.

## O que tem

| Parte | O que faz |
|---|---|
| **Painel** (`/admin`) | Criar, editar, pausar e excluir conjuntos (de 2 a 8 peças, com busca de produtos da loja). Também muda o texto e as cores do botão e o que acontece depois de adicionar (ir para o carrinho ou continuar na página). |
| **Script da vitrine** (`/widget.js`) | Mostra o bloco nas páginas dos produtos que fazem parte de um conjunto ativo. Esconde variações esgotadas, mostra o preço promocional e obriga a escolher o tamanho. |
| **API** | Faz a instalação via OAuth, guarda os conjuntos em SQLite, recebe os webhooks de desinstalação e LGPD e responde à vitrine com um cache de 2 minutos. |

Precisa de Node 22.13 ou mais novo. A única dependência é o Express. O banco é o SQLite que já vem com o Node.

---

## Passo a passo para colocar no ar

### 1. Criar o app no Portal de Parceiros
1. Crie uma conta em **partners.nuvemshop.com.br** (é gratuita).
2. Vá em **Criar aplicativo** e escolha **para uma loja específica** (app privado). Assim não precisa passar pela homologação da loja de apps.
3. Em **Permissões**, marque **Produtos: leitura** e **Scripts: edição**.
4. Anote o **App ID** e o **Client Secret**.
5. Deixe a **URL de redirecionamento** em branco por enquanto. Ela é preenchida no passo 3.

### 2. Hospedar o app (exemplo com o Railway)
1. Suba esta pasta para um repositório no GitHub.
2. No **railway.app**, crie um projeto com **New Project → Deploy from GitHub**.
3. Adicione um **Volume** montado em `/data` (é onde o banco fica salvo).
4. Em **Variables**, preencha as variáveis com base no `.env.example`:
   - `NUVEMSHOP_APP_ID`, `NUVEMSHOP_CLIENT_SECRET` e `NUVEMSHOP_USER_AGENT`
   - `APP_URL` = o domínio que o Railway gerar (ex.: `https://compre-o-conjunto.up.railway.app`)
   - `SESSION_SECRET` = qualquer texto longo e aleatório
   - `NODE_ENV=production` e `DATABASE_FILE=/data/app.db`
5. Abra `APP_URL/health`. A resposta deve ser `{"ok":true}`.

Render, Fly.io ou uma VPS também servem, desde que o disco seja persistente.

### 3. Ligar o app à Nuvemshop
No Portal de Parceiros, dentro do app:
1. **URL de redirecionamento:** `https://SEU-APP/auth/callback`
2. **Webhooks de LGPD** (são obrigatórios). Preencha os três com:
   - `https://SEU-APP/webhooks/store/redact`
   - `https://SEU-APP/webhooks/customers/redact`
   - `https://SEU-APP/webhooks/customers/data_request`
3. Em **Scripts → Criar script**:
   - Baixe o arquivo em `https://SEU-APP/widget.js`. Ele já sai com a URL do seu app dentro.
   - Faça o upload desse arquivo.
   - **Local:** loja (store). **Evento:** `onload`. Marque **Instalação automática**.
   - Publique a versão.

### 4. Instalar na loja da cliente
1. No Portal de Parceiros, use o link de instalação do app (ou abra `https://www.nuvemshop.com.br/apps/APP_ID/authorize`) com o login da loja.
2. Aceite as permissões. Você cai no painel do app.
3. Crie o primeiro conjunto e abra a página de um dos produtos na loja.

Depois, para voltar ao painel, é só abrir o app em **Meus aplicativos**, no admin da Nuvemshop.

---

## Onde o bloco aparece
Por padrão, o bloco entra logo abaixo do formulário de compra (`#product_form` / `.js-product-form`), que existe em todos os temas oficiais.

Para colocar em outro lugar, edite o tema (**Layout → Editar código**) e cole `<div id="compre-o-conjunto"></div>` onde quiser. O bloco passa a aparecer dentro dessa div.

## Como o "adicionar tudo ao carrinho" funciona
Para cada peça, o script abre a página do produto em segundo plano e lê o formulário de compra do próprio tema. Ele preenche a cor e o tamanho escolhidos e envia para `/comprar/`, do mesmo jeito que o botão normal da loja faz. Por isso funciona em qualquer tema e respeita o estoque e as regras da loja.

> **Teste antes de divulgar:** temas muito customizados podem ter o formulário diferente. Teste na loja real com um produto de cada tipo: com cor e tamanho, só com tamanho e sem variação. Se alguma peça falhar, o bloco mostra qual foi, e o motivo aparece no console do navegador (F12) com o prefixo `[Compre o Conjunto]`.

## Atualizar preço, estoque e fotos
Os dados dos produtos ficam em cache por 2 minutos. Para atualizar na hora, use **Aparência → Atualizar dados dos produtos**.

## Rodar no computador (desenvolvimento)
```bash
npm install
npm test                        # testes automatizados (usam uma Nuvemshop simulada)

# simulação completa, sem loja real:
node test/mock-nuvemshop.js     # vitrine falsa em http://localhost:4000
NUVEMSHOP_API_BASE=http://localhost:4000 DEV_STORE_ID=123 DEV_ACCESS_TOKEN=tok-123 npm run dev
# painel: http://localhost:3000/dev/login   ·   vitrine: http://localhost:4000/produtos/calca/
```

## Estrutura
```
src/server.js       rotas (OAuth, painel, API pública, webhooks, widget.js)
src/nuvemshop.js    cliente da API Nuvemshop + cache de produtos
src/db.js           SQLite (lojas, conjuntos, configurações)
src/session.js      login do painel (cookie assinado)
public/admin.html   painel
widget/widget.js    script da vitrine
test/               testes e Nuvemshop simulada
```
