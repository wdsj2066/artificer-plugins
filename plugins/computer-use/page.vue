<template>
  <div class="mc-page">
    <header class="mc-head">
      <div class="mc-title">
        <h2>电脑操作</h2>
        <p>让 AI 直接操作这台电脑。开始接管后屏幕四角显示蓝色渐变提示，随时可按 Esc 键夺回控制。</p>
      </div>
      <button class="mc-btn ghost" :disabled="busy" @click="refresh">刷新状态</button>
    </header>

    <section class="mc-guard" :class="{ on: controlling }">
      <div class="mc-guard-main">
        <span class="mc-dot"></span>
        <strong>{{ controlling ? '接管中' : '未接管' }}</strong>
        <span class="mc-guard-tip">
          {{ controlling
            ? '屏幕四角已显示接管标记；按 Esc 键即可立即夺回鼠标，Esc 仍会正常传给前台程序'
            : '未接管时所有鼠标动作都会被拒绝，避免光标被悄悄控制' }}
        </span>
      </div>
      <div class="mc-row">
        <button class="mc-btn" :disabled="busy || controlling" @click="beginControl">开始接管</button>
        <button class="mc-btn ghost" :disabled="busy || !controlling" @click="endControl">结束接管</button>
      </div>
    </section>

    <section class="mc-status">
      <div class="mc-cell">
        <span>屏幕</span>
        <strong>{{ status.screen }}</strong>
      </div>
      <div class="mc-cell">
        <span>光标</span>
        <strong>{{ status.cursor }}</strong>
      </div>
      <div class="mc-cell">
        <span>DPI 感知</span>
        <strong>{{ status.dpi }}</strong>
      </div>
    </section>

    <section class="mc-card">
      <h3>定位与点击</h3>
      <div class="mc-row">
        <label class="mc-field">X<input v-model.number="point.x" type="number" min="0" /></label>
        <label class="mc-field">Y<input v-model.number="point.y" type="number" min="0" /></label>
        <button class="mc-btn" :disabled="busy" @click="moveTo">移动</button>
        <button class="mc-btn ghost" :disabled="busy" @click="useCurrent">取当前</button>
      </div>
      <div class="mc-row">
        <button class="mc-btn" :disabled="busy" @click="doClick('left', 1)">左键单击</button>
        <button class="mc-btn" :disabled="busy" @click="doClick('right', 1)">右键单击</button>
        <button class="mc-btn" :disabled="busy" @click="doClick('middle', 1)">中键</button>
        <button class="mc-btn" :disabled="busy" @click="doClick('left', 2)">双击</button>
      </div>
      <p class="mc-hint">坐标按屏幕物理像素计（与屏幕快照图片像素一致）。点击会先移动到该坐标再按下。</p>
    </section>

    <section class="mc-card">
      <h3>滚轮</h3>
      <div class="mc-row">
        <button class="mc-btn" :disabled="busy" @click="doScroll(240)">向上滚</button>
        <button class="mc-btn" :disabled="busy" @click="doScroll(-240)">向下滚</button>
        <label class="mc-field">次数<input v-model.number="scrollTimes" type="number" min="1" /></label>
      </div>
    </section>

    <section class="mc-card">
      <h3>拖拽</h3>
      <div class="mc-row">
        <label class="mc-field">起点X<input v-model.number="drag.fromX" type="number" /></label>
        <label class="mc-field">起点Y<input v-model.number="drag.fromY" type="number" /></label>
        <label class="mc-field">终点X<input v-model.number="drag.toX" type="number" /></label>
        <label class="mc-field">终点Y<input v-model.number="drag.toY" type="number" /></label>
        <button class="mc-btn" :disabled="busy" @click="doDrag">执行拖拽</button>
      </div>
      <p class="mc-hint">拖拽会按住左键并分步移动，适合拖动窗口、选中文本或拉动滑块。</p>
    </section>

    <section class="mc-card">
      <h3>操作日志</h3>
      <ul v-if="logs.length" class="mc-logs">
        <li v-for="(item, i) in logs" :key="i" :class="item.level">
          <span class="mc-time">{{ item.time }}</span>{{ item.text }}
        </li>
      </ul>
      <p v-else class="mc-hint">暂无操作记录。</p>
    </section>
  </div>
