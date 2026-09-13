import type { Metadata } from 'next'
import './globals.css'

export const metadata: Metadata = {
  title: 'CodeAtlas 码鉴 · 证据驱动的 AI 项目体检',
  description:
    '面向学生和小型团队的 JS/TS AI 代码审查与项目体检工作台：静态分析、AI 定向审查、证据定位、补丁提案与快照对比。',
}

export default function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  )
}
