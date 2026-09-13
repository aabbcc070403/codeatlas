import type { RedactedRange } from '@/server/db/schema'

/**
 * 等长脱敏（规格 8）：疑似密钥在持久化/向量化/外发前以 * 遮盖，
 * 保持长度与换行位置。启发式无法保证发现所有秘密。
 */

export interface RedactResult {
  content: string
  ranges: RedactedRange[]
  maskedCount: number
}

/** 敏感文件名：直接拒绝收录（不进入快照） */
const SENSITIVE_FILE_RE =
  /(^|\/)(\.env(\..+)?|\.npmrc|\.netrc|id_rsa[^/]*|credentials\.(json|ya?ml)|.*\.(pem|p12|pfx|key))$/i

export function isSensitiveFilePath(path: string): boolean {
  return SENSITIVE_FILE_RE.test(path)
}

const VALUE_ASSIGN_RE =
  /((?:api[_-]?key|apikey|secret|token|access[_-]?key|private[_-]?key|password|passwd|pwd|auth[_-]?token|client[_-]?secret)\b\s*[:=]\s*)(['"])([^'"\n]{8,512})\2/gi

const KNOWN_TOKEN_RES: RegExp[] = [
  /AKIA[0-9A-Z]{16}/g, // AWS Access Key
  /\bgh[pousr]_[A-Za-z0-9]{20,255}/g, // GitHub
  /\bsk-[A-Za-z0-9_-]{20,255}/g, // OpenAI 风格
  /AIza[0-9A-Za-z_-]{35}/g, // Google
  /\bxox[baprs]-[0-9A-Za-z-]{10,255}/g, // Slack
  /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, // JWT
]

const PRIVATE_KEY_BEGIN = '-----BEGIN '
const PRIVATE_KEY_END = '-----END '

export function redactSecrets(content: string): RedactResult {
  const lines = content.split('\n')
  const ranges: RedactedRange[] = []
  let maskedCount = 0
  let inPrivateKey = false

  for (let i = 0; i < lines.length; i++) {
    let line = lines[i]!

    // PEM 私钥块：整块遮盖
    if (line.includes(PRIVATE_KEY_BEGIN) && /PRIVATE KEY-----/.test(line)) {
      inPrivateKey = true
    }
    if (inPrivateKey) {
      const masked = '*'.repeat(line.length)
      if (masked.length > 0) {
        ranges.push({ line: i + 1, start: 0, end: line.length })
        maskedCount++
      }
      lines[i] = masked
      if (line.includes(PRIVATE_KEY_END)) inPrivateKey = false
      continue
    }

    // 赋值形式：key = "value" / key: 'value'（单趟收集，倒序等长应用）
    const masks: Array<{ start: number; len: number }> = []
    let match: RegExpExecArray | null
    VALUE_ASSIGN_RE.lastIndex = 0
    while ((match = VALUE_ASSIGN_RE.exec(line)) !== null) {
      const prefix = match[1]!
      const value = match[3]!
      masks.push({ start: match.index + prefix.length + 1, len: value.length })
    }
    for (let mi = masks.length - 1; mi >= 0; mi--) {
      const mask = masks[mi]!
      line = line.slice(0, mask.start) + '*'.repeat(mask.len) + line.slice(mask.start + mask.len)
      ranges.push({ line: i + 1, start: mask.start, end: mask.start + mask.len })
      maskedCount++
    }

    // 已知 token 形态（单趟收集，倒序等长应用，跳过已遮盖区间）
    for (const re of KNOWN_TOKEN_RES) {
      const tokenMasks: Array<{ start: number; len: number }> = []
      re.lastIndex = 0
      let m: RegExpExecArray | null
      while ((m = re.exec(line)) !== null) {
        tokenMasks.push({ start: m.index, len: m[0].length })
      }
      for (let mi = tokenMasks.length - 1; mi >= 0; mi--) {
        const mask = tokenMasks[mi]!
        const overlaps = ranges.some(
          (r) =>
            r.line === i + 1 &&
            mask.start < r.end &&
            r.start < mask.start + mask.len,
        )
        if (overlaps) continue
        line = line.slice(0, mask.start) + '*'.repeat(mask.len) + line.slice(mask.start + mask.len)
        ranges.push({ line: i + 1, start: mask.start, end: mask.start + mask.len })
        maskedCount++
      }
    }
    lines[i] = line
  }

  return { content: lines.join('\n'), ranges, maskedCount }
}
