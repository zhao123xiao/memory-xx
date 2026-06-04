# Stage 1: Install dependencies and compile
FROM node:20-slim AS builder
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci
COPY tsconfig.json ./
COPY app/ app/
RUN npm run build

# Stage 2: Production image
FROM node:20-slim
WORKDIR /app
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 python3-requests \
  && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev && npm install --no-save tsx
COPY --from=builder /app/dist/ dist/
COPY tsconfig.json ./
COPY wrapper-entry.mjs ./
COPY app/ app/
COPY scripts/ scripts/
COPY sidecars/ sidecars/
COPY configs/ configs/
COPY migrations/ migrations/

EXPOSE 5100 5200 5210 5220 5221 5310 6334 8085
HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:5100/live').then(r=>{process.exit(r.status < 300 ? 0 : 1)}).catch(()=>process.exit(1))"

CMD ["node", "wrapper-entry.mjs"]
