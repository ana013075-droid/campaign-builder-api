require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { OAuth2Client } = require('google-auth-library');
const axios = require('axios');

const app = express();
app.use(express.json());
app.use(cors({ origin: '*' }));

// ─── Config ───────────────────────────────────────────────────────────────────
const CLIENT_ID     = process.env.CLIENT_ID;
const CLIENT_SECRET = process.env.CLIENT_SECRET;
const DEV_TOKEN     = process.env.DEVELOPER_TOKEN;
const REDIRECT_URI  = process.env.REDIRECT_URI || 'https://campaign-builder-api.railway.app/oauth/callback';
const ADS_API_VER   = 'v19';

// Token store in-memory (por conta: customer_id → tokens)
const tokenStore = {};
let pendingTokens = null; // tokens recém-obtidos, aguardando associação

// ─── OAuth2 ───────────────────────────────────────────────────────────────────
function makeOAuth2Client() {
  return new OAuth2Client(CLIENT_ID, CLIENT_SECRET, REDIRECT_URI);
}

// GET /oauth/url — retorna URL de autorização
app.get('/oauth/url', (req, res) => {
  const client = makeOAuth2Client();
  const url = client.generateAuthUrl({
    access_type: 'offline',
    scope: ['https://www.googleapis.com/auth/adwords'],
    prompt: 'consent'
  });
  res.json({ url });
});

// GET /oauth/callback — recebe o code do Google e troca por tokens
app.get('/oauth/callback', async (req, res) => {
  try {
    const { code } = req.query;
    if (!code) return res.status(400).send('Code ausente');

    const client = makeOAuth2Client();
    const { tokens } = await client.getToken(code);
    pendingTokens = tokens;

    // Fecha a janela e notifica o app principal
    res.send(`
      <html><body style="background:#1a1a2e;color:#00ff88;font-family:sans-serif;text-align:center;padding-top:80px">
        <h2>✅ Autorização concluída!</h2>
        <p>Pode fechar esta janela e voltar ao Campaign Builder.</p>
        <script>
          if(window.opener) { window.opener.postMessage('oauth_success','*'); window.close(); }
        </script>
      </body></html>
    `);
  } catch (err) {
    console.error('OAuth callback error:', err);
    res.status(500).send('Erro na autorização: ' + err.message);
  }
});

// POST /oauth/tokens — app busca os tokens após callback
app.post('/oauth/tokens', (req, res) => {
  if (!pendingTokens) return res.status(404).json({ error: 'Nenhum token pendente' });
  const t = pendingTokens;
  pendingTokens = null;
  res.json(t);
});

// POST /oauth/save — salva tokens para um customer_id específico
app.post('/oauth/save', (req, res) => {
  const { customer_id, tokens } = req.body;
  if (!customer_id || !tokens) return res.status(400).json({ error: 'customer_id e tokens são obrigatórios' });
  tokenStore[customer_id] = tokens;
  res.json({ ok: true });
});

// ─── Helpers Google Ads API ───────────────────────────────────────────────────
async function getAccessToken(customer_id) {
  const tokens = tokenStore[customer_id];
  if (!tokens) throw new Error(`Conta ${customer_id} não autorizada. Faça OAuth primeiro.`);

  const client = makeOAuth2Client();
  client.setCredentials(tokens);

  // Renova se expirado
  if (tokens.expiry_date && Date.now() > tokens.expiry_date - 60000) {
    const { credentials } = await client.refreshAccessToken();
    tokenStore[customer_id] = credentials;
    return credentials.access_token;
  }
  return tokens.access_token;
}

function adsHeaders(accessToken, mccId) {
  const h = {
    'Authorization': `Bearer ${accessToken}`,
    'developer-token': DEV_TOKEN,
    'Content-Type': 'application/json'
  };
  if (mccId) h['login-customer-id'] = mccId.replace(/-/g, '');
  return h;
}

async function adsPost(path, body, customerId, mccId) {
  const cid = customerId.replace(/-/g, '');
  const token = await getAccessToken(customerId);
  const url = `https://googleads.googleapis.com/${ADS_API_VER}/customers/${cid}${path}`;
  const resp = await axios.post(url, body, { headers: adsHeaders(token, mccId) });
  return resp.data;
}

