# Hosting the Mobile Asset Health dashboard on Azure

This package makes the dashboard a live, authenticated web app on Azure
Static Web Apps. Free tier. Roughly 15 minutes.

## What's here

| File | Purpose |
|---|---|
| `app/index.html` | The dashboard, self-contained (1.24 MB) |
| `app/staticwebapp.config.json` | Requires Entra sign-in; sets security headers |
| `deploy.sh` | One-command deployment |

## Before you start

1. **Azure CLI** — install, then `az login`
2. **Node.js** — needed for the upload step (`swa` CLI)
3. **Permission to create resources** in your subscription. If you don't
   have it, send this folder to whoever does; nothing here is specific
   to your account.

## Deploy

```bash
./deploy.sh
```

To override the defaults:

```bash
APP_NAME=mobile-asset-health \
RESOURCE_GROUP=rg-mobile-asset-health \
LOCATION=eastasia \
./deploy.sh
```

`eastasia` is the closest Static Web Apps region to Perth. Static Web Apps
serves from a global CDN, so the region affects the managed API more than
page load.

## Access control

`staticwebapp.config.json` sets `allowedRoles: ["authenticated"]` on every
route, so **anonymous access is blocked** and visitors are redirected to an
Entra login. By default any account in the Roy Hill tenant can sign in.

To restrict to named individuals:

> Azure Portal → your app → **Role management** → **Invite**

Do this before circulating the link. The dashboard contains operational
fleet data, downtime detail and maintenance notifications.

## Updating the dashboard

Replace `app/index.html` and re-run:

```bash
swa deploy ./app --deployment-token "$TOKEN" --env production
```

Get the token with:

```bash
az staticwebapp secrets list --name mobile-asset-health \
  --resource-group rg-mobile-asset-health \
  --query "properties.apiKey" -o tsv
```

## What this does NOT do

**The data is still a static snapshot** cut at **12 August 2026**, covering
140 assets over 14 July – 12 August. Hosting it does not make it refresh.
Anyone opening it next month sees August data unless it is redeployed.

Two things should be settled before this is relied on:

1. **Measure ambiguity.** The source models contain `Availability %`,
   `Old Availability %`, `Availability_Real`, `Availability New %` and
   `Base Asset Availability %`. One was chosen during the build. Confirm
   the correct one with the data owner — a hosted dashboard is trusted
   more than an emailed file, and a wrong pick is invisible to the reader.

2. **Browser verification.** The file has been validated programmatically
   (187 automated checks) but never opened in a real browser. Open the
   deployed URL and check every tab renders before sharing it.

## Making it refresh (later)

Nightly refresh needs:

- an Entra **service principal** with read access to the eight semantic models
- a **timer-triggered Azure Function** re-running the queries and writing `data.json`
- the dashboard changed to `fetch()` that file instead of embedding it

The service principal approval is the long pole — start it early if you
want this. The `mobileassist-proxy` folder alongside this one already
contains the Function scaffold for the chat assistant.
