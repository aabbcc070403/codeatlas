'use client'

import { useEffect, useRef, useState } from 'react'

/**
 * 扫描事件订阅（规格 11 / R02-C）：
 * - 首选 EventSource 连接 SSE，显式保存最后事件 ID；
 * - 连续失败后降级为 GET 轮询：2 秒起步，逐次退避至最多 10 秒；
 * - 降级期间每 10 秒尝试重建 SSE（携带 cursor 续传），恢复后停止轮询；
 * - 终态（done）后排空并关闭；卸载时清理全部连接与定时器。
 * 返回当前连接模式供 UI 标注（真实状态，不伪造实时性）。
 */

export type ScanEventMode = 'connecting' | 'sse' | 'polling'

/** 服务端会推送的全部事件类型（含协议事件） */
const EVENT_TYPES = [
  'scan.started',
  'stage.started',
  'stage.completed',
  'finding.created',
  'finding.invalid',
  'tool.completed',
  'scan.finished',
  'error',
] as const

const POLL_MIN_MS = 2000
const POLL_MAX_MS = 10000
const RECONNECT_MS = 10000
/** onerror 连续失败达到该次数才降级（浏览器会自动重连并续带 Last-Event-ID） */
const SSE_ERROR_THRESHOLD = 3

export function useScanEvents(
  scanId: string,
  options: { enabled: boolean; onRefresh: () => void },
): ScanEventMode {
  const { enabled } = options
  const [mode, setMode] = useState<ScanEventMode>('connecting')
  const onRefreshRef = useRef(options.onRefresh)
  onRefreshRef.current = options.onRefresh

  useEffect(() => {
    if (!enabled) {
      setMode('connecting')
      return
    }
    let disposed = false
    let es: EventSource | null = null
    let pollTimer: ReturnType<typeof setTimeout> | null = null
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null
    let errorResetTimer: ReturnType<typeof setTimeout> | null = null
    let errorCount = 0
    let pollDelay = POLL_MIN_MS
    let lastEventId = ''

    const clearPollTimer = () => {
      if (pollTimer !== null) {
        clearTimeout(pollTimer)
        pollTimer = null
      }
    }
    const clearReconnectTimer = () => {
      if (reconnectTimer !== null) {
        clearTimeout(reconnectTimer)
        reconnectTimer = null
      }
    }
    const clearErrorResetTimer = () => {
      if (errorResetTimer !== null) {
        clearTimeout(errorResetTimer)
        errorResetTimer = null
      }
    }

    const stopPolling = () => {
      pollDelay = POLL_MIN_MS
      clearPollTimer()
      clearReconnectTimer()
    }

    const schedulePoll = () => {
      if (disposed || pollTimer !== null) return
      pollTimer = setTimeout(() => {
        pollTimer = null
        onRefreshRef.current()
        pollDelay = Math.min(pollDelay * 2, POLL_MAX_MS)
        schedulePoll()
      }, pollDelay)
    }

    const startPolling = (resetBackoff = true) => {
      if (disposed) return
      setMode('polling')
      if (resetBackoff) pollDelay = POLL_MIN_MS
      clearPollTimer()
      schedulePoll()
    }

    const handleEvent = (ev: Event) => {
      const id = (ev as MessageEvent).lastEventId
      if (id) lastEventId = id
      errorCount = 0
      setMode('sse')
      stopPolling()
      onRefreshRef.current()
    }

    const connect = (): EventSource => {
      const url = lastEventId
        ? `/api/scans/${scanId}/events?cursor=${encodeURIComponent(lastEventId)}`
        : `/api/scans/${scanId}/events`
      const conn = new EventSource(url)
      for (const t of EVENT_TYPES) {
        conn.addEventListener(t, handleEvent)
      }
      conn.addEventListener('connected', () => {
        errorCount = 0
        setMode('sse')
        stopPolling()
      })
      // 终态事件排空后服务端主动关闭：最后一次刷新并停止本地订阅
      conn.addEventListener('done', () => {
        stopPolling()
        onRefreshRef.current()
        conn.close()
      })
      conn.onerror = () => {
        if (disposed) return
        errorCount++
        if (errorResetTimer !== null) clearTimeout(errorResetTimer)
        errorResetTimer = setTimeout(() => {
          errorCount = 0
        }, 5000)
        // 浏览器会自动重连并续带 Last-Event-ID；连续失败才降级轮询。
        // 降级后（恢复尝试失败）保留已有轮询退避，不重新高频轮询。
        if (errorCount >= SSE_ERROR_THRESHOLD) {
          const wasPolling = reconnectTimer !== null || pollTimer !== null
          conn.close()
          if (es === conn) es = null
          startPolling(!wasPolling)
          clearReconnectTimer()
          reconnectTimer = setTimeout(
            () => {
              if (disposed || es !== null) return
              // 尝试恢复 SSE：成功（connected/任意事件）会停止轮询
              es = connect()
            },
            RECONNECT_MS,
          )
        }
      }
      return conn
    }

    try {
      es = connect()
    } catch {
      // EventSource 不可用（极端环境）：直接轮询
      startPolling()
    }

    return () => {
      disposed = true
      es?.close()
      clearPollTimer()
      clearReconnectTimer()
      clearErrorResetTimer()
    }
  }, [scanId, enabled])

  return mode
}
