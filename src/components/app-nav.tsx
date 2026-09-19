'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { useEffect, useRef, useState } from 'react'
import { BookOpen, FolderKanban, LineChart, Menu, X } from 'lucide-react'

const LINKS = [
  { href: '/projects', label: '项目', icon: FolderKanban },
  { href: '/knowledge', label: '知识库', icon: BookOpen },
  { href: '/evaluation', label: '评测', icon: LineChart },
] as const

const linkClass =
  'flex items-center gap-1.5 rounded-md px-3 py-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground'

/** 桌面端导航:保持原信息架构(md 及以上视口显示) */
export function DesktopNav() {
  return (
    <nav className="hidden items-center gap-1 text-sm md:flex">
      {LINKS.map(({ href, label, icon: Icon }) => (
        <Link key={href} href={href} className={linkClass}>
          <Icon className="h-4 w-4" />
          {label}
        </Link>
      ))}
    </nav>
  )
}

/** 移动端导航:390px 视口下文字链接逐字换行,折叠为菜单入口(md 以下视口显示) */
export function MobileNav() {
  const [open, setOpen] = useState(false)
  const pathname = usePathname()
  const rootRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    setOpen(false)
  }, [pathname])

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    const onPointer = (e: PointerEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('keydown', onKey)
    document.addEventListener('pointerdown', onPointer)
    return () => {
      document.removeEventListener('keydown', onKey)
      document.removeEventListener('pointerdown', onPointer)
    }
  }, [open])

  return (
    <div ref={rootRef} className="relative md:hidden">
      <button
        type="button"
        className="flex h-10 w-10 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
        aria-expanded={open}
        aria-label={open ? '收起导航菜单' : '展开导航菜单'}
        onClick={() => setOpen((v) => !v)}
      >
        {open ? <X className="h-5 w-5" /> : <Menu className="h-5 w-5" />}
      </button>
      {open && (
        <nav
          aria-label="站内导航"
          className="absolute right-0 top-12 z-50 min-w-40 rounded-lg border bg-card p-1.5 shadow-md"
        >
          {LINKS.map(({ href, label, icon: Icon }) => (
            <Link
              key={href}
              href={href}
              className="flex items-center gap-2.5 rounded-md px-3 py-2.5 text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
              onClick={() => setOpen(false)}
            >
              <Icon className="h-4 w-4" />
              {label}
            </Link>
          ))}
        </nav>
      )}
    </div>
  )
}
