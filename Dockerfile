FROM node:22-bookworm-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --chown=node:node src ./src
COPY --chown=node:node node-red ./node-red
COPY --chown=node:node scripts ./scripts
COPY --chown=node:node config ./config
RUN mkdir -p /app/runtime && chown -R node:node /app/runtime
USER node
ENV NODE_ENV=production
CMD ["node", "src/services/aggregator.js"]
