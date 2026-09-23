'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import Image from 'next/image'
import { AlertTriangle, BookOpen, ImagePlus, Loader2, SendHorizontal, ShieldQuestion, X } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  IMAGE_MIME_TYPES,
  MAX_IMAGES_PER_MESSAGE,
  MAX_QUESTION_LENGTH,
  type ImageAttachment,
  type MessageStatus,
} from '@/core/contracts/conversation'
import type { MessageRow } from '@/server/queries/messages'

/**
 * 追问面板（R05）：历史消息、提问输入、提交中/超时/限额/AI 未配置/证据不足状态。
 * 引用点击定位代码区；定位失败展示「证据无效/待核查」，不作为可信结论高亮。
 * 全部文本按纯文本渲染（不使用 innerHTML），恶意 Markdown/HTML 不执行。
 */

export interface ConversationPanelProps {
  findingId: string
  /** 点击引用 → 定位代码区（父组件切换 viewing 并加载文件） */
  onCite: (ref: { path: string; startLine: number; endLine: number }) => void
  /** 父组件维护的无效引用路径集合：文件加载失败或行段越界（展示「证据无效/待核查」） */
  invalidPaths: Set<string>
}

type ErrorState = { code: string; message: string } | null

const STATUS_NOTE: Partial<Record<MessageStatus, string>> = {
  insufficient_evidence: '证据不足：回答缺少已验证的代码/规范引用，请自行核查原文。',
}

const RETRIEVAL_LABEL: Record<string, string> = {
  hybrid: '混合检索',
  lexical_only: '词法检索',
}

