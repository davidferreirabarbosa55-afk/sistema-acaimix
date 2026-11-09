# Imagem do sistema Açaí Mix para o Fly.io (ou qualquer lugar que rode Docker).
# Node 22 já traz o SQLite embutido: nenhuma dependência para instalar.
FROM node:22-slim

ENV NODE_ENV=production \
    PORTA=3000 \
    PASTA_DADOS=/data \
    NODE_OPTIONS=--max-old-space-size=200

WORKDIR /app
COPY package.json ./
COPY src ./src
COPY public ./public
COPY scripts ./scripts
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN sed -i "s/\r$//" /usr/local/bin/docker-entrypoint.sh && chmod +x /usr/local/bin/docker-entrypoint.sh && mkdir -p /data

EXPOSE 3000
ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["node", "--disable-warning=ExperimentalWarning", "src/server.js"]
