FROM node:22.22.2-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production LIZI_MODE=server LIZI_HOME=/data LIZI_HOST=0.0.0.0 LIZI_PORT=3210
COPY package.json package-lock.json ./
COPY packages/core/package.json packages/core/package.json
COPY packages/server/package.json packages/server/package.json
COPY apps/web/package.json apps/web/package.json
COPY apps/desktop/package.json apps/desktop/package.json
RUN npm ci --omit=dev --ignore-scripts --workspace=@lizi/server --workspace=@lizi/core --no-audit --no-fund && npm cache clean --force
COPY packages/core/src packages/core/src
COPY packages/server/src packages/server/src
COPY apps/web/dist apps/web/dist
RUN mkdir /data && chown node:node /data
USER node
EXPOSE 3210
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 CMD node -e "fetch('http://127.0.0.1:3210/api/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
CMD ["node", "packages/server/src/index.js"]
