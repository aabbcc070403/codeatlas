# CodeAtlas 生产镜像（R09）。
# 多阶段构建：deps（安装依赖）→ build（next build）→ runtime（非 root 运行）。
# 注意：本项目不使用 Next 的 output:'standalone'——next.config.mjs 中的
# outputFileTracingExcludes 排除了 @vue/compiler-sfc（Next 15.5.25 内置 nft 对其静态
# 求值会崩溃，见 docs/progress.md R01），standalone 产物因此不含该依赖，而运行时的
# Vue SFC 分析（serverExternalPackages）需要它。若将来改用 standalone，必须在运行时
# 镜像显式补回 node_modules/@vue/compiler-sfc 及其 pnpm 虚拟存储依赖。本镜像采用
# 「完整 node_modules + next start」部署，与本地开发同构，规避该坑。
FROM node:22-slim AS deps
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
# corepack 提供 pnpm（Node 22 自带；版本由 package.json packageManager 锁定）
RUN corepack enable && pnpm install --frozen-lockfile

FROM node:22-slim AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1
RUN corepack enable && pnpm build

FROM node:22-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3100 \
    # 运行时存储根目录（compose 挂载持久卷到该路径）
    STORAGE_ROOT=/app/.data/storage
# 预建存储目录并交给非 root 用户
RUN mkdir -p /app/.data/storage && chown -R node:node /app/.data
# 产物与依赖（node_modules 整体复制，保留 pnpm 相对符号链接）
COPY --from=build --chown=node:node /app/.next ./.next
COPY --from=build --chown=node:node /app/node_modules ./node_modules
# worker 与迁移/seed 脚本经 tsx 运行 TypeScript 源码（src 内部使用 @/ 别名，需要 tsconfig）
COPY --from=build --chown=node:node /app/package.json /app/next.config.mjs /app/tsconfig.json ./
COPY --from=build --chown=node:node /app/src ./src
COPY --from=build --chown=node:node /app/scripts ./scripts
# 评测数据集（A05）：fixtures 为版本化产物（.dockerignore 未排除，build 阶段 COPY . .
# 已包含）。web/worker 使用同一镜像 → datasetVersion 必然一致，不依赖宿主机目录或
# 部署时生成；resolveFixturesDir() 默认读 process.cwd()/fixtures = /app/fixtures。
# fixtures 缺失时此 COPY 会使构建立即失败，不会产出「数据集未就绪」的残缺镜像。
COPY --from=build --chown=node:node /app/fixtures ./fixtures
USER node
EXPOSE 3100
# web 默认入口；worker 在 compose.yaml 中以同镜像不同 command 覆盖
CMD ["node", "node_modules/next/dist/bin/next", "start", "-p", "3100"]
