FROM node:20-bookworm-slim AS deps
WORKDIR /app
ENV npm_config_registry=https://registry.npmjs.org/
ENV npm_config_audit=false
ENV npm_config_fund=false
ENV npm_config_update_notifier=false
ENV NODE_ENV=development
COPY package.json ./
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
RUN npm install --workspaces --include-workspace-root --include=dev --legacy-peer-deps --no-audit --no-fund --loglevel=warn

FROM deps AS build
WORKDIR /app
COPY . .
ARG NEXT_PUBLIC_API_URL=/api
ARG API_INTERNAL_URL=http://api:4000
ENV NODE_ENV=production
ENV NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL
ENV API_INTERNAL_URL=$API_INTERNAL_URL
ENV NEXT_OUTPUT_STANDALONE=false
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build -w apps/web

FROM node:20-bookworm-slim AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV API_INTERNAL_URL=http://api:4000
ENV npm_config_update_notifier=false
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/apps/web/package.json ./apps/web/package.json
COPY --from=build /app/apps/web/.next ./apps/web/.next
COPY --from=build /app/apps/web/public ./apps/web/public
COPY --from=build /app/apps/web/next.config.ts ./apps/web/next.config.ts
EXPOSE 3000
CMD ["npm", "run", "start", "-w", "apps/web"]
