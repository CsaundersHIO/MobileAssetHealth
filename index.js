/* ============================================================================
   MobileAssist — model proxy
   Azure Function (Node 20+) · Hancock Iron Ore · Mobile Maintenance

   PURPOSE
     The dashboard's agent loop needs a model endpoint. This is that endpoint.
     It holds credentials server-side, forwards the tool-calling request to
     Azure OpenAI, and returns the response in the shape the dashboard expects.

     The browser never sees a key. The model never sees the dataset — only the
     tool results the dashboard hands back, which is what keeps answers grounded.

   AUTH
     Uses managed identity (DefaultAzureCredential) against Azure OpenAI, so
     there is no API key in code, config or the HTML file. Grant the Function's
     managed identity the "Cognitive Services OpenAI User" role on the resource.

   DEPLOY
     az functionapp create --name mobileassist-proxy --runtime node ...
     az functionapp identity assign --name mobileassist-proxy ...
     az role assignment create --role "Cognitive Services OpenAI User" ...

   APP SETTINGS
     AOAI_ENDPOINT     https://<resource>.openai.azure.com
     AOAI_DEPLOYMENT   your chat deployment name
     AOAI_API_VERSION  2026-01-01-preview   (or current GA)
     ALLOWED_ORIGIN    https://<your-static-web-app>.azurestaticapps.net
   ========================================================================== */

const { DefaultAzureCredential } = require('@azure/identity');

const SCOPE = 'https://cognitiveservices.azure.com/.default';
const credential = new DefaultAzureCredential();
let cachedToken = null;

async function getToken() {
  // reuse until 5 minutes before expiry
  if (cachedToken && cachedToken.expiresOnTimestamp - Date.now() > 5 * 60 * 1000) {
    return cachedToken.token;
  }
  cachedToken = await credential.getToken(SCOPE);
  return cachedToken.token;
}

/* ---- simple in-memory rate limit. For multi-instance, use Redis or Table. ---- */
const buckets = new Map();
function rateLimited(user, maxPerHour = 60) {
  const now = Date.now(), hour = 60 * 60 * 1000;
  const hits = (buckets.get(user) || []).filter(t => now - t < hour);
  hits.push(now);
  buckets.set(user, hits);
  return hits.length > maxPerHour;
}

module.exports = async function (context, req) {
  const origin = process.env.ALLOWED_ORIGIN || '';
  const cors = {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Headers': 'Content-Type,x-ms-client-principal',
    'Access-Control-Allow-Methods': 'POST,OPTIONS',
    'Content-Type': 'application/json'
  };
  if (req.method === 'OPTIONS') { context.res = { status: 204, headers: cors }; return; }

  /* ---- identify the caller from Easy Auth / Static Web Apps principal ---- */
  let user = 'anonymous';
  const p = req.headers['x-ms-client-principal'];
  if (p) {
    try {
      const claims = JSON.parse(Buffer.from(p, 'base64').toString('utf8'));
      user = claims.userDetails || claims.userId || 'authenticated';
    } catch { /* leave as anonymous */ }
  }
  if (user === 'anonymous' && process.env.REQUIRE_AUTH !== 'false') {
    context.res = { status: 401, headers: cors, body: JSON.stringify({ error: 'Sign-in required.' }) };
    return;
  }
  if (rateLimited(user)) {
    context.res = { status: 429, headers: cors,
      body: JSON.stringify({ error: 'Too many questions this hour. Try again shortly.' }) };
    return;
  }

  const body = req.body || {};
  if (!Array.isArray(body.messages) || !body.messages.length) {
    context.res = { status: 400, headers: cors, body: JSON.stringify({ error: 'messages required' }) };
    return;
  }

  /* ---- translate the dashboard payload into the Azure OpenAI chat shape ----
     The dashboard sends Anthropic-style blocks. Azure OpenAI uses `tools` with
     a nested function object and tool_calls on the assistant message, so we map
     both directions and the dashboard code stays untouched. */
  const tools = (body.tools || []).map(t => ({
    type: 'function',
    function: { name: t.name, description: t.description, parameters: t.input_schema }
  }));

  const messages = [{ role: 'system', content: body.system || '' }];
  for (const m of body.messages) {
    if (typeof m.content === 'string') { messages.push({ role: m.role, content: m.content }); continue; }
    if (m.role === 'assistant') {
      const text = m.content.filter(b => b.type === 'text').map(b => b.text).join('\n');
      const calls = m.content.filter(b => b.type === 'tool_use').map(b => ({
        id: b.id, type: 'function',
        function: { name: b.name, arguments: JSON.stringify(b.input || {}) }
      }));
      messages.push({ role: 'assistant', content: text || null,
        ...(calls.length ? { tool_calls: calls } : {}) });
    } else {
      const results = m.content.filter(b => b.type === 'tool_result');
      if (results.length) {
        results.forEach(r => messages.push({
          role: 'tool', tool_call_id: r.tool_use_id,
          content: typeof r.content === 'string' ? r.content : JSON.stringify(r.content)
        }));
      } else {
        messages.push({ role: 'user',
          content: m.content.filter(b => b.type === 'text').map(b => b.text).join('\n') });
      }
    }
  }

  const url = `${process.env.AOAI_ENDPOINT}/openai/deployments/` +
              `${process.env.AOAI_DEPLOYMENT}/chat/completions` +
              `?api-version=${process.env.AOAI_API_VERSION || '2026-01-01-preview'}`;

  try {
    const token = await getToken();
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        messages,
        ...(tools.length ? { tools, tool_choice: 'auto' } : {}),
        max_tokens: body.max_tokens || 1400,
        temperature: 0.2          // low: this is analysis, not creative writing
      })
    });

    if (!res.ok) {
      const detail = await res.text();
      context.log.error('Azure OpenAI error', res.status, detail.slice(0, 400));
      context.res = { status: 502, headers: cors,
        body: JSON.stringify({ error: 'The analysis service is unavailable.' }) };
      return;
    }

    const data = await res.json();
    const choice = (data.choices || [])[0] || {};
    const msg = choice.message || {};

    /* ---- map back to the block shape the dashboard's loop expects ---- */
    const content = [];
    if (msg.content) content.push({ type: 'text', text: msg.content });
    (msg.tool_calls || []).forEach(tc => {
      let input = {};
      try { input = JSON.parse(tc.function.arguments || '{}'); } catch { /* bad JSON from model */ }
      content.push({ type: 'tool_use', id: tc.id, name: tc.function.name, input });
    });

    /* ---- audit: who asked what, which tools fired, tokens used ---- */
    context.log(JSON.stringify({
      ts: new Date().toISOString(), user,
      turns: body.messages.length,
      toolsRequested: content.filter(c => c.type === 'tool_use').map(c => c.name),
      usage: data.usage || null
    }));

    context.res = { status: 200, headers: cors,
      body: JSON.stringify({ content, stop_reason: choice.finish_reason }) };

  } catch (err) {
    context.log.error('Proxy failure', err);
    context.res = { status: 500, headers: cors,
      body: JSON.stringify({ error: 'The analysis service could not be reached.' }) };
  }
};
