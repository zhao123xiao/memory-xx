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
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev
COPY --from=builder /app/dist/ dist/
COPY wrapper-entry.mjs ./
COPY configs/ configs/
COPY migrations/ migrations/

EXPOSE 5100
HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:5100/live').then(r=>{process.exit(r.status < 300 ? 0 : 1)}).catch(()=>process.exit(1))"

CMD ["node", "wrapper-entry.mjs"]
