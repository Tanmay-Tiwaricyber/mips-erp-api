FROM node:20-slim

# tesseract.js is pure WASM, but sharp needs these at runtime
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev
COPY src ./src
COPY openapi.json ./

ENV NODE_ENV=production
ENV PORT=3000
EXPOSE 3000
CMD ["node", "src/server.js"]