</template>

<script setup>
import { onMounted, reactive, ref } from 'vue'

const ENDPOINT = '/api/plugins/computer-use/action'

const busy = ref(false)
const controlling = ref(false)
const point = reactive({ x: null, y: null })
const drag = reactive({ fromX: null, fromY: null, toX: null, toY: null })
const scrollTimes = ref(1)
const status = reactive({ screen: '-', cursor: '-', dpi: '-' })
const logs = ref([])

function log(text, level = 'ok') {
  const time = new Date().toLocaleTimeString()
  logs.value.unshift({ time, text, level })
  if (logs.value.length > 20) logs.value.length = 20
}

function applyStatus(data) {
  if (!data) return
  if (Number.isFinite(data.cursorX) && Number.isFinite(data.cursorY)) {
    status.cursor = data.cursorX + ', ' + data.cursorY
  }
  if (Number.isFinite(data.screenWidth) && Number.isFinite(data.screenHeight)) {
    status.screen = data.screenWidth + ' x ' + data.screenHeight
  }
  if (data.dpiAwareness) status.dpi = data.dpiAwareness
}

async function call(action, params) {
  busy.value = true
  try {
    const res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(Object.assign({ action }, params || {}))
    })
    const json = await res.json().catch(() => ({}))
    const data = json && json.data ? json.data : json
    if (!data || data.success === false) {
      log(action + ' 失败：' + ((data && data.error) || '未知错误'), 'error')
      return null
    }
    applyStatus(data)
    return data
  } catch (e) {
    log(action + ' 请求失败：' + e.message, 'error')
    return null
  } finally {
    busy.value = false
  }
}

function validPoint() {
  return Number.isFinite(point.x) && Number.isFinite(point.y)
}

async function refresh() {
  const data = await call('probe')
  if (data) {
    if (typeof data.controlling === 'boolean') controlling.value = data.controlling
    log('已刷新屏幕与光标状态')
  }
}

async function beginControl() {
  const data = await call('beginControl', {})
  if (data && data.controlling) {
    controlling.value = true
    log('已开始接管，屏幕顶部出现提示条')
  }
}

async function endControl() {
  const data = await call('endControl', {})
  if (data) {
    controlling.value = false
    log('已结束接管，提示条已关闭')
  }
}

function useCurrent() {
  const parts = String(status.cursor).split(',')
  const x = Number(parts[0])
  const y = Number(parts[1])
  if (Number.isFinite(x) && Number.isFinite(y)) {
    point.x = x
    point.y = y
    log('已填入当前光标坐标 ' + x + ', ' + y)
  } else {
    log('当前坐标未知，先刷新状态', 'error')
  }
}

async function moveTo() {
  if (!validPoint()) {
    log('请填写 X 和 Y 坐标', 'error')
    return
  }
  const data = await call('move', { x: point.x, y: point.y })
  if (data) log('已移动到 ' + point.x + ', ' + point.y)
}

async function doClick(button, clicks) {
  if (!validPoint()) {
    log('请填写 X 和 Y 坐标', 'error')
    return
  }
  const data = await call('click', { x: point.x, y: point.y, button, clicks })
  if (data) log(button + ' 键点击 ' + clicks + ' 次 @ ' + point.x + ', ' + point.y)
}

async function doScroll(delta) {
  const params = { delta, times: scrollTimes.value || 1 }
  if (validPoint()) {
    params.x = point.x
    params.y = point.y
  }
  const data = await call('scroll', params)
  if (data) log('滚轮 ' + (delta > 0 ? '向上' : '向下') + ' ' + params.times + ' 次')
}

