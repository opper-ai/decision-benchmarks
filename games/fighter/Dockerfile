# Jev Fighter: the web app and its API in one Node process.
# Replays and the match index live in /data: mount a volume there so they survive deploys.

FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production \
    JEV_FIGHTER_DATA_DIR=/data \
    PORT=3000
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY adapters ./adapters
COPY shared ./shared
COPY server ./server
COPY samples ./samples
EXPOSE 3000
CMD ["node", "--import", "tsx", "server/main.ts"]
