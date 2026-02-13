<script lang="ts" setup>
import { ref, reactive } from 'vue'
import { ElButton, ElTooltip, ElIcon } from 'element-plus'
import { Operation, ChatDotRound } from '@element-plus/icons-vue'
import Graph from './graph.vue'
import Parameter from './parameter.vue'
import KgChatWindow from './components/KgChatWindow.vue'
import type { EntityInfo } from './utils/api'

const params = reactive({
  searchKeyword: '',
  selectedCategory: '',
  selectedDocId: '',
  showLabels: true,
  showEdges: true,
  nodeSize: 1,
  autoRotate: true,
  nodeStyle: 'style1'
})

const graphRef = ref<InstanceType<typeof Graph>>()
const showChat = ref(true)
const showParam = ref(true)
const chatPanelWidth = ref(400)

const handleParamUpdate = (newParams: typeof params) => {
  Object.assign(params, newParams)
}



const buildLayeredHighlight = (seedNodeIds: string[], maxDepth = 3) => {
  const edges = graphRef.value?.getEdges?.() ?? []
  const adjacency = new Map<string, Set<string>>()
  const edgeKeySet = new Set<string>()

  edges.forEach((edge) => {
    const sourceId = typeof edge.source === 'object' ? (edge.source as any).id : edge.source
    const targetId = typeof edge.target === 'object' ? (edge.target as any).id : edge.target
    if (!sourceId || !targetId) return

    if (!adjacency.has(sourceId)) adjacency.set(sourceId, new Set())
    if (!adjacency.has(targetId)) adjacency.set(targetId, new Set())
    adjacency.get(sourceId)?.add(targetId)
    adjacency.get(targetId)?.add(sourceId)

    const key = `${sourceId}-${targetId}`
    const reverseKey = `${targetId}-${sourceId}`
    edgeKeySet.add(key)
    edgeKeySet.add(reverseKey)
  })

  const visited = new Set<string>()
  const queue: Array<{ depth: number; id: string }> = []
  const layeredLinkIds: string[] = []

  const addLink = (from: string, to: string) => {
    const key = `${from}-${to}`
    const reverseKey = `${to}-${from}`
    if (edgeKeySet.has(key)) {
      layeredLinkIds.push(key)
    } else if (edgeKeySet.has(reverseKey)) {
      layeredLinkIds.push(reverseKey)
    }
  }

  seedNodeIds.forEach((id) => {
    visited.add(id)
    queue.push({ depth: 0, id })
  })

  while (queue.length > 0) {
    const current = queue.shift()!
    if (current.depth >= maxDepth) continue

    const neighbors = adjacency.get(current.id)
    if (!neighbors) continue

    neighbors.forEach((neighborId) => {
      if (visited.has(neighborId)) return
      visited.add(neighborId)
      addLink(current.id, neighborId)
      queue.push({ depth: current.depth + 1, id: neighborId })
    })
  }

  const layeredNodeIds = Array.from(visited)
  const uniqueLayeredLinkIds = Array.from(new Set(layeredLinkIds))

  return { layeredNodeIds, layeredLinkIds: uniqueLayeredLinkIds }
}



const buildFallbackEntitiesFromQuestion = (question: string): EntityInfo[] => {
  const q = question.toLowerCase();
  const candidates: Array<{ keywords: string[]; name: string; type: string }> = [
    { keywords: ['肺炎', '咳嗽', '发热', '呼吸'], name: '肺炎', type: 'DISEASE' },
    { keywords: ['ct', '影像', '检查'], name: 'CT 影像', type: 'PRODUCT' },
    { keywords: ['路径', '流程'], name: '临床路径', type: 'CONCEPT' },
    { keywords: ['检索', '多模态'], name: '多模态检索', type: 'CONCEPT' },
    { keywords: ['问答', '图谱'], name: '知识图谱问答', type: 'CONCEPT' },
  ];

  const result = candidates
    .filter((item) => item.keywords.some((keyword) => q.includes(keyword)))
    .map((item) => ({ name: item.name, type: item.type } as EntityInfo));

  return result.length ? result : ([
    { name: '知识图谱问答', type: 'CONCEPT' },
    { name: '多模态检索', type: 'CONCEPT' },
  ] as EntityInfo[]);
}

