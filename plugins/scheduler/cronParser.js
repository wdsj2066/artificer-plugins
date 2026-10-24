/**
 * 轻量 cron 表达式解析器（5 字段：分 时 日 月 周）
 *
 * 支持语法：
 *   *          任意值
 *   *\/n       每 n 个单位（如 *\/5 表示每 5 个）
 *   a-b        范围
 *   a-b\/n     范围内每 n 个单位
 *   a,b,c      枚举
 *   数字       具体值
 *
 * 字段范围：
 *   分钟 0-59 | 小时 0-23 | 日 1-31 | 月 1-12 | 周 0-7（0 与 7 均表示周日）
 *
 * 日/周语义遵循标准 cron：两个字段同时限定（均非 *）时，满足其一即匹配；
 * 只限定一个时，仅按该字段匹配。
 */

export const FIELD_NAMES = ['minute', 'hour', 'dayOfMonth', 'month', 'dayOfWeek']

export const FIELD_RANGES = {
  minute: [0, 59],
  hour: [0, 23],
  dayOfMonth: [1, 31],
  month: [1, 12],
  dayOfWeek: [0, 7]
}

/** 解析单个字段段（如 "*"、"*\/15"、"1-5"、"1-30\/5"、"1,3,5"） */
function parseSegment(segment, min, max) {
  const text = segment.trim()
  if (!text) throw new Error(`cron 字段段为空`)

  let rangeStart = min
  let rangeEnd = max
  let step = 1
  let body = text

  // 提取步长 /n
  const stepMatch = text.match(/^(.*?)\/(\d+)$/)
  if (stepMatch) {
    body = stepMatch[1]
    step = parseInt(stepMatch[2], 10)
    if (step < 1) throw new Error(`非法步长: ${stepMatch[2]}`)
  }

  if (body === '*') {
    // 整段范围
  } else if (/^\d+$/.test(body)) {
    const v = parseInt(body, 10)
    rangeStart = rangeEnd = v
  } else if (/^\d+-\d+$/.test(body)) {
    const [a, b] = body.split('-').map(Number)
    rangeStart = a
    rangeEnd = b
  } else {
    throw new Error(`无法识别的 cron 字段段: "${segment}"`)
  }

  if (rangeStart < min || rangeEnd > max || rangeStart > rangeEnd) {
    throw new Error(`cron 字段值超出范围 [${min}-${max}]: "${segment}"`)
  }

  const values = new Set()
  for (let v = rangeStart; v <= rangeEnd; v += step) values.add(v)
  // 仅无步长的 "*" 视为"未指定"；"*/n" 是明确的每 n 个单位的限定
  return { values, all: body === '*' && step === 1 }
}

/** 解析完整 cron 表达式，返回结构化字段 */
export function parseCron(expr) {
  if (typeof expr !== 'string' || !expr.trim()) {
    throw new Error(`cron 表达式不能为空`)
  }
  const fields = expr.trim().split(/\s+/)
  if (fields.length !== 5) {
    throw new Error(`cron 表达式必须为 5 段（分 时 日 月 周），实际 ${fields.length} 段: "${expr}"`)
  }

  const parsed = {}
  for (let i = 0; i < 5; i++) {
    const name = FIELD_NAMES[i]
    const [min, max] = FIELD_RANGES[name]
    // 字段内按逗号枚举拆分为多个段，合并结果
    const segments = fields[i].split(',').map(s => s.trim())
    const values = new Set()
    let all = segments.length === 1
    for (const seg of segments) {
      if (!seg) throw new Error(`cron 字段包含空段: "${fields[i]}"`)
      const r = parseSegment(seg, min, max)
      for (const v of r.values) values.add(v)
      if (!r.all) all = false
    }
    if (name === 'dayOfWeek') {
      // 7 归一化为 0（周日）；保留 0 本身
      if (values.has(7)) values.add(0)
      values.delete(7)
    }
    parsed[name] = { values, all }
  }
  return parsed
}

/** 判断给定时刻是否匹配已解析的 cron */
const FORMATTERS = new Map()

function getCronDate(date, timeZone) {
  if (!timeZone) return date
  let formatter = FORMATTERS.get(timeZone)
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone, hourCycle: 'h23', weekday: 'short', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric'
    })
    FORMATTERS.set(timeZone, formatter)
  }
  const parts = Object.fromEntries(formatter.formatToParts(date).map(part => [part.type, part.value]))
  const weekDays = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }
  return {
    getMinutes: () => Number(parts.minute),
    getHours: () => Number(parts.hour),
    getDate: () => Number(parts.day),
    getMonth: () => Number(parts.month) - 1,
    getDay: () => weekDays[parts.weekday]
  }
}

export function matchesCron(parsed, date, timeZone = null) {
  const cronDate = getCronDate(date, timeZone)
  const minute = cronDate.getMinutes()
  const hour = cronDate.getHours()
  const day = cronDate.getDate()
  const month = cronDate.getMonth() + 1
  const dow = cronDate.getDay() // 0=周日 ... 6=周六

  if (!parsed.minute.values.has(minute)) return false
  if (!parsed.hour.values.has(hour)) return false
  if (!parsed.month.values.has(month)) return false

  const daySpecified = !parsed.dayOfMonth.all
  const dowSpecified = !parsed.dayOfWeek.all

  if (daySpecified && dowSpecified) {
    // 标准 cron：日与周取并集
    if (!parsed.dayOfMonth.values.has(day) && !parsed.dayOfWeek.values.has(dow)) return false
  } else if (daySpecified) {
    if (!parsed.dayOfMonth.values.has(day)) return false
  } else if (dowSpecified) {
    if (!parsed.dayOfWeek.values.has(dow)) return false
  }
  return true
}

const MAX_SEARCH_MINUTES = 60 * 24 * 366 // 最多向后搜索 1 年

/**
 * 计算 from 之后的下一次匹配时刻（不含 from 本身）
 * @returns {Date|null} 找不到（超出搜索范围）时返回 null
 */
export function nextAfter(parsed, from, timeZone = null) {
  const d = new Date(from)
  d.setSeconds(0, 0)
  d.setMilliseconds(0)
  d.setMinutes(d.getMinutes() + 1)

  for (let i = 0; i < MAX_SEARCH_MINUTES; i++) {
    if (matchesCron(parsed, d, timeZone)) return new Date(d.getTime())
    d.setMinutes(d.getMinutes() + 1)
  }
  return null
}
