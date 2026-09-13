import { createHash } from 'node:crypto'

/**
 * Markdown 切块（规格 9.4）：按标题与段落切块，每块约 400–800 中文字符，
 * 跨块重叠至多 80 字符；保留标题、起止行与内容哈希。纯函数。
 */

export interface MarkdownChunk {
  text: string
  heading: string
  startLine: number
  endLine: number
  contentHash: string
}

const TARGET_MIN = 400
const TARGET_MAX = 800
const OVERLAP = 80

export function chunkMarkdown(content: string): MarkdownChunk[] {
  const lines = content.split('\n')
  const chunks: MarkdownChunk[] = []

  let carry = '' // 上一块结尾 ≤80 字符，作为下一块开头重叠
  let bufText = ''
  let bufHeading = ''
  let bufStart = 0
  let bufEnd = 0

  const flush = (force: boolean): void => {
    const merged = (carry + bufText).trim()
    if (bufText.trim() === '' || merged === '') {
      if (force) {
        bufText = ''
        bufHeading = ''
      }
      return
    }
    if (force || merged.length >= TARGET_MIN) {
      chunks.push({
        text: merged,
        heading: bufHeading,
        startLine: bufStart,
        endLine: bufEnd,
        contentHash: createHash('sha256').update(merged).digest('hex'),
      })
      carry = bufText.slice(-OVERLAP)
      bufText = ''
      bufHeading = ''
    }
  }

  let heading = ''
  let i = 0
  while (i < lines.length) {
    const line = lines[i]!
    const headingMatch = line.match(/^(#{1,6})\s+(.*)$/)
    if (headingMatch) {
      heading = headingMatch[2]!.trim()
      i++
      continue
    }
    // 收集一个段落（连续非空行，遇到空行或新标题结束）
    const paraLines: string[] = []
    const startLine = i + 1
    while (i < lines.length && lines[i]!.trim() !== '' && !/^#{1,6}\s+/.test(lines[i]!)) {
      paraLines.push(lines[i]!)
      i++
    }
    const para = paraLines.join('\n').trim()
    if (para === '') {
      i++
      continue
    }
    if (bufText === '') {
      bufStart = startLine
      bufHeading = heading
    }
    bufEnd = startLine + paraLines.length - 1

    if (para.length > TARGET_MAX) {
      // 超长段落：先刷出缓冲，再按字符切分（保持重叠）
      flush(true)
      let rest = para
      while (rest.length > TARGET_MAX) {
        const piece = (carry + rest).slice(0, TARGET_MAX)
        chunks.push({
          text: piece,
          heading,
          startLine: bufStart,
          endLine: startLine + paraLines.length - 1,
          contentHash: createHash('sha256').update(piece).digest('hex'),
        })
        carry = piece.slice(-OVERLAP)
        rest = rest.slice(TARGET_MAX - OVERLAP)
      }
      bufText = rest
      bufHeading = heading
      bufStart = startLine
      bufEnd = startLine + paraLines.length - 1
    } else {
      bufText = bufText === '' ? para : bufText + '\n\n' + para
      flush(false)
    }
  }
  flush(true)
  return chunks
}
