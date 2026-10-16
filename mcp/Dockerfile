FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json ./
COPY mcp/package.json mcp/package.json
COPY web/package.json web/package.json
RUN npm ci --omit=dev=false
COPY src src
COPY scripts scripts
COPY mcp mcp
COPY web/data web/data
ENV HOST=0.0.0.0
ENV PORT=8080
EXPOSE 8080
CMD ["npx", "tsx", "mcp/src/http.ts"]
