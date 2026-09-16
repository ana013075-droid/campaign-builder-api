require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { OAuth2Client } = require('google-auth-library');
const axios = require('axios');

const app = express();
app.use(express.json());
app.use(cors({ origin: '*' }));

const CLIENT_ID     = process.env.CLIENT_ID;
const CLIENT_SECRET = process.env.CLIENT_SECRET;
const DEV_TOKEN     = process.env.DEVELOPER_TOKEN;
const REDIRECT_URI  = process.env.REDIRECT_URI || 'https://campaign-builder-api.onrender.com/oauth/callback';
const ADS_API_VER   = 'v19';

const tokenStore = {};
let pendingTokens = null;

function makeOAuth2Client() {
  return new OAuth2Client(CLIENT_ID, CLIENT_SECRET, REDIRECT_URI);
}

app.get('/oauth/url', (req, res) => {
  const client = makeOAuth2Client();
  const url = client.generateAuthUrl({
    access_type: 'offline',
    scope: ['https://www.googleapis.com/auth/adwords'],
    prompt: 'consent'
  });
  res.json({ url });
});

app.get('/oauth/callback', async (req, res) => {
  try {
    const { code } = req.query;
    if (!code) return res.status(400).send('Code ausente');
    const client = makeOAuth2Client();
    const { tokens } = await client.getToken(code);
    pendingTokens = tokens;
    res.send(`<html><body style="background:#1a1a2e;color:#00ff88;font-family:sans-serif;text-align:center;padding-top:80px"><h2>✅ Autorização concluída!</h2><p>Pode fechar esta janela.</p><script>if(window.opener){window.opener.postMessage('oauth_success','*');window.close();}</script></body></html>`);
  } catch (err) {
    res.status(500).send('Erro: ' + err.message);
  }
});

app.post('/oauth/tokens', (req, res) => {
  if (!pendingTokens) return res.status(404).json({ error: 'Nenhum token pendente' });
  const t = pendingTokens;
  pendingTokens = null;
  res.json(t);
});

app.post('/oauth/save', (req, res) => {
  const { customer_id, tokens } = req.body;
  if (!customer_id || !tokens) return res.status(400).json({ error: 'customer_id e tokens são obrigatórios' });
  tokenStore[customer_id] = tokens;
  res.json({ ok: true });
});

