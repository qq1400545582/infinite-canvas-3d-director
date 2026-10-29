FROM node:22-alpine

WORKDIR /app
COPY package.json ./
COPY src ./src

# 数据目录挂载为卷，容器重建不丢用户与订单
VOLUME ["/app/data"]
ENV LICENSE_DATA_DIR=/app/data
ENV PORT=8787

EXPOSE 8787
CMD ["node", "src/index.js"]
