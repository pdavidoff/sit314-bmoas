#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
command -v docker >/dev/null || { echo "Install Docker with Compose first"; exit 1; }
if [ ! -f .env ]; then
 cp .env.example .env
 node -e 'const fs=require("fs"),crypto=require("crypto"); fs.writeFileSync(".env",fs.readFileSync(".env","utf8").replace("REPLACE_WITH_32_OR_MORE_RANDOM_CHARACTERS",crypto.randomBytes(32).toString("hex")));'
 chmod 600 .env
fi
if [ ! -f package-lock.json ]; then
 echo "Resolving dependencies for the first time. Commit package-lock.json after checking npm audit."
 npm install
else npm ci; fi
docker compose up -d
for _ in $(seq 1 40); do
 if docker compose exec -T mongo mongosh --quiet --eval 'db.adminCommand({ping:1}).ok' >/dev/null 2>&1; then break; fi
 sleep 2
done
docker compose exec -T mongo mongosh --quiet --eval 'try { rs.status() } catch(e) { rs.initiate({_id:"rs0",members:[{_id:0,host:"localhost:27017"}]}) }'
for _ in $(seq 1 40); do
 if docker compose exec -T mongo mongosh --quiet --eval 'if (!db.hello().isWritablePrimary) quit(1)' >/dev/null 2>&1; then break; fi
 sleep 2
done
npm run init
npm run test:integration
echo 'Local dependencies ready. Start bridge, node-red, validator, aggregator and api using npm scripts.'
