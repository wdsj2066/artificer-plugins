<template>
  <slot />
  <Teleport v-if="ready" defer to=".skills-view .mgmt-toolbar-right">
    <n-button size="medium" style="order: -1" @click="open">
      <template #icon>
        <Store :size="16" />
      </template>
      Skill 市场
    </n-button>
  </Teleport>
</template>

<script setup>
import { inject, onMounted, onUnmounted, ref } from 'vue'
import { NButton } from 'naive-ui'
import { Store } from 'lucide-vue-next'

const api = inject('artificer', null)
const ready = ref(false)
let timer

function checkTarget() {
  ready.value = Boolean(document.querySelector('.skills-view .mgmt-toolbar-right'))
}

async function open() {
  try {
    const module = await import('./MarketDialog.vue')
    api?.openModal?.({ title: 'Skill 市场', component: module.default, width: 880 })
  } catch (error) {
    api?.toast?.(`市场窗口加载失败: ${error.message}`, 'error')
  }
}

onMounted(() => {
  checkTarget()
  timer = window.setInterval(checkTarget, 300)
})

onUnmounted(() => {
  if (timer) window.clearInterval(timer)
})
</script>
