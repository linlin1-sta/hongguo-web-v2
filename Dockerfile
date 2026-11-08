# 红果短剧手机网页版 v2 — Railway 单服务镜像
# 容器内同时跑 hongguoTV bridge(8787 内网) + v2 后端($PORT 对外)
FROM node:22-bookworm-slim
RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg ca-certificates \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund
COPY hongguoTV/server/package.json hongguoTV/server/package-lock.json ./hongguoTV/server/
RUN npm ci --prefix hongguoTV/server --omit=dev --no-audit --no-fund
COPY . .
ENV NODE_ENV=production \
    BRIDGE_ORIGIN=http://127.0.0.1:8787 \
    VIDEO_CACHE_DIR=/tmp/video-cache-v2
EXPOSE 8899
CMD ["bash", "start-railway.sh"]
