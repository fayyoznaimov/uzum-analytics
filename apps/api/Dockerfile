FROM node:20-bookworm-slim
WORKDIR /app

ENV npm_config_registry=https://registry.npmjs.org/
ENV npm_config_audit=false
ENV npm_config_fund=false
ENV npm_config_update_notifier=false
ENV NODE_ENV=development

RUN apt-get update \
  && apt-get install -y --no-install-recommends openssl ca-certificates curl \
  && rm -rf /var/lib/apt/lists/*

COPY package.json ./
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
RUN npm install --workspaces --include-workspace-root --include=dev --legacy-peer-deps --no-audit --no-fund --loglevel=warn

COPY apps/api ./apps/api
RUN npm run prisma:generate -w apps/api \
  && npm run build -w apps/api \
  && echo "=== API build output ===" \
  && find /app -maxdepth 6 -type f -path "*/dist/*main.js" -print | sort

ENV NODE_ENV=production
EXPOSE 4000
CMD ["sh", "-c", "set -eu; npx prisma db push --schema apps/api/prisma/schema.prisma; node apps/api/prisma/seed.cjs; MAIN=''; for f in apps/api/dist/main.js apps/api/dist/src/main.js dist/main.js dist/apps/api/main.js dist/apps/api/src/main.js; do if [ -f \"$f\" ]; then MAIN=\"$f\"; break; fi; done; if [ -z \"$MAIN\" ]; then echo 'ERROR: compiled API main.js not found'; echo 'Available main.js files:'; find /app -maxdepth 8 -type f -name main.js -print; exit 1; fi; echo \"Starting API: $MAIN\"; exec node \"$MAIN\""]
