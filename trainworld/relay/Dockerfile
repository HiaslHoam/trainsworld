FROM node:22-alpine
WORKDIR /app/relay
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY server.mjs files.mjs ./
# the built game is mounted at /app/dist, the data cache at /app/data-cache (see README.md)
ENV BIND=0.0.0.0 TW_STATIC_DIR=/app/dist TW_DATA_CACHE=/app/data-cache
RUN mkdir -p /app/data-cache && chown node:node /app/data-cache
USER node
EXPOSE 8787
CMD ["node", "server.mjs"]