export function ConversationPanel({ findingId, onCite, invalidPaths }: ConversationPanelProps) {
  const [messages, setMessages] = useState<MessageRow[] | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [input, setInput] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<ErrorState>(null)
  const [images, setImages] = useState<ImageAttachment[]>([])
  const listRef = useRef<HTMLDivElement | null>(null)
  const fileInputRef = useRef<HTMLInputElement | null>(null)

  /** 追加图像附件（粘贴/选择）：mime 白名单 + 单张 ≤1MB + 最多 3 张 */
  const addFiles = useCallback((files: FileList | File[]) => {
    const allowed = new Set<string>(IMAGE_MIME_TYPES)
    for (const file of Array.from(files)) {
      if (!allowed.has(file.type)) {
        setError({ code: 'invalid_request', message: '仅支持 png/jpeg/webp/gif 截图' })
        continue
      }
      if (file.size > 1_000_000) {
        setError({ code: 'invalid_request', message: '截图单张 ≤1MB' })
        continue
      }
      void new Promise<string>((resolve, reject) => {
        const reader = new FileReader()
        reader.onload = () => resolve(String(reader.result).split(',')[1] ?? '')
        reader.onerror = () => reject(new Error('read failed'))
        reader.readAsDataURL(file)
      })
        .then((dataBase64) => {
          setImages((prev) =>
            prev.length >= MAX_IMAGES_PER_MESSAGE
              ? prev
              : [
                  ...prev,
                  { mime: file.type as ImageAttachment['mime'], name: file.name, dataBase64 },
                ],
          )
        })
        .catch(() => setError({ code: 'invalid_request', message: '截图读取失败' }))
    }
  }, [])

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/findings/${findingId}/messages?limit=50`)
      if (res.status === 401) {
        setLoadError('会话已过期，请重新登录')
        return
      }
      if (!res.ok) throw new Error('加载失败')
      const body = (await res.json()) as { items: MessageRow[] }
      setMessages(body.items)
      setLoadError(null)
    } catch {
      setLoadError('追问历史加载失败')
    }
  }, [findingId])

  useEffect(() => {
    void load()
  }, [load])

  const submit = useCallback(async () => {
    const text = input.trim()
    if (!text || text.length > MAX_QUESTION_LENGTH || submitting) return
    setSubmitting(true)
    setError(null)
    try {
      const res = await fetch(`/api/findings/${findingId}/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          text,
          ...(images.length > 0
            ? { images: images.map(({ mime, name, dataBase64 }) => ({ mime, name, dataBase64 })) }
            : {}),
        }),
      })
      if (res.ok) {
        setInput('')
        setImages([])
      } else {
        const body = (await res.json().catch(() => null)) as
          | { error?: { code?: string; message?: string } }
          | null
        const code = body?.error?.code ?? 'internal_error'
        const message =
          body?.error?.message ??
          (res.status === 401
            ? '会话已过期，请重新登录'
            : res.status === 429
              ? '预算耗尽，稍后再试'
              : res.status === 504
                ? '追问超时'
                : '追问失败，稍后再试')
        setError({ code, message })
      }
      // 成功与失败都重取：用户消息已持久化（超时/取消/预算错误同样保留）
      await load()
    } catch {
      setError({ code: 'network', message: '网络错误，请重试' })
    } finally {
      setSubmitting(false)
    }
  }, [findingId, images, input, load, submitting])

  return (
    <div className="space-y-2" data-testid="conversation-panel">
      <div className="flex items-center justify-between">
        <p className="text-xs font-medium text-muted-foreground">追问（围绕当前问题）</p>
        <p className="text-[11px] text-muted-foreground">每轮 ≤4 次模型请求 · ≤8 次工具 · 60s</p>
      </div>

      {/* 历史消息 */}
      <div ref={listRef} className="space-y-3" data-testid="conv-messages">
        {messages === null && !loadError && (
          <p className="flex items-center gap-2 text-xs text-muted-foreground">
            <Loader2 className="h-3 w-3 animate-spin" /> 加载消息…
          </p>
        )}
        {loadError && <p className="text-xs text-destructive">{loadError}</p>}
        {messages?.length === 0 && (
          <p className="text-xs text-muted-foreground">
            还没有追问。问题、代码与规范引用都只在当前快照范围内检索。
          </p>
        )}
        {messages?.map((m) =>
          m.role === 'user' ? (
            <div key={m.id} className="rounded-md bg-accent/60 px-3 py-2">
              <p className="mb-0.5 text-[11px] font-medium text-muted-foreground">你</p>
              <p className="whitespace-pre-wrap break-words text-sm leading-relaxed">{m.text}</p>
              {m.usage?.images && m.usage.images.length > 0 && (
                <p className="mt-1 text-[11px] text-muted-foreground">
                  附 {m.usage.images.length} 张截图（原图未持久化）
                </p>
              )}
            </div>
          ) : (
            <AnswerMessage key={m.id} message={m} onCite={onCite} invalidPaths={invalidPaths} />
          ),
        )}
      </div>

      {/* 错误状态：超时/取消/预算/AI 未配置/会话过期 */}
      {error && (
        <div className="flex items-start gap-1.5 rounded-md border border-amber-300 bg-amber-50 px-2.5 py-2 text-xs text-amber-800 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-200">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>{error.message}</span>
        </div>
      )}

      {/* 输入区 */}
      <div className="space-y-1.5">
        {images.length > 0 && (
          <div className="flex flex-wrap gap-1.5" data-testid="conv-images">
            {images.map((im, i) => (
              <span key={`${im.name ?? 'img'}-${i}`} className="relative inline-flex">
                <Image
                  src={`data:${im.mime};base64,${im.dataBase64}`}
                  alt={im.name ?? `截图 ${i + 1}`}
                  width={56}
                  height={56}
                  unoptimized
                  className="h-14 w-14 rounded-md border object-cover"
                />
                <button
                  type="button"
                  aria-label={`移除截图 ${i + 1}`}
                  className="absolute -right-1 -top-1 rounded-full border bg-background p-0.5"
                  onClick={() => setImages((prev) => prev.filter((_, j) => j !== i))}
                >
                  <X className="h-3 w-3" />
                </button>
              </span>
            ))}
          </div>
        )}
        <textarea
          data-testid="conv-input"
          aria-label="追问输入"
          value={input}
          rows={2}
          maxLength={MAX_QUESTION_LENGTH}
          placeholder="例如：这段输入经过净化了吗？（可 Ctrl+V 粘贴界面截图）"
          disabled={submitting}
          className="w-full resize-none rounded-md border bg-background px-2.5 py-2 text-sm outline-none focus:ring-1 focus:ring-primary disabled:opacity-60"
          onChange={(e) => setInput(e.target.value)}
          onPaste={(e) => {
            const files = Array.from(e.clipboardData.files).filter((f) => f.type.startsWith('image/'))
            if (files.length > 0) {
              e.preventDefault()
              addFiles(files)
            }
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault()
              void submit()
            }
          }}
        />
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-1.5">
            <input
              ref={fileInputRef}
              type="file"
              accept={IMAGE_MIME_TYPES.join(',')}
              multiple
              className="hidden"
              onChange={(e) => {
                if (e.target.files) addFiles(e.target.files)
                e.target.value = ''
              }}
            />
            <Button
              type="button"
              size="sm"
              variant="outline"
              data-testid="conv-attach"
              disabled={submitting || images.length >= MAX_IMAGES_PER_MESSAGE}
              onClick={() => fileInputRef.current?.click()}
            >
              <ImagePlus className="h-3.5 w-3.5" />
              截图
            </Button>
            <p className="text-[11px] text-muted-foreground">
              {input.trim().length}/{MAX_QUESTION_LENGTH}（Enter 提交，Shift+Enter 换行）
            </p>
          </div>
          <Button
            size="sm"
            data-testid="conv-submit"
            disabled={submitting || input.trim().length === 0 || input.trim().length > MAX_QUESTION_LENGTH}
            onClick={() => void submit()}
          >
            {submitting ? (
              <>
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                思考中（≤60s）
              </>
            ) : (
              <>
                <SendHorizontal className="h-3.5 w-3.5" />
                提问
              </>
            )}
          </Button>
        </div>
        <p className="text-[11px] text-muted-foreground">
          截图随问题发送给 AI 以理解界面问题（原图不落库）；请避免截取含密钥的区域。
        </p>
        {submitting && (
          <p className="text-[11px] text-muted-foreground">
            回答引用均经过证据校验；未读取的代码不会作为引用，超时已产生的问题会保留。
          </p>
        )}
      </div>
    </div>
  )
}

