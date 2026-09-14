<script setup lang="ts">
import { computed, ref } from 'vue';
import { useLibraryStore } from '../stores/library';
import { useSourcesStore } from '../stores/sources';
import { useUiStore } from '../stores/ui';
import type { Book } from '../types';
import BookCover from '../components/BookCover.vue';
import TxtImportDialog from './TxtImportDialog.vue';

const library = useLibraryStore();
const sources = useSourcesStore();
const ui = useUiStore();

const books = computed(() => library.sorted);
const showImport = ref(false);

function open(book: Book) {
  ui.openBook(book.id);
}

async function remove(book: Book, e: MouseEvent) {
  e.stopPropagation();
  if (!window.confirm(`从书架移除《${book.name}》？${book.origin === 'local-txt' ? ' 应用内保存的 TXT 正文也会删除，原文件不受影响。' : ''}`)) return;
  try {
    await library.remove(book.id);
  } catch (error) {
    ui.showToast(error instanceof Error ? error.message : '移除失败', 5000);
  }
}
</script>

<template>
  <div class="shelf">
    <div v-if="books.length" class="list">
    <div v-if="books.length" class="shelf-toolbar">
      <button class="btn" @click="showImport = true">导入 TXT</button>
    </div>
      <div v-for="b in books" :key="b.id" class="card" @click="open(b)">
        <div class="cover-wrap">
          <BookCover :url="b.coverUrl" :referer="b.bookUrl" :name="b.name" />
        </div>
        <div class="info">
          <div class="name-row">
            <span class="name">{{ b.name }}</span>
            <span v-if="b.unreadCount > 0" class="badge">{{ b.unreadCount > 99 ? '99+' : b.unreadCount }}</span>
          </div>
          <div class="meta">{{ b.author || '佚名' }} · {{ b.sourceName }}</div>
          <div class="latest">
            {{ b.totalChapters ? `共 ${b.totalChapters} 章` : '' }}
            {{ b.latestChapter ? `· ${b.latestChapter}` : b.intro }}
          </div>
        </div>
        <button class="del" title="移除" @click="remove(b, $event)">✕</button>
      </div>
    </div>

    <div v-else class="empty">
      <div class="icon">书</div>
      <p>书架还是空的</p>
      <div class="ops">
        <button class="btn primary" @click="ui.openSearch()">搜索添加</button>
        <button v-if="!sources.list.length" class="btn" @click="ui.openPanel('sources')">导入书源</button>
        <button class="btn" @click="showImport = true">导入 TXT</button>
      </div>
      <p v-if="!sources.list.length" class="hint">提示：需要先导入阅读 3.0 书源才能搜索</p>
    </div>
    <TxtImportDialog v-if="showImport" @close="showImport = false" />
  </div>
</template>

<style scoped>
.shelf {
  height: 100%;
  overflow-y: auto;
  padding: 10px 12px;
}
.shelf-toolbar {
  position: sticky; top: 0; z-index: 2;
  display: flex; justify-content: flex-end;
  padding-bottom: 6px;
  background: linear-gradient(var(--bg), transparent);
}
.card {
  display: flex;
  gap: 10px;
  padding: 8px;
  border-radius: 8px;
  cursor: pointer;
  position: relative;
  border: 1px solid transparent;
}
.card:hover {
  background: var(--bg-soft);
  border-color: var(--border);
}
.cover-wrap {
  width: 52px;
  height: 70px;
  flex: none;
}
.info {
  min-width: 0;
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 3px;
  justify-content: center;
}
.name-row {
  display: flex;
  align-items: center;
  gap: 6px;
}
.name {
  font-size: 14px;
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.badge {
  flex: none;
  min-width: 18px;
  height: 18px;
  padding: 0 5px;
  border-radius: 9px;
  background: var(--accent);
  color: #042f2a;
  font-size: 11px;
  font-weight: 700;
  display: flex;
  align-items: center;
  justify-content: center;
}
.meta {
  font-size: 12px;
  color: var(--text-dim);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.latest {
  font-size: 12px;
  color: var(--text-dim);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  opacity: 0.8;
}
.del {
  position: absolute;
  top: 6px;
  right: 6px;
  width: 22px;
  height: 22px;
  border-radius: 5px;
  font-size: 11px;
  color: var(--text-dim);
  opacity: 0;
  display: flex;
  align-items: center;
  justify-content: center;
}
.card:hover .del {
  opacity: 1;
}
.del:hover {
  background: var(--danger);
  color: #fff;
}
.empty {
  height: 100%;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 14px;
  color: var(--text-dim);
}
.icon {
  font-size: 42px;
}
.ops {
  display: flex;
  gap: 10px;
}
.hint {
  font-size: 12px;
  opacity: 0.7;
}
</style>
