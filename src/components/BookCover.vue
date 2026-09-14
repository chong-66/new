<script setup lang="ts">
import { onMounted, ref, watch } from 'vue';
import { getCover } from '../engine/cover';

/** 封面图：走 Rust 侧请求规避防盗链与 CORS；失败显示首字占位 */
const props = defineProps<{
  url?: string;
  /** 防盗链 Referer，一般为书籍详情页 */
  referer?: string;
  name?: string;
}>();

const src = ref<string | null>(null);
const failed = ref(false);

async function load() {
  src.value = null;
  failed.value = false;
  if (!props.url) {
    failed.value = true;
    return;
  }
  const r = await getCover(props.url, props.referer);
  if (r) src.value = r;
  else failed.value = true;
}

onMounted(load);
watch(() => props.url, load);
</script>

<template>
  <div class="cover">
    <img v-if="src" :src="src" :alt="name" loading="lazy" @error="((failed = true), (src = null))" />
    <div v-else class="ph">{{ (name || '书').slice(0, 1) }}</div>
  </div>
</template>

<style scoped>
.cover {
  width: 100%;
  height: 100%;
  border-radius: 6px;
  overflow: hidden;
  background: var(--bg-soft);
}
img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}
.ph {
  width: 100%;
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 22px;
  font-weight: 600;
  color: var(--accent);
  background: linear-gradient(145deg, var(--accent-dim), transparent);
}
</style>
