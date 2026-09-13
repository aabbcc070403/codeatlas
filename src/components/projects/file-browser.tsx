'use client'

import { useEffect, useMemo, useState } from 'react'
import { Badge } from '@/components/ui/badge'
import { FileCode2, FileJson, FileText, Folder, Loader2 } from 'lucide-react'

interface FileMeta {
  path: string
  language: string
  line_count: number
  parse_status: string
}

interface FileContent {
  path: string
  language: string
  lineCount: number
  content: string
  redactedRanges: Array<{ line: number; start: number; end: number }>
}

const LANG_ICON: Record<string, typeof FileCode2> = {
  ts: FileCode2,
  tsx: FileCode2,
  js: FileCode2,
  jsx: FileCode2,
  vue: FileCode2,
  json: FileJson,
  md: FileText,
  css: FileCode2,
  html: FileCode2,
}

/** 快照文件浏览器：目录树 + 只读代码预览（行号定位） */
export function FileBrowser({ snapshotId }: { snapshotId: string }) {
  const [files, setFiles] = useState<FileMeta[] | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const [content, setContent] = useState<FileContent | null>(null)
  const [loadingContent, setLoadingContent] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    fetch(`/api/snapshots/${snapshotId}/files`)
      .then(async (res) => {
        if (!res.ok) throw new Error('加载文件列表失败')
        const body = (await res.json()) as { files: FileMeta[] }
        if (!cancelled) setFiles(body.files)
      })
      .catch((e: Error) => {
        if (!cancelled) setError(e.message)
      })
    return () => {
      cancelled = true
    }
  }, [snapshotId])

  useEffect(() => {
    if (!selected) return
    setLoadingContent(true)
    fetch(`/api/snapshots/${snapshotId}/files?path=${encodeURIComponent(selected)}`)
      .then(async (res) => {
        if (!res.ok) throw new Error('加载文件内容失败')
        const body = (await res.json()) as FileContent
        setContent(body)
      })
      .catch((e: Error) => setError(e.message))
      .finally(() => setLoadingContent(false))
  }, [snapshotId, selected])

  const tree = useMemo(() => buildTree(files ?? []), [files])

  if (error) return <p className="text-sm text-destructive">{error}</p>
  if (!files) {
    return (
      <p className="flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" /> 加载文件…
      </p>
    )
  }

  return (
    <div className="grid gap-3 md:grid-cols-[240px_1fr]">
      <div className="max-h-[480px] overflow-auto rounded-md border bg-card p-2 text-sm">
        <TreeView nodes={tree} selected={selected} onSelect={setSelected} />
      </div>
      <div className="min-w-0">
        {loadingContent && (
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> 加载内容…
          </p>
        )}
        {!loadingContent && !content && (
          <p className="flex h-full items-center justify-center rounded-md border border-dashed text-sm text-muted-foreground">
            选择左侧文件查看脱敏后代码
          </p>
        )}
        {content && <CodeView content={content} />}
      </div>
    </div>
  )
}

interface TreeNode {
  name: string
  path: string
  isDir: boolean
  children: TreeNode[]
  language?: string
  parseStatus?: string
  lineCount?: number
}

function buildTree(files: FileMeta[]): TreeNode[] {
  const root: TreeNode = { name: '', path: '', isDir: true, children: [] }
  for (const f of files) {
    const segs = f.path.split('/')
    let cur = root
    for (let i = 0; i < segs.length; i++) {
      const seg = segs[i]!
      const isLeaf = i === segs.length - 1
      const path = segs.slice(0, i + 1).join('/')
      let next = cur.children.find((c) => c.name === seg && c.isDir === !isLeaf)
      if (!next) {
        next = {
          name: seg,
          path,
          isDir: !isLeaf,
          children: [],
          language: isLeaf ? f.language : undefined,
          parseStatus: isLeaf ? f.parse_status : undefined,
          lineCount: isLeaf ? f.line_count : undefined,
        }
        cur.children.push(next)
      }
      cur = next
    }
  }
  const sortRec = (n: TreeNode) => {
    n.children.sort((a, b) => {
      if (a.isDir !== b.isDir) return a.isDir ? -1 : 1
      return a.name < b.name ? -1 : 1
    })
    n.children.forEach(sortRec)
  }
  sortRec(root)
  return root.children
}

function TreeView({
  nodes,
  selected,
  onSelect,
  depth = 0,
}: {
  nodes: TreeNode[]
  selected: string | null
  onSelect: (path: string) => void
  depth?: number
}) {
  return (
    <ul>
      {nodes.map((n) => (
        <li key={n.path}>
          {n.isDir ? (
            <details open={depth < 1}>
              <summary
                className="flex cursor-pointer items-center gap-1 rounded px-1 py-0.5 hover:bg-accent"
                style={{ paddingLeft: depth * 12 + 4 }}
              >
                <Folder className="h-3.5 w-3.5 text-muted-foreground" />
                <span className="truncate">{n.name}</span>
              </summary>
              <TreeView nodes={n.children} selected={selected} onSelect={onSelect} depth={depth + 1} />
            </details>
          ) : (
            <button
              className={`flex w-full items-center gap-1 rounded px-1 py-0.5 text-left hover:bg-accent ${
                selected === n.path ? 'bg-accent text-accent-foreground' : ''
              }`}
              style={{ paddingLeft: depth * 12 + 4 }}
              onClick={() => onSelect(n.path)}
            >
              {(() => {
                const Icon = LANG_ICON[n.language ?? ''] ?? FileText
                return <Icon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
              })()}
              <span className="truncate">{n.name}</span>
              {n.parseStatus === 'parse_error' && (
                <Badge variant="warning" className="ml-auto shrink-0 px-1 py-0 text-[10px]">
                  语法
                </Badge>
              )}
            </button>
          )}
        </li>
      ))}
    </ul>
  )
}

function CodeView({ content }: { content: FileContent }) {
  const lines = content.content.split('\n')
  const redactedLines = new Set(content.redactedRanges.map((r) => r.line))
  return (
    <div className="min-w-0 overflow-hidden rounded-md border bg-card">
      <div className="flex items-center gap-2 border-b px-3 py-2 text-xs text-muted-foreground">
        <span className="truncate font-mono">{content.path}</span>
        <Badge variant="secondary">{content.language}</Badge>
        <span>{content.lineCount} 行</span>
        {content.redactedRanges.length > 0 && (
          <Badge variant="muted">含 {content.redactedRanges.length} 处脱敏</Badge>
        )}
      </div>
      <div className="max-h-[440px] overflow-auto">
        <table className="w-full border-collapse font-mono text-xs">
          <tbody>
            {lines.map((line, i) => {
              const lineNo = i + 1
              const masked = redactedLines.has(lineNo)
              return (
                <tr key={lineNo} className={masked ? 'bg-amber-500/5' : undefined}>
                  <td className="w-12 select-none border-r px-2 py-0 text-right align-top text-muted-foreground/60">
                    {lineNo}
                  </td>
                  <td className="whitespace-pre px-2 py-0">
                    {line === '' ? ' ' : line}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}
