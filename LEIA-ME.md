# Radar Brasil — como colocar no ar (GitHub Pages)

Site gratuito, que se atualiza sozinho e não usa o seu plano do Claude.

- **Câmbio** (dólar, euro, libra): ao vivo, direto no navegador de quem abre a página (AwesomeAPI).
- **Ibovespa, Selic, IPCA, dívida pública e notícias**: um robô do GitHub (GitHub Actions) busca tudo a cada ~20 minutos e salva em `data/data.json`.
- **Notícias**: manchetes copiadas direto dos canais oficiais (Senado, Câmara, TSE, IBGE, Banco Central, Planalto e Fazenda), sem reescrita.

## O que tem na pasta

| Arquivo | Para que serve |
|---|---|
| `index.html` | A página |
| `data/data.json` | Os dados que a página mostra (o robô reescreve) |
| `scripts/update.mjs` | O robô que busca os dados |
| `.github/workflows/atualizar.yml` | Diz ao GitHub para rodar o robô a cada 20 min |

## Passo a passo (uns 15 minutos)

### 1. Contas
1. Crie uma conta grátis em **github.com** (se ainda não tiver).
2. Crie uma conta grátis em **brapi.dev**, entre no painel (Dashboard) e copie a sua **chave de API**. Ela é usada só para o Ibovespa.

### 2. Criar o repositório
1. No GitHub, clique em **+** (canto superior direito) → **New repository**.
2. Nome: `radar-brasil`. Marque **Public** (é o que deixa o Pages e o robô de graça).
3. Clique em **Create repository**.

### 3. Enviar os arquivos
1. Na página do repositório novo, clique em **uploading an existing file** (ou **Add file → Upload files**).
2. Abra a pasta `Documentos\radar-brasil` no Windows, selecione **tudo o que está dentro dela** (inclusive a pasta `.github`) e arraste para a janela do navegador.
3. Clique em **Commit changes**.
4. Confira se aparece a pasta `.github/workflows/atualizar.yml`. Se ela não subiu:
   **Add file → Create new file**, digite o nome `.github/workflows/atualizar.yml`, cole o conteúdo do arquivo e clique em **Commit changes**.

### 4. Guardar a chave da brapi (segredo)
1. No repositório: **Settings → Secrets and variables → Actions → New repository secret**.
2. Name: `BRAPI_TOKEN` · Secret: cole a chave da brapi → **Add secret**.

A chave fica escondida; ninguém que abrir o site consegue ver.

### 5. Deixar o robô salvar os dados
**Settings → Actions → General → Workflow permissions** → marque **Read and write permissions** → **Save**.

### 6. Ligar o site
**Settings → Pages → Build and deployment → Source: Deploy from a branch** → Branch: `main`, pasta `/ (root)` → **Save**.

Depois de 1 ou 2 minutos o endereço aparece no topo dessa página:
`https://SEU-USUARIO.github.io/radar-brasil/`

É esse link que você manda para as pessoas.

### 7. Rodar o robô pela primeira vez
1. Aba **Actions** → se pedir, clique em **I understand my workflows, go ahead and enable them**.
2. Clique em **Atualizar dados → Run workflow → Run workflow**.
3. Em ~1 minuto fica verde. Abra o site: os dados de exemplo são trocados pelos reais.

Daí em diante ele roda sozinho a cada ~20 minutos (o GitHub às vezes atrasa alguns minutos).

## Se algo não aparecer

- No rodapé do site há **"Fontes com falha na última atualização"**: mostra quais fontes não responderam.
- O log completo fica em **Actions → Atualizar dados → (última execução) → Buscar dados**. Linhas com `FALHOU` mostram a fonte e o erro.
- **Feed de notícias que mudou de endereço:** abra `scripts/update.mjs` no GitHub (ícone de lápis), corrija a URL na lista `FEEDS` no topo do arquivo e salve. Dá para adicionar ou tirar fontes ali também.
- **"segredo BRAPI_TOKEN não configurado":** refaça o passo 4 com o nome exatamente `BRAPI_TOKEN`.
- **Erro de permissão ao salvar (push):** refaça o passo 5.
- **O robô parou depois de muito tempo:** o GitHub pode desligar tarefas agendadas em repositórios parados. Vá em **Actions → Atualizar dados** e clique em **Enable workflow**.

## Manutenção (raramente)

- **Impostômetro:** a ACSP não tem API. Quando sair um novo marco (ex.: "Impostômetro chega a R$ 4 trilhões"), edite `TAX` no topo de `scripts/update.mjs` com a data e o valor. Em janeiro, troque o ano e os marcos.
- Os contadores de dívida e Impostômetro são estimativas a partir do último dado oficial, e o site diz isso.

## Custo

Zero: GitHub Pages e GitHub Actions são gratuitos para repositórios públicos; AwesomeAPI, brapi (plano grátis) e a API do Banco Central também.
