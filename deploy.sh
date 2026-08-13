#!/usr/bin/env bash
# Deploys the Mobile Asset Health dashboard to Azure Static Web Apps.
# Prerequisites: Azure CLI installed and `az login` completed.
set -euo pipefail

APP_NAME="${APP_NAME:-mobile-asset-health}"
RESOURCE_GROUP="${RESOURCE_GROUP:-rg-mobile-asset-health}"
LOCATION="${LOCATION:-eastasia}"          # closest SWA region to Perth
APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/app"

echo "==> Signed in as:"
az account show --query "{subscription:name, user:user.name}" -o table

read -rp "Deploy '$APP_NAME' to resource group '$RESOURCE_GROUP' in '$LOCATION'? [y/N] " ok
[[ "$ok" == "y" || "$ok" == "Y" ]] || { echo "Cancelled."; exit 1; }

echo "==> Ensuring resource group exists"
az group create --name "$RESOURCE_GROUP" --location "$LOCATION" -o none

echo "==> Creating Static Web App (Free tier)"
az staticwebapp create \
  --name "$APP_NAME" \
  --resource-group "$RESOURCE_GROUP" \
  --location "$LOCATION" \
  --sku Free -o none

echo "==> Retrieving deployment token"
TOKEN=$(az staticwebapp secrets list --name "$APP_NAME" \
        --resource-group "$RESOURCE_GROUP" --query "properties.apiKey" -o tsv)

echo "==> Uploading site"
if ! command -v swa >/dev/null 2>&1; then
  echo "    Installing Static Web Apps CLI (npm)…"
  npm install -g @azure/static-web-apps-cli
fi
swa deploy "$APP_DIR" --deployment-token "$TOKEN" --env production

URL=$(az staticwebapp show --name "$APP_NAME" --resource-group "$RESOURCE_GROUP" \
      --query "defaultHostname" -o tsv)

cat <<EOF

==========================================================
  Deployed:  https://$URL
==========================================================

IMPORTANT — do this before sharing the link:

  The site currently allows any account in your Entra tenant.
  To restrict it to named people:

    Azure Portal > $APP_NAME > Role management > Invite

  staticwebapp.config.json already requires authentication,
  so the link will not work for anonymous or external users.

EOF
