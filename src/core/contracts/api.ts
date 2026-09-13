/** 统一 API 错误格式：{error:{code,message,requestId}}（规格 11） */
export const API_ERROR_CODES = {
  UNAUTHORIZED: 'unauthorized',
  FORBIDDEN: 'forbidden',
  NOT_FOUND: 'not_found',
  INVALID_REQUEST: 'invalid_request',
  RATE_LIMITED: 'rate_limited',
  CONFLICT: 'conflict',
  PAYLOAD_TOO_LARGE: 'payload_too_large',
  UNSUPPORTED_MEDIA_TYPE: 'unsupported_media_type',
  INTERNAL: 'internal_error',
  AI_UNAVAILABLE: 'ai_unavailable',
  BUDGET_EXCEEDED: 'budget_exceeded',
  /** R05 追问：单请求/整轮超时（504） */
  TIMEOUT: 'timeout',
  /** R05 追问：请求被取消（409） */
  CANCELLED: 'cancelled',
} as const

export type ApiErrorCode = (typeof API_ERROR_CODES)[keyof typeof API_ERROR_CODES]

export interface ApiErrorBody {
  error: {
    code: ApiErrorCode
    message: string
    requestId: string
  }
}

export function makeApiErrorBody(
  code: ApiErrorCode,
  message: string,
  requestId: string,
): ApiErrorBody {
  return { error: { code, message, requestId } }
}

export interface CursorList<T> {
  items: T[]
  nextCursor: string | null
}

export const DEFAULT_PAGE_SIZE = 20
export const MAX_PAGE_SIZE = 100
