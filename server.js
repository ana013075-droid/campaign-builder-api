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
