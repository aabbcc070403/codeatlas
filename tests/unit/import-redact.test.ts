import { describe, it, expect } from 'vitest'
import { redactSecrets, isSensitiveFilePath } from '../../src/core/import/redact'

describe('等长脱敏', () => {
  it('赋值形式的密钥被等长遮盖并记录区间', () => {
    const code = 'const apiKey = "sk-abcdef1234567890abcd";\nconsole.log(1);\n'
    const r = redactSecrets(code)
    expect(r.content).toBe('const apiKey = "' + '*'.repeat(23) + '";\nconsole.log(1);\n')
    expect(r.content.length).toBe(code.length)
    expect(r.ranges).toEqual([{ line: 1, start: 16, end: 39 }])
    expect(r.maskedCount).toBe(1)
  })

  it('已知 token 形态被遮盖（AKIA/ghp_/JWT）', () => {
    const code = [
      'const aws = "AKIAIOSFODNN7EXAMPLE";',
      'const gh = "ghp_abcdefghijklmnopqrstuvwxyz123456";',
      'const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U";',
    ].join('\n')
    const r = redactSecrets(code)
    expect(r.content).not.toContain('AKIAIOSFODNN7EXAMPLE')
    expect(r.content).not.toContain('ghp_')
    expect(r.content).not.toContain('eyJhbGciOiJIUzI1NiJ9')
    // 等长
    r.content.split('\n').forEach((line, i) => {
      expect(line.length).toBe(code.split('\n')[i]!.length)
    })
  })

  it('PEM 私钥整块遮盖', () => {
    const code = [
      '-----BEGIN RSA PRIVATE KEY-----',
      'MIIEpAIBAAKCAQEA7x1a',
      '-----END RSA PRIVATE KEY-----',
      'const x = 1;',
    ].join('\n')
    const r = redactSecrets(code)
    expect(r.content).not.toContain('MIIEpA')
    expect(r.content).toContain('const x = 1;')
    // 换行位置不变
    expect(r.content.split('\n').length).toBe(4)
  })

  it('普通代码不受影响', () => {
    const code = 'const name = "hello";\nexport function f(a) { return a + 1 }\n'
    const r = redactSecrets(code)
    expect(r.content).toBe(code)
    expect(r.ranges).toEqual([])
  })

  it('换行与字符位置保持（遮盖不改长度）', () => {
    const code = 'a\npassword = "supersecret123"\nb'
    const r = redactSecrets(code)
    expect(r.content.length).toBe(code.length)
    expect(r.content.split('\n').length).toBe(3)
    expect(r.ranges[0]!.line).toBe(2)
  })

  it('敏感文件路径识别', () => {
    expect(isSensitiveFilePath('.env')).toBe(true)
    expect(isSensitiveFilePath('config/.env.production')).toBe(true)
    expect(isSensitiveFilePath('certs/server.pem')).toBe(true)
    expect(isSensitiveFilePath('keys/id_rsa')).toBe(true)
    expect(isSensitiveFilePath('home/.npmrc')).toBe(true)
    expect(isSensitiveFilePath('src/config.ts')).toBe(false)
    expect(isSensitiveFilePath('README.md')).toBe(false)
  })
})