async function doDrag() {
  const ok = [drag.fromX, drag.fromY, drag.toX, drag.toY].every((v) => Number.isFinite(v))
  if (!ok) {
    log('请填写完整的拖拽起点与终点', 'error')
    return
  }
  const data = await call('drag', {
    x: drag.fromX,
    y: drag.fromY,
    toX: drag.toX,
    toY: drag.toY,
    durationMs: 700
  })
  if (data) log('已从 ' + drag.fromX + ',' + drag.fromY + ' 拖到 ' + drag.toX + ',' + drag.toY)
}

onMounted(() => {
  refresh()
})
</script>

<style scoped>
.mc-page {
  display: flex;
  flex-direction: column;
  gap: 14px;
  padding: 20px 24px 32px;
  max-width: 880px;
  color: inherit;
  font-size: 13px;
}

.mc-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
}

.mc-title h2 {
  margin: 0 0 6px;
  font-size: 18px;
  font-weight: 600;
}

.mc-title p {
  margin: 0;
  font-size: 12px;
  opacity: 0.65;
  line-height: 1.6;
}

.mc-guard {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 14px 16px;
  border-radius: 12px;
  border: 1px solid rgba(200, 120, 60, 0.35);
  background: rgba(200, 120, 60, 0.08);
}

.mc-guard.on {
  border-color: rgba(230, 170, 60, 0.65);
  background: rgba(230, 170, 60, 0.14);
}

.mc-guard-main {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.mc-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: rgba(127, 127, 127, 0.55);
  flex: none;
}

.mc-guard.on .mc-dot {
  background: #ffb648;
  box-shadow: 0 0 0 3px rgba(255, 182, 72, 0.22);
}

.mc-guard-tip {
  font-size: 12px;
  opacity: 0.7;
  line-height: 1.5;
}

.mc-status {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
  gap: 10px;
}

.mc-cell {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 10px 12px;
  border-radius: 10px;
  border: 1px solid rgba(127, 127, 127, 0.22);
  background: rgba(127, 127, 127, 0.07);
}

.mc-cell span {
  font-size: 11px;
  opacity: 0.6;
  letter-spacing: 0.02em;
}

.mc-cell strong {
  font-size: 14px;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
}

.mc-card {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 14px 16px;
  border-radius: 12px;
  border: 1px solid rgba(127, 127, 127, 0.2);
  background: rgba(127, 127, 127, 0.05);
}

.mc-card h3 {
  margin: 0;
  font-size: 13px;
  font-weight: 600;
  opacity: 0.85;
}

.mc-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}

.mc-field {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  opacity: 0.8;
}

.mc-field input {
  width: 78px;
  padding: 5px 8px;
  border-radius: 7px;
  border: 1px solid rgba(127, 127, 127, 0.3);
  background: rgba(127, 127, 127, 0.08);
  color: inherit;
  font-size: 12px;
  font-variant-numeric: tabular-nums;
}

.mc-field input:focus {
  outline: 2px solid rgba(120, 170, 255, 0.45);
  outline-offset: 1px;
}

.mc-btn {
  padding: 6px 12px;
  border-radius: 7px;
  border: 1px solid rgba(127, 127, 127, 0.28);
  background: rgba(120, 170, 255, 0.16);
  color: inherit;
  font-size: 12px;
  cursor: pointer;
  transition: background 0.15s ease, border-color 0.15s ease;
}

.mc-btn:hover:not(:disabled) {
  background: rgba(120, 170, 255, 0.28);
  border-color: rgba(120, 170, 255, 0.5);
}

.mc-btn:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}

.mc-btn.ghost {
  background: transparent;
}

.mc-hint {
  margin: 0;
  font-size: 11px;
  opacity: 0.55;
  line-height: 1.6;
}

.mc-logs {
  margin: 0;
  padding: 0;
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: 6px;
  max-height: 220px;
  overflow: auto;
}

.mc-logs li {
  display: flex;
  gap: 10px;
  font-size: 12px;
  font-variant-numeric: tabular-nums;
}

.mc-logs li.error {
  color: #ff8080;
}

.mc-time {
  opacity: 0.45;
  flex: none;
}
</style>