const handleRefresh = () => {
  graphRef.value?.fetchGraphData()
}

const handleReset = () => {
  graphRef.value?.handleReset()
}

// 处理实体选择（从对话中点击实体）
const handleSelectEntity = (entity: EntityInfo) => {
  // 在图谱中搜索该实体
  params.searchKeyword = entity.name
}

// 处理实体高亮（高亮全部按钮）
const handleHighlightEntities = (entities: EntityInfo[]) => {
  console.log('[KG Highlight Entities] 收到高亮请求:', entities)
  
  if (!entities || entities.length === 0) {
    console.warn('[KG Highlight Entities] 无实体数据')
    return
  }

  // 确保高亮节点不会被搜索/分类过滤掉
  params.searchKeyword = ''
  params.selectedCategory = ''

  // 使用 getNodes 方法获取节点列表
  const nodes = graphRef.value?.getNodes?.() ?? []
  console.log('[KG Highlight Entities] 当前图谱节点数:', nodes.length)

  // 优先使用 neo_id，匹配当前图谱的节点 id
  let targetNodeIds = entities
    .map(e => (e.neo_id !== undefined ? String(e.neo_id) : ''))
    .filter(id => id !== '')
    .filter(id => nodes.some(n => n.id === id))
  
  console.log('[KG Highlight Entities] neo_id 匹配结果:', targetNodeIds)

  // 若未匹配到，回退用实体名称匹配 label 或 id
  if (targetNodeIds.length === 0) {
    targetNodeIds = entities
      .map(e => {
        const hit = nodes.find(n => 
          n.label === e.name || 
          n.id === e.name ||
          n.label?.toLowerCase() === e.name?.toLowerCase()
        )
        return hit?.id
      })
      .filter((id): id is string => Boolean(id))
    console.log('[KG Highlight Entities] 名称匹配结果:', targetNodeIds)
  }

  // 如果仍未匹配到任何节点，则取消高亮
  if (!targetNodeIds.length) {
    console.warn('[KG Highlight Entities] 未匹配到任何节点，取消高亮')
    graphRef.value?.clearHighlight?.()
    return
  }

  console.log('[KG Highlight Entities] 执行层级高亮，核心节点:', targetNodeIds)
  const { layeredNodeIds, layeredLinkIds } = buildLayeredHighlight(targetNodeIds, 3)
  graphRef.value?.highlightElements(layeredNodeIds, layeredLinkIds, { seedNodeIds: targetNodeIds, maxDepth: 3 })
}

// 处理知识高亮（问答联动）
const handleHighlightKnowledge = (data: { entities: EntityInfo[]; relations: any[]; question?: string }) => {
  console.log('[KG Highlight] 收到高亮请求:', data)
  
  // 确保高亮节点不会被搜索/分类过滤掉
  params.searchKeyword = ''
  params.selectedCategory = ''

  // 使用 getNodes 方法获取节点列表
  const nodes = graphRef.value?.getNodes?.() ?? []
  console.log('[KG Highlight] 当前图谱节点数:', nodes.length, '示例:', nodes.slice(0, 3))

  let entities = data.entities || []
  if (!entities.length && data.question) {
    entities = buildFallbackEntitiesFromQuestion(data.question)
  }
  console.log('[KG Highlight] 待匹配实体:', entities)

  // 优先使用 neo_id，匹配当前图谱的节点 id
  let targetNodeIds = entities
    .map(e => (e.neo_id !== undefined ? String(e.neo_id) : ''))
    .filter(id => id !== '')
    .filter(id => nodes.some(n => n.id === id))
  
  console.log('[KG Highlight] neo_id 匹配结果:', targetNodeIds)

  // 若未匹配到，回退用实体名称匹配 label 或 id
  if (targetNodeIds.length === 0) {
    targetNodeIds = entities
      .map(e => {
        const hit = nodes.find(n => 
          n.label === e.name || 
          n.id === e.name ||
          n.label?.toLowerCase() === e.name?.toLowerCase()
        )
        return hit?.id
      })
      .filter((id): id is string => Boolean(id))
    console.log('[KG Highlight] 名称匹配结果:', targetNodeIds)
  }

  // 如果仍未匹配到任何节点，则取消高亮
  if (!targetNodeIds.length) {
    console.warn('[KG Highlight] 未匹配到任何节点，取消高亮')
    graphRef.value?.clearHighlight?.()
    return
  }

  console.log('[KG Highlight] 执行层级高亮，核心节点:', targetNodeIds)
  const { layeredNodeIds, layeredLinkIds } = buildLayeredHighlight(targetNodeIds, 3)
  graphRef.value?.highlightElements(layeredNodeIds, layeredLinkIds, { seedNodeIds: targetNodeIds, maxDepth: 3 })
}

