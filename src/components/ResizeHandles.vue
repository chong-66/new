<script setup lang="ts">
import { onMounted, onUnmounted, ref } from 'vue';
import { isTauri } from '../utils/env';
import { setInteracting } from '../composables/useWindowBehavior';

/** 八向缩放手柄：无边框透明窗口无法用系统边框缩放，沿边缘放置热区 */
type Dir =
  | 'North'
  | 'South'
  | 'East'
  | 'West'
  | 'NorthEast'
  | 'NorthWest'
  | 'SouthEast'
  | 'SouthWest';

const handles: { dir: Dir; cls: string; cursor: string }[] = [
  { dir: 'North', cls: 'n', cursor: 'ns-resize' },
  { dir: 'South', cls: 's', cursor: 'ns-resize' },
  { dir: 'East', cls: 'e', cursor: 'ew-resize' },
  { dir: 'West', cls: 'w', cursor: 'ew-resize' },
  { dir: 'NorthEast', cls: 'ne', cursor: 'nesw-resize' },
  { dir: 'NorthWest', cls: 'nw', cursor: 'nwse-resize' },
  { dir: 'SouthEast', cls: 'se', cursor: 'nwse-resize' },
  { dir: 'SouthWest', cls: 'sw', cursor: 'nesw-resize' },
];

const EDGE = 5;
const CORNER = 12;
const show = ref(isTauri);

let ResizeDirection: Record<string, Dir> | null = null;
onMounted(async () => {
  if (!isTauri) return;
  const m = await import('@tauri-apps/api/window');
  ResizeDirection = m.ResizeDirection as unknown as Record<string, Dir>;
});

async function onDown(dir: Dir, e: MouseEvent) {
  if (e.button !== 0) return;
  e.preventDefault();
  setInteracting(true);
  const up = () => {
    setInteracting(false);
    window.removeEventListener('mouseup', up);
  };
  window.addEventListener('mouseup', up);
  const { getCurrentWindow } = await import('@tauri-apps/api/window');
  const d = (ResizeDirection?.[dir] ?? dir) as never;
  getCurrentWindow()
    .startResizeDragging(d)
    .catch(() => setInteracting(false));
}

onUnmounted(() => setInteracting(false));
</script>

<template>
  <template v-if="show">
    <div
      v-for="h in handles"
      :key="h.dir"
      class="rz"
      :class="h.cls"
      :style="{ cursor: h.cursor }"
      @mousedown="onDown(h.dir, $event)"
    />
  </template>
</template>

<style scoped>
.rz {
  position: fixed;
  z-index: 999;
}
.n {
  top: 0;
  left: v-bind('CORNER + "px"');
  right: v-bind('CORNER + "px"');
  height: v-bind('EDGE + "px"');
}
.s {
  bottom: 0;
  left: v-bind('CORNER + "px"');
  right: v-bind('CORNER + "px"');
  height: v-bind('EDGE + "px"');
}
.e {
  top: v-bind('CORNER + "px"');
  bottom: v-bind('CORNER + "px"');
  right: 0;
  width: v-bind('EDGE + "px"');
}
.w {
  top: v-bind('CORNER + "px"');
  bottom: v-bind('CORNER + "px"');
  left: 0;
  width: v-bind('EDGE + "px"');
}
.ne,
.nw,
.se,
.sw {
  width: v-bind('CORNER + "px"');
  height: v-bind('CORNER + "px"');
}
.ne {
  top: 0;
  right: 0;
}
.nw {
  top: 0;
  left: 0;
}
.se {
  bottom: 0;
  right: 0;
}
.sw {
  bottom: 0;
  left: 0;
}
</style>
