import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, extname, join, resolve, sep } from 'node:path'

const API_BASE = 'https://api.skillhub.cn'
const CACHE_TTL = 5 * 60 * 1000
const MAX_SKILL_BYTES = 512 * 1024
const MAX_PACKAGE_FILES = 64
const MAX_FILE_BYTES = 256 * 1024
const MAX_TOTAL_BYTES = 2 * 1024 * 1024
const SECTIONS = new Set(['hot', 'trending', 'recommended'])
const TEXT_EXTENSIONS = new Set([
  '.md', '.js', '.mjs', '.cjs', '.ts', '.json', '.txt', '.yaml', '.yml', '.toml',
  '.py', '.sh', '.ps1', '.bat', '.cmd', '.sql', '.csv', '.html', '.css', '.xml', '.ini', '.cfg'
])
const cache = new Map()

function normalizeSection(value) {
  return SECTIONS.has(value) ? value : 'trending'
}

let activeApiKey = ''

function readApiKey(ctx) {
  try {
    const value = ctx.getSettings?.()?.apiKey
    return typeof value === 'string' ? value.trim() : ''
  } catch {
    return ''
  }
}

function authHeaders(extra = {}) {
  const key = activeApiKey
  return key ? { ...extra, authorization: `Bearer ${key}` } : extra
}

async function request(url, timeoutMs = 20000, extraHeaders = {}) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    return await fetch(url, {
      signal: controller.signal,
      headers: { accept: '*/*', 'user-agent': 'Artificer-SkillHub-Market/1.0' }
    })
  } finally {
    clearTimeout(timer)
  }
}

async function readJson(url, extraHeaders = {}) {
  const response = await request(url, 20000, extraHeaders)
  if (!response.ok) throw new Error(`SkillHub 返回 ${response.status}`)
  return await response.json()
}

function stripQuotes(value) {
  const text = String(value || '').trim()
  if (text.length >= 2 && ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'")))) {
    return text.slice(1, -1)
  }
  return text
}

/**
 * 解析 SKILL.md 的 YAML frontmatter。只处理常见标量、块标量（| / >）与列表，
 * 不引入 YAML 依赖：安装只需要 name/displayName/description/tags 等字段。
 */
function parseFrontMatter(text) {
  const match = /^\uFEFF?---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text)
  if (!match) return { meta: {}, body: text.trim() }

  const lines = match[1].split(/\r?\n/)
  const meta = {}
  let index = 0

  while (index < lines.length) {
    const line = lines[index]
    const pair = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(line)
    if (!pair) {
      index += 1
      continue
    }

    const key = pair[1]
    const rawValue = pair[2].trim()

    if (/^[|>][+-]?$/.test(rawValue)) {
      const collected = []
      let next = index + 1
      while (next < lines.length && (/^\s/.test(lines[next]) || lines[next].trim() === '')) {
        collected.push(lines[next].replace(/^\s{1,4}/, ''))
        next += 1
      }
      const joiner = rawValue.startsWith('>') ? ' ' : '\n'
      meta[key] = collected.join(joiner).trim()
      index = next
      continue
    }

    if (!rawValue) {
      const items = []
      let next = index + 1
      while (next < lines.length && /^\s*-\s+/.test(lines[next])) {
        items.push(stripQuotes(lines[next].replace(/^\s*-\s+/, '')))
        next += 1
      }
      if (items.length > 0) {
        meta[key] = items
        index = next
        continue
      }
    }

    meta[key] = stripQuotes(rawValue)
    index += 1
  }

  return { meta, body: text.slice(match[0].length).trim() }
}

function normalizeTags(raw) {
  const values = Array.isArray(raw) ? raw : parseInlineList(raw)
  return values
    .map(item => String(item).trim())
    .filter(Boolean)
    .slice(0, 8)
}

function parseInlineList(raw) {
  if (!raw) return []
  const inner = raw.startsWith('[') && raw.endsWith(']') ? raw.slice(1, -1) : raw
  return inner.split(',').map(item => stripQuotes(item))
}

function clip(value, max) {
  const text = String(value || '').replace(/\s+/g, ' ').trim()
  return text.length > max ? `${text.slice(0, max)}…` : text
}

function pickSkill(item) {
  return {
    slug: item.slug || '',
    name: item.name || item.slug || '',
    description: item.description_zh || item.description || '',
    tags: Array.isArray(item.tags) ? item.tags.slice(0, 6).map(String) : [],
    category: item.category || '',
    downloads: Number(item.downloads) || 0,
    stars: Number(item.stars) || 0,
    version: item.version || '',
    iconUrl: item.iconUrl || '',
    publisher: item.publisher?.name || item.ownerName || '',
    verified: Boolean(item.publisher?.verified),
    namespace: item.namespace?.handle || ''
  }
}