/* ---------------- 回答消息 ---------------- */

function AnswerMessage({
  message,
  onCite,
  invalidPaths,
}: {
  message: MessageRow
  onCite: (ref: { path: string; startLine: number; endLine: number }) => void
  invalidPaths: Set<string>
}) {
  const usage = message.usage
  const status = usage?.status
  return (
    <div className="rounded-md border px-3 py-2" data-testid="conv-answer">
      <div className="mb-1 flex flex-wrap items-center gap-1.5">
        <span className="text-[11px] font-medium text-muted-foreground">AI 回答</span>
        {usage && (
          <Badge variant={usage.provider === 'mock' ? 'warning' : 'ai'}>
            {usage.provider === 'mock' ? 'Mock（非真实模型）' : `模型 ${usage.modelId ?? ''}`}
          </Badge>
        )}
        {status === 'insufficient_evidence' && (
          <Badge variant="warning" className="gap-0.5">
            <ShieldQuestion className="h-3 w-3" />
            证据不足
          </Badge>
        )}
        {usage?.retrievalMode && (
          <Badge variant="outline" className="gap-0.5">
            <BookOpen className="h-3 w-3" />
            {RETRIEVAL_LABEL[usage.retrievalMode] ?? usage.retrievalMode}
          </Badge>
        )}
      </div>
      {status && STATUS_NOTE[status] && (
        <p className="mb-1 rounded bg-amber-500/10 px-2 py-1 text-xs text-amber-700 dark:text-amber-300">
          {STATUS_NOTE[status]}
        </p>
      )}
      <p className="whitespace-pre-wrap break-words text-sm leading-relaxed">{message.text}</p>

      {/* 引用：点击定位代码区；定位失败展示「证据无效/待核查」 */}
      {message.citations.length > 0 && (
        <div className="mt-2 space-y-1">
          <p className="text-[11px] font-medium text-muted-foreground">代码引用（点击定位）</p>
          <ul className="space-y-1">
            {message.citations.map((c, i) => {
              const key = `${message.id}:${i}`
              const invalid = invalidPaths.has(c.path)
              return (
                <li key={key}>
                  <button
                    data-testid="conv-citation"
                    className={`w-full rounded-md border px-2 py-1 text-left font-mono text-[11px] transition-colors hover:bg-accent ${
                      invalid ? 'border-amber-400 bg-amber-500/10 text-amber-800 dark:text-amber-300' : 'bg-background'
                    }`}
                    onClick={() => onCite(c)}
                  >
                    {c.path}:{c.startLine}-{c.endLine}
                    {invalid && <span className="ml-1 font-sans">（证据无效/待核查）</span>}
                  </button>
                </li>
              )
            })}
          </ul>
          <p className="text-[10px] text-muted-foreground">
            引用已通过快照行比对与读取覆盖校验；仅代表引用有效，不代表结论被证实。
          </p>
        </div>
      )}

      {/* 调用计数（不含内部思维链） */}
      {usage && (
        <p className="mt-1.5 text-[11px] text-muted-foreground">
          模型请求 {usage.modelCalls} 次 · 工具调用 {usage.toolCalls} 次
          {usage.retrievalMode ? ` · ${RETRIEVAL_LABEL[usage.retrievalMode] ?? usage.retrievalMode}` : ''}
          {usage.degradedReason ? ` · 降级：${usage.degradedReason}` : ''}
        </p>
      )}
    </div>
  )
}
