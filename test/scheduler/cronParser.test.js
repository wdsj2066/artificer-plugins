/**
 * scheduler/cronParser.test.js - cron 表达式解析与下一次匹配计算
 */
import { describe, it, expect } from 'vitest'
import { parseCron, matchesCron, nextAfter } from '../../plugins/scheduler/cronParser.js'

function localDate(y, mo, d, h, mi) {
  return new Date(y, mo - 1, d, h, mi, 0, 0)
}

describe('parseCron', () => {
  it('解析标准 5 字段表达式', () => {
    const p = parseCron('*/5 * * * *')
    expect(p.minute.values.has(0)).toBe(true)
    expect(p.minute.values.has(5)).toBe(true)
    expect(p.minute.values.has(59)).toBe(false)
    expect(p.minute.all).toBe(false)
    expect(p.hour.all).toBe(true)
  })

  it('解析范围与枚举', () => {
    const p = parseCron('0 9-11 1,15 * 1-5')
    expect(p.hour.values.has(9)).toBe(true)
    expect(p.hour.values.has(11)).toBe(true)
    expect(p.hour.values.has(12)).toBe(false)
    expect(p.dayOfMonth.values.has(1)).toBe(true)
    expect(p.dayOfMonth.values.has(15)).toBe(true)
    expect(p.dayOfMonth.values.has(2)).toBe(false)
    expect(p.dayOfWeek.values.has(1)).toBe(true)
    expect(p.dayOfWeek.values.has(5)).toBe(true)
    expect(p.dayOfWeek.values.has(6)).toBe(false)
  })

  it('周字段 7 归一化为 0（周日）', () => {
    const p = parseCron('0 0 * * 7')
    expect(p.dayOfWeek.values.has(0)).toBe(true)
    expect(p.dayOfWeek.values.has(7)).toBe(false)
  })

  it('非法表达式抛错：段数不足', () => {
    expect(() => parseCron('*/5 * * *')).toThrow()
  })

  it('非法表达式抛错：值超范围', () => {
    expect(() => parseCron('60 * * * *')).toThrow()
    expect(() => parseCron('0 25 * * *')).toThrow()
  })

  it('非法表达式抛错：无法识别字符', () => {
    expect(() => parseCron('x * * * *')).toThrow()
  })

  it('非法表达式抛错：空字符串', () => {
    expect(() => parseCron('')).toThrow()
    expect(() => parseCron('   ')).toThrow()
  })
})

describe('nextAfter', () => {
  it('每 5 分钟：从 10:03 起的下一次是 10:05', () => {
    const p = parseCron('*/5 * * * *')
    const from = localDate(2026, 9, 8, 10, 3)
    const next = nextAfter(p, from)
    expect(next.getHours()).toBe(10)
    expect(next.getMinutes()).toBe(5)
  })

  it('每 5 分钟：从 10:05 整点起（不含本身）下一次是 10:10', () => {
    const p = parseCron('*/5 * * * *')
    const from = localDate(2026, 9, 8, 10, 5)
    const next = nextAfter(p, from)
    expect(next.getHours()).toBe(10)
    expect(next.getMinutes()).toBe(10)
  })

  it('每天 9 点：从 10:00 起下一次是次日 9:00', () => {
    const p = parseCron('0 9 * * *')
    const from = localDate(2026, 9, 8, 10, 0)
    const next = nextAfter(p, from)
    expect(next.getDate()).toBe(9)
    expect(next.getHours()).toBe(9)
    expect(next.getMinutes()).toBe(0)
  })

  it('日与周同时限定取并集（每月 1 日或每周一）', () => {
    const p = parseCron('0 0 1 * 1')
    // 2026-09-08 是周二；2026-09-01 是周二（即每月 1 日）
    const from = localDate(2026, 9, 1, 0, 0)
    const next = nextAfter(p, from)
    // 下一次应命中 2026-09-07（周一）
    expect(next.getDate()).toBe(7)
    expect(next.getDay()).toBe(1)
  })

  it('仅限定周字段：只按周匹配', () => {
    const p = parseCron('0 12 * * 1')
    const from = localDate(2026, 9, 8, 0, 0) // 周二
    const next = nextAfter(p, from)
    // 下一次应为 2026-09-14（周一）12:00
    expect(next.getDate()).toBe(14)
    expect(next.getHours()).toBe(12)
  })

  it('边界月份与年末跨年', () => {
    const p = parseCron('0 0 1 * *') // 每月 1 日 0 点
    const from = localDate(2026, 12, 15, 0, 0)
    const next = nextAfter(p, from)
    expect(next.getFullYear()).toBe(2027)
    expect(next.getMonth()).toBe(0) // 1 月
    expect(next.getDate()).toBe(1)
  })
})

describe('matchesCron', () => {
  it('整点分钟匹配', () => {
    const p = parseCron('0 9 * * *')
    expect(matchesCron(p, localDate(2026, 9, 8, 9, 0))).toBe(true)
    expect(matchesCron(p, localDate(2026, 9, 8, 9, 1))).toBe(false)
    expect(matchesCron(p, localDate(2026, 9, 8, 10, 0))).toBe(false)
  })

  it('按指定时区匹配，而不是宿主机本地时区', () => {
    const p = parseCron('0 8 * * *')
    // 00:00 UTC 即北京时间 08:00
    expect(matchesCron(p, new Date('2026-09-08T00:00:00.000Z'), 'Asia/Shanghai')).toBe(true)
  })
})
