# syntax=docker/dockerfile:1
FROM node:22-bookworm-slim

ENV NODE_ENV=production
WORKDIR /app
RUN corepack enable

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY relay/package.json relay/package.json
RUN pnpm install --frozen-lockfile --filter @codor/relay... --prod=false

COPY relay/tsconfig.json relay/tsconfig.json
COPY relay/src relay/src
RUN pnpm --filter @codor/relay build

USER node
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s \
  CMD node -e "fetch('http://127.0.0.1:8787/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
CMD ["node", "relay/dist/index.js"]
