FROM docker.m.daocloud.io/library/node:24
WORKDIR /app
RUN npm config set registry https://registry.npmmirror.com
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
CMD ["npx", "vitest", "run", "tests/unit/cli/init-wizard.test.ts", "tests/unit/config/source-schema.test.ts"]