// ─── Scrape + Gerar Copy com IA ──────────────────────────────────────────────
app.post('/campaigns/scrape-and-generate', async (req, res) => {
  try {
    const { url, plataforma, pais, idioma, language } = req.body;

    if (!process.env.ANTHROPIC_API_KEY) {
      return res.status(500).json({ error: 'ANTHROPIC_API_KEY não configurada. Adicione nas variáveis de ambiente do Render.' });
    }
    if (!url) return res.status(400).json({ error: 'URL da landing page é obrigatória.' });

    // ── 1. Scrape da página ──────────────────────────────────────────────────
    let pageText = '';
    try {
      const pageResp = await axios.get(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'pt-BR,pt;q=0.9,en;q=0.8',
          'Accept-Encoding': 'gzip, deflate, br'
        },
        timeout: 20000,
        maxRedirects: 5
      });

      // Extrai texto limpo do HTML
      pageText = pageResp.data
        .replace(/<script[\s\S]*?<\/script>/gi, ' ')
        .replace(/<style[\s\S]*?<\/style>/gi, ' ')
        .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
        .replace(/<!--[\s\S]*?-->/g, ' ')
        .replace(/<[^>]+>/g, ' ')
        .replace(/\s+/g, ' ')
        .replace(/&nbsp;/g, ' ')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .trim()
        .slice(0, 8000); // Máximo 8000 chars para a IA

    } catch(scrapeErr) {
      console.error('Erro ao fazer scrape:', scrapeErr.message);
      pageText = `Erro ao acessar a página: ${scrapeErr.message}. URL fornecida: ${url}`;
    }

    // ── 2. Gerar copy com Claude ─────────────────────────────────────────────
    const langCode = language || idioma; // 'language' vem como 'en','pt','es' — 'idioma' como 'English','Portuguese','Spanish'
    const langInstr = langCode === 'en' ? 'in English' : langCode === 'es' ? 'en español' : 'em português brasileiro';

    const prompt = `Você é um especialista em copywriting para Google Ads com 10 anos de experiência criando campanhas de altíssima conversão para afiliados no Brasil.

Analise o conteúdo desta landing page e crie uma copy COMPLETA, PODEROSA e CONGRUENTE com a página.

CONTEÚDO DA PÁGINA (URL: ${url}):
---
${pageText}
---

CONTEXTO:
- Plataforma: ${plataforma || 'não informada'}
- País: ${pais || 'Brasil'}
- Idioma: ${idioma || 'Português'} — toda a copy deve ser ${langInstr}

REGRAS ABSOLUTAS DE LIMITE DE CARACTERES (o Google REJEITA automaticamente se ultrapassar):
- Headlines: EXATAMENTE 15 textos · MÁXIMO 30 caracteres CADA (incluindo espaços e pontuação)
- Descriptions: EXATAMENTE 4 textos · MÁXIMO 90 caracteres CADA
- Callouts: até 10 textos · MÁXIMO 25 caracteres CADA
- Sitelinks: até 6 · campo "text" MÁXIMO 25 chars · "desc1" e "desc2" MÁXIMO 35 chars CADA

ESTRATÉGIA DE COPY — use estes ângulos nas headlines:
1. Benefício principal do produto
2. Dor/problema que resolve
3. Urgência ou escassez (se houver na página)
4. Desconto ou promoção (se houver na página — extraia o valor exato)
5. Bônus (se mencionado na página)
6. Garantia (se houver)
7. Prova social / depoimentos (se houver)
8. Pergunta direta ao público
9. CTA direto (Comece Agora, Acesse Aqui, etc.)
10. Número/estatística (se houver na página)

SITELINKS — crie baseados no conteúdo real da página:
- Seções como: Sobre, Depoimentos, Garantia, Bônus, Módulos, etc.
- URL: use "/" se não souber a URL específica

PALAVRAS-CHAVE — sugira 15 palavras-chave que o público buscaria para encontrar este produto.

IMPORTANTE:
- Extraia informações REAIS da página (preços, descontos, bônus, garantia)
- NÃO invente informações que não estão na página
- NÃO use ponto final nos headlines
- Capitalize as palavras importantes
- Headlines curtas e impactantes — cada char conta

Responda APENAS com JSON válido, sem markdown, sem explicação:
{
  "produto": "nome exato do produto identificado na página",
  "headlines": ["h1","h2","h3","h4","h5","h6","h7","h8","h9","h10","h11","h12","h13","h14","h15"],
  "descriptions": ["d1","d2","d3","d4"],
  "callouts": ["c1","c2","c3","c4","c5","c6","c7","c8","c9","c10"],
  "sitelinks": [
    {"text":"Texto","desc1":"Descrição linha 1","desc2":"Descrição linha 2","url":"/"},
    {"text":"Texto","desc1":"Descrição linha 1","desc2":"Descrição linha 2","url":"/"},
    {"text":"Texto","desc1":"Descrição linha 1","desc2":"Descrição linha 2","url":"/"},
    {"text":"Texto","desc1":"Descrição linha 1","desc2":"Descrição linha 2","url":"/"}
  ],
  "keywords": ["kw1","kw2","kw3","kw4","kw5","kw6","kw7","kw8","kw9","kw10","kw11","kw12","kw13","kw14","kw15"]
}`;

    const aiResp = await axios.post('https://api.anthropic.com/v1/messages', {
      model: 'claude-3-haiku-20240307',
      max_tokens: 2000,
      messages: [{ role: 'user', content: prompt }]
    }, {
      headers: {
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json'
      }
    });

    const rawText = aiResp.data.content[0].text.trim();
    const jsonMatch = rawText.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error('Resposta da IA não contém JSON válido');

    const copy = JSON.parse(jsonMatch[0]);

    // Garantia de limites (Google rejeita se passar)
    copy.headlines    = (copy.headlines    || []).slice(0, 15).map(h => String(h).slice(0, 30));
    copy.descriptions = (copy.descriptions || []).slice(0,  4).map(d => String(d).slice(0, 90));
    copy.callouts     = (copy.callouts     || []).slice(0, 10).map(c => String(c).slice(0, 25));
    copy.sitelinks    = (copy.sitelinks    || []).slice(0,  6).map(sl => ({
      text:  String(sl.text  || '').slice(0, 25),
      desc1: String(sl.desc1 || '').slice(0, 35),
      desc2: String(sl.desc2 || '').slice(0, 35),
      url:   sl.url || '/'
    }));
    copy.keywords = (copy.keywords || []).slice(0, 15).map(k => String(k));

    res.json(copy);
  } catch (err) {
    console.error('Erro scrape+generate:', err.response?.data || err.message);
    res.status(500).json({ error: 'Erro ao processar: ' + err.message, details: err.response?.data });
  }
});

