# MobileAssist — model proxy

Makes the Mobile Asset Health AI Command Centre's chat panel fully agentic by giving it
a model endpoint. Holds credentials server-side; no key ever reaches the browser.

## How it fits together

    Dashboard (HTML)          This proxy              Azure OpenAI
    ----------------          ----------              ------------
    question + tool defs  ->  add credentials     ->  model decides
                              translate payload
    run tool locally      <-  return tool_use     <-  tool call
    tool result           ->  forward             ->  model reads result
    render answer         <-  return text         <-  final answer

The model never receives the dataset — only the compact tool results the dashboard
returns. That is what keeps answers grounded, fast and cheap.

## Deploy

    az functionapp create --resource-group <rg> --name mobileassist-proxy \
      --runtime node --runtime-version 20 --functions-version 4 \
      --consumption-plan-location australiaeast --storage-account <sa>

    az functionapp identity assign --resource-group <rg> --name mobileassist-proxy

    # grant that identity access to Azure OpenAI (no API key needed)
    az role assignment create --role "Cognitive Services OpenAI User" \
      --assignee <principalId-from-previous-step> \
      --scope /subscriptions/<sub>/resourceGroups/<rg>/providers/Microsoft.CognitiveServices/accounts/<aoai>

    npm install && func azure functionapp publish mobileassist-proxy

## App settings

| Setting | Example |
|---|---|
| `AOAI_ENDPOINT` | `https://hio-aoai.openai.azure.com` |
| `AOAI_DEPLOYMENT` | your chat deployment name |
| `AOAI_API_VERSION` | `2026-01-01-preview` |
| `ALLOWED_ORIGIN` | `https://mobileassist.azurestaticapps.net` |
| `REQUIRE_AUTH` | `true` |

## Point the dashboard at it

In the HTML, find `AGENT_CONFIG` and set:

    mode: 'proxy',
    endpoint: 'https://mobileassist-proxy.azurewebsites.net/api/mobileassist',

The dashboard switches from its local planner to the full agent loop automatically,
and falls back to the local planner if the endpoint is unreachable — so it degrades
rather than breaks.

## What is deliberately included

- **Managed identity** — no API key in code, config, or the HTML file.
- **Entra sign-in required** — reads the Easy Auth / Static Web Apps principal header.
- **Rate limit** — 60 questions per user per hour, in memory. Move to Redis or Table
  storage if you run more than one instance.
- **Audit line per turn** — who asked, which tools fired, tokens used. Goes to
  Application Insights. The first time someone questions a recommendation to bring a
  change-out forward, this is the record you will want.
- **temperature 0.2** — this is analysis, not copywriting.

## What still needs deciding

- **Where the data comes from.** Today the tools run against a snapshot embedded in the
  HTML. For a live system they should query Fabric or the semantic models directly, and
  the tool implementations move server-side into this Function.
- **Curate the semantic models first.** The fleet model exposes `Availability %`,
  `Old Availability %`, `Availability_Real`, `Availability New %` and
  `Base Asset Availability %`. A person can reason about which is right; a model
  generating DAX unattended will pick confidently and wrongly. Add descriptions, hide
  deprecated measures, mark the canonical one — before going live, not after.