function safeSegment(value, pattern) {
  const text = String(value || '').trim()
  return pattern.test(text) ? text : ''
}

function getUserSkillsDir() {
  const platform = process.platform
  if (platform === 'win32') return join(homedir(), 'AppData', 'Roaming', 'Artificer', 'skill')
  if (platform === 'darwin') return join(homedir(), 'Library', 'Application Support', 'Artificer', 'skill')
  return join(homedir(), '.artificer', 'skill')
}

/** 规范化包内路径：只允许相对路径，禁止越界与目录穿越。 */
function normalizePackagePath(value) {
  const raw = String(value || '').replace(/\\/g, '/').replace(/^\.\//, '')
  if (!raw || raw.startsWith('/') || /^[a-zA-Z]:/.test(raw)) return ''
  const parts = raw.split('/')
  if (parts.some(part => !part || part === '.' || part === '..')) return ''
  return parts.join('/')
}

function isInside(parent, candidate) {
  const base = resolve(parent)
  const target = resolve(candidate)
  return target === base || target.startsWith(base + sep)
}

function resolveRegisteredId(entryText, dirName) {
  const match = /^\uFEFF?---\r?\n([\s\S]*?)\r?\n---/.exec(entryText)
  if (!match) return dirName
  const idLine = /^id\s*:\s*(.+)$/m.exec(match[1])
  if (!idLine) return dirName
  const id = stripQuotes(idLine[1])
  return /^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(id) ? id : dirName
}

async function installPackage(slug, namespace, extraHeaders = {}) {
  const dirName = `skillhub-${slug}`
  const skillRoot = getUserSkillsDir()
  const targetDir = join(skillRoot, dirName)

  if (existsSync(targetDir)) throw new Error(`技能已安装: ${dirName}`)

  const params = new URLSearchParams()
  if (namespace) params.set('namespace', namespace)
  const listQuery = params.toString()
  const list = await readJson(`${API_BASE}/api/v1/skills/${encodeURIComponent(slug)}/files${listQuery ? `?${listQuery}` : ''}`, extraHeaders)
  const entries = Array.isArray(list.files) ? list.files : []
  if (entries.length === 0) throw new Error('技能包为空')
  if (entries.length > MAX_PACKAGE_FILES) throw new Error(`技能包文件数超过 ${MAX_PACKAGE_FILES}，已拒绝`)

  const planned = []
  const skipped = []
  let declaredTotal = 0
  for (const entry of entries) {
    const path = normalizePackagePath(entry?.path)
    if (!path) {
      skipped.push(String(entry?.path || ''))
      continue
    }
    if (!TEXT_EXTENSIONS.has(extname(path).toLowerCase())) {
      skipped.push(path)
      continue
    }
    const size = Number(entry?.size) || 0
    if (size > MAX_FILE_BYTES) throw new Error(`文件过大: ${path}`)
    declaredTotal += size
    if (declaredTotal > MAX_TOTAL_BYTES) throw new Error('技能包总大小超过 2MB，已拒绝')
    planned.push({ path, size, sha256: typeof entry?.sha256 === 'string' ? entry.sha256.toLowerCase() : '' })
  }

  if (!planned.some(item => item.path.toLowerCase() === 'skill.md')) {
    throw new Error('技能包缺少 SKILL.md 入口')
  }

  const written = []
  let totalBytes = 0
  try {
    for (const item of planned) {
      const fileParams = new URLSearchParams({ path: item.path })
      if (namespace) fileParams.set('namespace', namespace)
      const response = await request(`${API_BASE}/api/v1/skills/${encodeURIComponent(slug)}/file?${fileParams.toString()}`, 20000, extraHeaders)
      if (!response.ok) throw new Error(`下载 ${item.path} 失败（${response.status}）`)
      const buffer = Buffer.from(await response.arrayBuffer())
      if (buffer.length > MAX_FILE_BYTES) throw new Error(`文件过大: ${item.path}`)
      totalBytes += buffer.length
      if (totalBytes > MAX_TOTAL_BYTES) throw new Error('技能包总大小超过 2MB，已拒绝')
      if (item.sha256 && createHash('sha256').update(buffer).digest('hex') !== item.sha256) {
        throw new Error(`文件校验失败: ${item.path}`)
      }

      const targetPath = resolve(targetDir, item.path)
      if (!isInside(targetDir, targetPath)) throw new Error(`文件路径越界: ${item.path}`)
      await mkdir(dirname(targetPath), { recursive: true })
      await writeFile(targetPath, buffer)
      written.push(item.path)
    }

    const entryPath = written.find(path => path.toLowerCase() === 'skill.md')
    const entryText = await readFile(resolve(targetDir, entryPath), 'utf-8')

    return {
      success: true,
      id: dirName,
      registeredId: resolveRegisteredId(entryText, dirName),
      skillDir: targetDir,
      files: written,
      skipped,
      bytes: totalBytes
    }
  } catch (error) {
    await rm(targetDir, { recursive: true, force: true })
    throw error
  }
}

export function register(ctx) {
  activeApiKey = readApiKey(ctx)
  ctx.registerRoute({
    method: 'GET',
    path: '/api/plugins/skillhub-market/status',
    handler() {
      return { success: true, pings }
    }
  })
  ctx.registerRoute({
    method: 'GET',
    path: '/api/plugins/skillhub-market/list',
    async handler({ query }) {
      const page = Math.max(1, Number(query?.page) || 1)
      const pageSize = Math.min(50, Math.max(1, Number(query?.pageSize) || 20))
      const keyword = String(query?.keyword || '').trim().slice(0, 80)
      const sortBy = ['downloads', 'stars', 'updated_at', 'created_at', 'score'].includes(String(query?.sortBy))
        ? String(query.sortBy)
        : 'downloads'
      const order = String(query?.order) === 'asc' ? 'asc' : 'desc'

      const params = new URLSearchParams({
        page: String(page),
        pageSize: String(pageSize),
        sortBy,
        order
      })
      if (keyword) params.set('keyword', keyword)

      const cacheKey = params.toString()
      const cached = cache.get(cacheKey)
      if (cached && Date.now() - cached.at < CACHE_TTL) {
        return { success: true, ...cached.data, cached: true }
      }

      try {
        const data = await readJson(`${API_BASE}/api/skills?${cacheKey}`, authHeaders())
        const skills = (Array.isArray(data?.data?.skills) ? data.data.skills : []).map(pickSkill).filter(item => item.slug)
        const total = Number(data?.data?.total) || skills.length
        const payload = { page, pageSize, total, totalPages: Math.max(1, Math.ceil(total / pageSize)), skills, keyword, sortBy, order }
        cache.set(cacheKey, { at: Date.now(), data: payload })
        return { success: true, ...payload }
      } catch (error) {
        if (cached) return { success: true, ...cached.data, stale: true }
        return { success: false, error: `读取 SkillHub 失败: ${error.message}` }
      }
    }
  })

  ctx.registerRoute({
    method: 'GET',
    path: '/api/plugins/skillhub-market/content',
    async handler({ query }) {
      const slug = safeSegment(query?.slug, /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/)
      const namespace = safeSegment(query?.namespace, /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/)
      if (!slug) return { success: false, error: '技能 slug 无效' }
      if (query?.namespace && !namespace) return { success: false, error: '技能 namespace 无效' }

      const params = new URLSearchParams({ path: 'SKILL.md' })
      if (namespace) params.set('namespace', namespace)
      try {
        const response = await request(`${API_BASE}/api/v1/skills/${encodeURIComponent(slug)}/file?${params.toString()}`, 20000, authHeaders())
        if (!response.ok) return { success: false, error: `读取 SKILL.md 失败（${response.status}）` }
        const content = await response.text()
        if (!content.trim()) return { success: false, error: 'SKILL.md 内容为空' }
        if (Buffer.byteLength(content, 'utf-8') > MAX_SKILL_BYTES) {
          return { success: false, error: 'SKILL.md 超过 512KB，已拒绝安装' }
        }

        const { meta, body } = parseFrontMatter(content)
        return {
          success: true,
          slug,
          namespace,
          name: clip(meta.displayName || meta.name || slug, 120),
          description: clip(meta.description || meta.summary || '', 600),
          tags: normalizeTags(meta.tags),
          body: body || content.trim()
        }
      } catch (error) {
        return { success: false, error: `下载失败: ${error.message}` }
      }
    }
  })

  ctx.registerRoute({
    method: 'POST',
    path: '/api/plugins/skillhub-market/install',
    async handler({ body }) {
      const slug = safeSegment(body?.slug, /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/)
      const namespace = safeSegment(body?.namespace, /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/)
      if (!slug) return { success: false, error: '技能 slug 无效' }
      if (body?.namespace && !namespace) return { success: false, error: '技能 namespace 无效' }
      try {
        return await installPackage(slug, namespace, authHeaders())
      } catch (error) {
        return { success: false, error: error.message || '安装失败' }
      }
    }
  })

  ctx.registerRoute({
    method: 'GET',
    path: '/api/plugins/skillhub-market/auth-state',
    handler() {
      const key = readApiKey(ctx)
      return { success: true, hasKey: Boolean(key) }
    }
  })
}