// ─── Criar Campanha ───────────────────────────────────────────────────────────
app.post('/campaigns/create', async (req, res) => {
  try {
    const {
      customer_id,   // ex: "603-234-0235"
      mcc_id,        // ex: "603-234-0235" (MCC pai)
      name,
      budget_micros, // 250 BRL = 250000000
      bidding_strategy, // "TARGET_CPA" | "MAXIMIZE_CLICKS"
      target_cpa_micros,// só se TARGET_CPA
      start_date,    // "YYYYMMDD"
      end_date,      // opcional
      // Ad group e anúncios
      headlines,     // array de strings (até 15)
      descriptions,  // array de strings (até 4)
      keywords,      // array de { text, match_type }
      sitelinks,     // array de { text, final_url, desc1, desc2 }
      callouts,      // array de strings
      final_url
    } = req.body;

    const cid = customer_id.replace(/-/g, '');

    // 1. Criar orçamento
    const budgetRes = await adsPost('/campaignBudgets:mutate', {
      operations: [{
        create: {
          name: `${name} - Budget`,
          amountMicros: String(budget_micros || 250000000),
          deliveryMethod: 'STANDARD'
        }
      }]
    }, customer_id, mcc_id);
    const budgetRN = budgetRes.results[0].resourceName;

    // 2. Criar campanha
    const campaignBody = {
      name,
      status: 'PAUSED',
      advertisingChannelType: 'SEARCH',
      campaignBudget: budgetRN,
      networkSettings: {
        targetGoogleSearch: true,
        targetSearchNetwork: false,
        targetContentNetwork: false,
        targetPartnerSearchNetwork: false
      },
      startDate: start_date || formatDate(new Date()),
    };

    if (bidding_strategy === 'TARGET_CPA') {
      campaignBody.targetCpa = { targetCpaMicros: String(target_cpa_micros) };
    } else {
      campaignBody.maximizeClicks = {};
    }
    if (end_date) campaignBody.endDate = end_date;

    const campRes = await adsPost('/campaigns:mutate', {
      operations: [{ create: campaignBody }]
    }, customer_id, mcc_id);
    const campRN = campRes.results[0].resourceName;

    // 3. Criar Ad Group
    const agRes = await adsPost('/adGroups:mutate', {
      operations: [{
        create: {
          campaign: campRN,
          name: `${name} - Grupo 1`,
          status: 'ENABLED',
          type: 'SEARCH_STANDARD'
        }
      }]
    }, customer_id, mcc_id);
    const agRN = agRes.results[0].resourceName;

    // 4. Criar anúncio responsivo de pesquisa
    const headlineAssets = headlines.slice(0, 15).map(h => ({ text: h.slice(0, 30) }));
    const descAssets = descriptions.slice(0, 4).map(d => ({ text: d.slice(0, 90) }));

    await adsPost('/adGroupAds:mutate', {
      operations: [{
        create: {
          adGroup: agRN,
          status: 'ENABLED',
          ad: {
            responsiveSearchAd: {
              headlines: headlineAssets,
              descriptions: descAssets
            },
            finalUrls: [final_url]
          }
        }
      }]
    }, customer_id, mcc_id);

    // 5. Criar keywords
    if (keywords && keywords.length > 0) {
      const kwOps = keywords.slice(0, 20).map(kw => ({
        create: {
          adGroup: agRN,
          status: 'ENABLED',
          keyword: {
            text: kw.text,
            matchType: kw.match_type || 'BROAD'
          }
        }
      }));
      await adsPost('/adGroupCriteria:mutate', { operations: kwOps }, customer_id, mcc_id);
    }

    // 6. Sitelinks
    if (sitelinks && sitelinks.length > 0) {
      const slOps = sitelinks.slice(0, 6).map(sl => ({
        create: {
          campaign: campRN,
          extensionType: 'SITELINK',
          sitelinkFeedItem: {
            linkText: sl.text.slice(0, 25),
            finalUrls: [sl.final_url],
            description1: (sl.desc1 || '').slice(0, 35),
            description2: (sl.desc2 || '').slice(0, 35)
          }
        }
      }));
      await adsPost('/campaignExtensionSettings:mutate', {
        operations: [{ create: {
          campaign: campRN,
          extensionType: 'SITELINK',
          extensionFeedItems: [] // será preenchido após criar os assets
        }}]
      }, customer_id, mcc_id).catch(() => {}); // ignora se não suportado
    }

    // 7. Callouts
    if (callouts && callouts.length > 0) {
      const calloutAssets = callouts.slice(0, 10).map(c => ({
        create: {
          calloutAsset: { calloutText: c.slice(0, 25) }
        }
      }));
      const assetRes = await adsPost('/assets:mutate', { operations: calloutAssets }, customer_id, mcc_id).catch(() => null);

      if (assetRes) {
        const assetRNs = assetRes.results.map(r => r.resourceName);
        await adsPost('/campaignAssets:mutate', {
          operations: assetRNs.map(rn => ({
            create: {
              campaign: campRN,
              asset: rn,
              fieldType: 'CALLOUT'
            }
          }))
        }, customer_id, mcc_id).catch(() => {});
      }
    }

    res.json({
      ok: true,
      campaign: campRN,
      ad_group: agRN,
      message: `Campanha "${name}" criada com sucesso (status: PAUSADA para revisão)`
    });

  } catch (err) {
    console.error('Erro ao criar campanha:', err.response?.data || err.message);
    res.status(500).json({
      error: err.message,
      details: err.response?.data
    });
  }
});

// ─── Listar contas acessíveis ─────────────────────────────────────────────────
app.get('/accounts/:customer_id', async (req, res) => {
  try {
    const { customer_id } = req.params;
    const token = await getAccessToken(customer_id);
    const cid = customer_id.replace(/-/g, '');
    const resp = await axios.get(
      `https://googleads.googleapis.com/${ADS_API_VER}/customers/${cid}/googleAds:searchStream`,
      {
        method: 'POST',
        headers: adsHeaders(token)
      }
    );
    res.json(resp.data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /health
app.get('/health', (req, res) => res.json({ status: 'ok', version: ADS_API_VER }));

// ─── Utils ────────────────────────────────────────────────────────────────────
function formatDate(d) {
  return d.toISOString().slice(0, 10).replace(/-/g, '');
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Campaign Builder API rodando na porta ${PORT}`));