async function getAccessToken(customer_id) {
  const tokens = tokenStore[customer_id];
  if (!tokens) throw new Error(`Conta ${customer_id} não autorizada.`);
  const client = makeOAuth2Client();
  client.setCredentials(tokens);
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

app.post('/campaigns/scrape-and-generate', async (req, res) => {
  try {
    const { url, plataforma, pais, idioma } = req.body;
    if (!process.env.ANTHROPIC_API_KEY) return res.status(500).json({ error: 'ANTHROPIC_API_KEY não configurada.' });
    if (!url) return res.status(400).json({ error: 'URL é obrigatória.' });

    let pageText = '';
    try {
      const pageResp = await axios.get(url, {
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36', 'Accept-Language': 'pt-BR,pt;q=0.9' },
        timeout: 20000, maxRedirects: 5
      });
      pageText = pageResp.data
        .replace(/<script[\s\S]*?<\/script>/gi, ' ')
        .replace(/<style[\s\S]*?<\/style>/gi, ' ')
        .replace(/<[^>]+>/g, ' ')
        .replace(/\s+/g, ' ')
        .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
        .trim().slice(0, 8000);
    } catch(e) { pageText = `Erro ao acessar: ${e.message}`; }

    const langInstr = idioma === 'en' ? 'in English' : idioma === 'es' ? 'en español' : 'em português brasileiro';
    const prompt = `Você é especialista em copywriting para Google Ads com 10 anos de experiência criando campanhas de alta conversão para afiliados.

Analise esta landing page e crie copy COMPLETA e CONGRUENTE com a página.

CONTEÚDO DA PÁGINA (URL: ${url}):
---
${pageText}
---

CONTEXTO: Plataforma: ${plataforma||'não informada'} | País: ${pais||'Brasil'} | Idioma: ${idioma||'Português'} — escreva ${langInstr}

LIMITES ABSOLUTOS (Google rejeita se ultrapassar):
- Headlines: EXATAMENTE 15 textos · MÁXIMO 30 caracteres CADA
- Descriptions: EXATAMENTE 4 textos · MÁXIMO 90 caracteres CADA
- Callouts: até 10 textos · MÁXIMO 25 caracteres CADA
- Sitelinks: até 6 · text MÁXIMO 25 chars · desc1 e desc2 MÁXIMO 35 chars CADA

Use ângulos: benefício principal, dor que resolve, urgência/escassez, desconto (valor exato se houver), bônus, garantia, prova social, pergunta ao público, CTA direto, números/estatísticas.

Extraia informações REAIS da página. NÃO invente. NÃO use ponto final nos headlines.

Sugira 15 palavras-chave que o público buscaria.

Responda APENAS JSON válido sem markdown:
{"produto":"nome do produto","headlines":["h1","h2","h3","h4","h5","h6","h7","h8","h9","h10","h11","h12","h13","h14","h15"],"descriptions":["d1","d2","d3","d4"],"callouts":["c1","c2","c3","c4","c5","c6","c7","c8","c9","c10"],"sitelinks":[{"text":"Texto","desc1":"Desc 1","desc2":"Desc 2","url":"/"}],"keywords":["kw1","kw2","kw3","kw4","kw5","kw6","kw7","kw8","kw9","kw10","kw11","kw12","kw13","kw14","kw15"]}`;

    const aiResp = await axios.post('https://api.anthropic.com/v1/messages', {
      model: 'claude-3-haiku-20240307', max_tokens: 2000,
      messages: [{ role: 'user', content: prompt }]
    }, { headers: { 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' } });

    const rawText = aiResp.data.content[0].text.trim();
    const jsonMatch = rawText.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error('Resposta sem JSON válido');
    const copy = JSON.parse(jsonMatch[0]);

    copy.headlines    = (copy.headlines||[]).slice(0,15).map(h=>String(h).slice(0,30));
    copy.descriptions = (copy.descriptions||[]).slice(0,4).map(d=>String(d).slice(0,90));
    copy.callouts     = (copy.callouts||[]).slice(0,10).map(c=>String(c).slice(0,25));
    copy.sitelinks    = (copy.sitelinks||[]).slice(0,6).map(sl=>({text:String(sl.text||'').slice(0,25),desc1:String(sl.desc1||'').slice(0,35),desc2:String(sl.desc2||'').slice(0,35),url:sl.url||'/'}));
    copy.keywords     = (copy.keywords||[]).slice(0,15).map(k=>String(k));

    res.json(copy);
  } catch (err) {
    res.status(500).json({ error: err.message, details: err.response?.data });
  }
});

app.post('/campaigns/create', async (req, res) => {
  try {
    const { customer_id, mcc_id, name, budget_micros, bidding_strategy, target_cpa_micros, start_date, end_date, headlines, descriptions, keywords, sitelinks, callouts, final_url } = req.body;
    const cid = customer_id.replace(/-/g, '');

    const budgetRes = await adsPost('/campaignBudgets:mutate', { operations: [{ create: { name: `${name} - Budget`, amountMicros: String(budget_micros||250000000), deliveryMethod: 'STANDARD' } }] }, customer_id, mcc_id);
    const budgetRN = budgetRes.results[0].resourceName;

    const campaignBody = { name, status: 'PAUSED', advertisingChannelType: 'SEARCH', campaignBudget: budgetRN, networkSettings: { targetGoogleSearch: true, targetSearchNetwork: false, targetContentNetwork: false, targetPartnerSearchNetwork: false }, startDate: start_date || formatDate(new Date()) };
    if (bidding_strategy === 'TARGET_CPA') { campaignBody.targetCpa = { targetCpaMicros: String(target_cpa_micros) }; } else { campaignBody.maximizeClicks = {}; }
    if (end_date) campaignBody.endDate = end_date;

    const campRes = await adsPost('/campaigns:mutate', { operations: [{ create: campaignBody }] }, customer_id, mcc_id);
    const campRN = campRes.results[0].resourceName;

    const agRes = await adsPost('/adGroups:mutate', { operations: [{ create: { campaign: campRN, name: `${name} - Grupo 1`, status: 'ENABLED', type: 'SEARCH_STANDARD' } }] }, customer_id, mcc_id);
    const agRN = agRes.results[0].resourceName;

    await adsPost('/adGroupAds:mutate', { operations: [{ create: { adGroup: agRN, status: 'ENABLED', ad: { responsiveSearchAd: { headlines: headlines.slice(0,15).map(h=>({text:h.slice(0,30)})), descriptions: descriptions.slice(0,4).map(d=>({text:d.slice(0,90)})) }, finalUrls: [final_url] } } }] }, customer_id, mcc_id);

    if (keywords && keywords.length > 0) {
      await adsPost('/adGroupCriteria:mutate', { operations: keywords.slice(0,20).map(kw=>({ create: { adGroup: agRN, status: 'ENABLED', keyword: { text: kw.text, matchType: kw.match_type||'BROAD' } } })) }, customer_id, mcc_id);
    }

    if (callouts && callouts.length > 0) {
      const assetRes = await adsPost('/assets:mutate', { operations: callouts.slice(0,10).map(c=>({ create: { calloutAsset: { calloutText: c.slice(0,25) } } })) }, customer_id, mcc_id).catch(()=>null);
      if (assetRes) {
        await adsPost('/campaignAssets:mutate', { operations: assetRes.results.map(r=>({ create: { campaign: campRN, asset: r.resourceName, fieldType: 'CALLOUT' } })) }, customer_id, mcc_id).catch(()=>{});
      }
    }

    res.json({ ok: true, campaign: campRN, ad_group: agRN, message: `Campanha "${name}" criada com sucesso (status: PAUSADA)` });
  } catch (err) {
    res.status(500).json({ error: err.message, details: err.response?.data });
  }
});

app.get('/test-anthropic', async (req, res) => {
    try {
          const resp = await axios.post('https://api.anthropic.com/v1/messages', {
                  model: 'claude-3-haiku-20240307', max_tokens: 10,
                  messages: [{ role: 'user', content: 'teste' }]
          }, {
                  headers: {
                            'x-api-key': process.env.ANTHROPIC_API_KEY,
                            'anthropic-version': '2023-06-01',
                            'content-type': 'application/json'
                  }
          });
          res.json({ ok: true, response: resp.data });
    } catch (err) {
          res.status(500).json({ error: err.message, details: err.response?.data });
    }
});

app.get('/health', (req, res) => res.json({ status: 'ok', version: ADS_API_VER }));

function formatDate(d) { return d.toISOString().slice(0,10).replace(/-/g,''); }

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Campaign Builder API rodando na porta ${PORT}`));
