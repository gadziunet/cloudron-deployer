FROM node:22-slim
# Cloudron CLI: to nim wdrazamy aplikacje na serwery Cloudron
RUN npm install -g cloudron@9 && npm cache clean --force
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY src ./src
COPY public ./public
ENV NODE_ENV=production DATA_DIR=/data PORT=3000
VOLUME /data
EXPOSE 3000
USER node
CMD ["node", "src/server.js"]
