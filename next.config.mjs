/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  serverExternalPackages: ['pg', 'typescript', 'yauzl', '@vue/compiler-sfc'],
  // e2e 使用独立产物目录，不干扰本地开发服务器（scripts/e2e-server.ts 设置）
  ...(process.env.NEXT_DIST_DIR ? { distDir: process.env.NEXT_DIST_DIR } : {}),
  // Next 15.5.25 内置 @vercel/nft 对 @vue/compiler-sfc（内嵌 consolidate）做静态求值时
  // 会把 mock 的 path.join 当作 thenable.then 调用导致 build 崩溃（已用最小复现确认，
  // 仅该文件触发）。将其排除出文件追踪：运行时仍从 node_modules 正常加载，
  // 仅 output:'standalone' 部署需自行携带该依赖（本项目使用完整 node_modules 部署，不受影响）。
  outputFileTracingExcludes: {
    'next-server': ['**/node_modules/@vue/compiler-sfc/**'],
  },
}

export default nextConfig
