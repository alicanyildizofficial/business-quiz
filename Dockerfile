# Business Quiz — The Business Partner AI
# Sıfır bağımlılık: npm install yok, build adımı yok.
FROM node:22-alpine

WORKDIR /app

# Snapshot dizini; Coolify'de kalıcı volume buraya bağlanır.
RUN mkdir -p /app/data && chown -R node:node /app

COPY --chown=node:node server.js questions.json ./
COPY --chown=node:node public ./public

USER node

ENV NODE_ENV=production \
    PORT=3000 \
    DATA_DIR=/app/data

EXPOSE 3000

HEALTHCHECK --interval=20s --timeout=4s --start-period=5s --retries=3 \
  CMD node -e "require('http').get('http://127.0.0.1:3000/api/health',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

CMD ["node", "server.js"]