</script>

<template>
  <div class="h-[calc(100vh-80.2px)] relative bg-[#0a0a0a] overflow-hidden">
    <!-- 中间：3D 图谱 (放在最底层，铺满全屏) -->
    <div class="absolute inset-0 min-w-0">
      <Graph 
        ref="graphRef"
        :search-keyword="params.searchKeyword"
        :selected-category="params.selectedCategory"
        :selected-doc-id="params.selectedDocId"
        :show-labels="params.showLabels"
        :show-edges="params.showEdges"
        :node-size="params.nodeSize"
        :auto-rotate="params.autoRotate"
        :node-style="params.nodeStyle"
      />
      
      <!-- 左上角：显示控制面板按钮 -->
      <div class="absolute top-4 left-4 z-10" v-if="!showParam">
        <ElTooltip content="显示控制面板" placement="right">
          <ElButton type="info" circle size="large" class="!bg-gray-800/80 !border-gray-700 !text-gray-200 hover:!bg-gray-700 backdrop-blur-md shadow-lg" @click="showParam = true">
            <el-icon class="text-xl"><Operation /></el-icon>
          </ElButton>
        </ElTooltip>
      </div>

      <!-- 右上角：显示问答助手按钮 -->
      <div class="absolute top-4 right-4 z-10" v-if="!showChat">
        <ElTooltip content="显示问答助手" placement="left">
          <ElButton type="primary" circle size="large" class="shadow-lg shadow-blue-900/20" @click="showChat = true">
            <el-icon class="text-xl"><ChatDotRound /></el-icon>
          </ElButton>
        </ElTooltip>
      </div>
    </div>

    <!-- 左侧：参数面板 (绝对定位覆盖在图谱上) -->
    <transition name="slide-left">
      <div v-show="showParam" class="absolute left-0 top-0 bottom-0 z-20 h-full shadow-2xl border-r border-gray-800/50 bg-transparent">
        <Parameter
          :model-value="params"
          @update:model-value="handleParamUpdate"
          @refresh="handleRefresh"
          @reset="handleReset"
          @close="showParam = false"
        />
      </div>
    </transition>

    <!-- 右侧：对话面板 (绝对定位覆盖在图谱上) -->
    <transition name="slide-right">
      <div
        v-show="showChat"
        class="absolute right-0 top-0 bottom-0 z-20 h-full shadow-2xl border-l border-gray-800/50 bg-transparent"
        :style="{ width: chatPanelWidth + 'px' }"
      >
        <KgChatWindow
          v-model:doc-id="params.selectedDocId"
          @select-entity="handleSelectEntity"
          @highlight-entities="handleHighlightEntities"
          @highlight-knowledge="handleHighlightKnowledge"
          @close="showChat = false"
        />
      </div>
    </transition>
  </div>
</template>

<style scoped>
:deep(html), :deep(body) {
  margin: 0;
  padding: 0;
  overflow: hidden;
}

.slide-left-enter-active,
.slide-left-leave-active {
  transition: all 0.4s cubic-bezier(0.25, 0.8, 0.25, 1);
  width: 20rem;
  opacity: 1;
  overflow: hidden;
}

.slide-left-enter-from,
.slide-left-leave-to {
  width: 0;
  opacity: 0;
  transform: translateX(-20px);
}

.slide-right-enter-active,
.slide-right-leave-active {
  transition: all 0.4s cubic-bezier(0.25, 0.8, 0.25, 1);
  opacity: 1;
  overflow: hidden;
}

.slide-right-enter-from,
.slide-right-leave-to {
  width: 0 !important;
  opacity: 0;
  transform: translateX(20px);
}
</style>
