<template>
	<div class="relative w-full h-full">
		<div
			ref="containerRef"
			class="graph-container"
			:class="{ 'cursor-wait': loading }"
		></div>
		
		<!-- Loading Overlay -->
		<Transition name="fade">
			<div 
				v-if="loading" 
				class="absolute inset-0 z-50 flex flex-col items-center justify-center bg-gray-900/90 backdrop-blur-md"
			>
				<!-- Tech Spinner -->
				<div class="loading-spinner mb-6">
					<div class="spinner-ring ring-1"></div>
					<div class="spinner-ring ring-2"></div>
					<div class="spinner-core"></div>
				</div>
				<div class="text-cyan-400 text-sm font-medium tracking-wider animate-pulse">正在构建知识图谱...</div>
			</div>
		</Transition>
	</div>
</template>

<script lang="ts" setup>
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { ElMessage, ElIcon } from 'element-plus'
import { Loading } from '@element-plus/icons-vue'
import ForceGraph3D, {
	type ForceGraph3DInstance,
	type LinkObject,
	type NodeObject
} from '3d-force-graph'
import SpriteText from 'three-spritetext'
import * as THREE from 'three'
import { nodeStyleDefinitions } from './style.vue'

// Pipe Shader Definitions
const pipeVertexShader = `
varying vec2 vUv;
void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`

const pipeFragmentShader = `
uniform vec3 color;
uniform float progress;
varying vec2 vUv;
void main() {
    // vUv.y goes from 0 to 1 along the height of the cylinder
    // We want to fill from one end (0) to the other (1).
    if (vUv.y > progress) {
        discard;
    }
    // Simple shading
    gl_FragColor = vec4(color, 0.8); 
}
`

// Use the imported THREE instance
let threeLib = THREE
let pendingRefresh = false
let particleSystem: any = null
let particleAnimationId: number | null = null
let particleSetupScheduled = false
let particleAutoRotateActive = true
let currentAnimationId = 0

// 图谱数据缓存（使用 sessionStorage）
const GRAPH_CACHE_KEY = 'kg_graph_cache'
const GRAPH_CACHE_EXPIRY = 5 * 60 * 1000 // 5 分钟缓存有效期

interface GraphCacheEntry {
	data: VisualizerData
	docId: string | undefined
	timestamp: number
}

function getGraphCache(docId: string | undefined): VisualizerData | null {
	try {
		const cached = sessionStorage.getItem(GRAPH_CACHE_KEY)
		if (!cached) return null
		
		const entry: GraphCacheEntry = JSON.parse(cached)
		const now = Date.now()
		
		// 检查是否过期
		if (now - entry.timestamp > GRAPH_CACHE_EXPIRY) {
			sessionStorage.removeItem(GRAPH_CACHE_KEY)
			return null
		}
		
		// 检查 docId 是否匹配
		if (entry.docId !== docId) {
			return null
		}
		
		console.log('[Graph Cache] 命中缓存，跳过网络请求')
		return entry.data
	} catch (e) {
		console.warn('[Graph Cache] 读取缓存失败:', e)
		return null
	}
}

function setGraphCache(data: VisualizerData, docId: string | undefined): void {
	try {
		const entry: GraphCacheEntry = {
			data,
			docId,
			timestamp: Date.now()
		}
		sessionStorage.setItem(GRAPH_CACHE_KEY, JSON.stringify(entry))
		console.log('[Graph Cache] 数据已缓存')
	} catch (e) {
		console.warn('[Graph Cache] 写入缓存失败:', e)
	}
}

function clearGraphCache(): void {
	sessionStorage.removeItem(GRAPH_CACHE_KEY)
	console.log('[Graph Cache] 缓存已清除')
}

// 高亮状态
const highlightedNodeIds = ref<Set<string>>(new Set())
const highlightedLinkIds = ref<Set<string>>(new Set())
const isHighlightActive = computed(() => highlightedNodeIds.value.size > 0 || highlightedLinkIds.value.size > 0)

// 高亮时保存的原始位置（用于恢复）
const originalNodePositions = ref<Map<string, { x: number; y: number; z: number }>>(new Map())
const isAnimating = ref(false)

// 动画过程中的透明度因子 (0 -> 1)
const nodeOpacityFactor = ref<Map<string, number>>(new Map())
const linkOpacityFactor = ref<Map<string, number>>(new Map())

function ensureThree() {
	return threeLib
}

function scheduleNodeRefresh() {
	if (pendingRefresh || !graphInstance) return
	pendingRefresh = true
	requestAnimationFrame(() => {
		pendingRefresh = false
		if (!graphInstance) return
		refreshNodeAppearance()
	})
}

interface GraphNode extends NodeObject {
	id: string
	label: string
	value: number
	category: string
}

interface GraphEdge extends LinkObject<GraphNode> {
	source: string
	target: string
	label: string
	description?: string
	value: number
	properties?: Record<string, any>
}

interface HighlightOptions {
	seedNodeIds?: string[]
	maxDepth?: number
}

interface VisualizerData {
	nodes: GraphNode[]
	edges: GraphEdge[]
}

function toPlainObject(value: unknown): Record<string, any> | null {
	if (value && typeof value === 'object' && !Array.isArray(value)) {
		return value as Record<string, any>
	}
	return null
}

function pickFromContainers(source: Record<string, any>, keys: string[]): unknown {
	for (const key of keys) {
		if (key in source && source[key] !== undefined && source[key] !== null) {
			return source[key]
		}
		const lowerKey = key.toLowerCase()
		if (lowerKey in source && source[lowerKey] !== undefined && source[lowerKey] !== null) {
			return source[lowerKey]
		}
		const upperKey = key.toUpperCase()
		if (upperKey in source && source[upperKey] !== undefined && source[upperKey] !== null) {
			return source[upperKey]
		}
	}
	for (const containerKey of ['properties', 'props', 'attributes', 'data']) {
		const container = toPlainObject(source[containerKey])
		if (!container) continue
		const candidate = pickFromContainers(container, keys)
		if (candidate !== undefined) {
			return candidate
		}
	}
	return undefined
}

function resolveNodeId(rawNode: Record<string, any>, fallbackIndex: number): string {
	const idCandidate = pickFromContainers(rawNode, ['id', 'neo_id', 'neoId', 'elementId', 'ID', 'Id', 'identity', 'uuid', 'nodeId'])
	if (typeof idCandidate === 'string' && idCandidate.trim() !== '') {
		return idCandidate
	}
	if (typeof idCandidate === 'number') {
		return String(idCandidate)
	}
	return `node-${fallbackIndex}`
}

function resolveNodeLabel(rawNode: Record<string, any>, fallbackId: string): string {
	const labelCandidate = pickFromContainers(rawNode, ['label', 'name', 'title', 'text'])
	if (typeof labelCandidate === 'string' && labelCandidate.trim() !== '') {
		return labelCandidate
	}
	return fallbackId
}

function resolveNodeCategory(rawNode: Record<string, any>): string {
	// 优先从 properties.type 获取（这是 Neo4j 实体的真实类型）
	const props = rawNode.properties || rawNode.props || rawNode.data
	if (props && typeof props === 'object') {
		const typeValue = props.type || props.category || props.kind
		if (typeof typeValue === 'string' && typeValue.trim() !== '') {
			return typeValue.toUpperCase()
		}
	}
	
	// 其次尝试直接属性
	const directType = rawNode.type || rawNode.kind
	if (typeof directType === 'string' && directType.trim() !== '' && directType !== 'Entity') {
		return directType.toUpperCase()
	}
	
	// 再尝试 category（但过滤掉 'Entity' 这种通用标签）
	const category = rawNode.category
	if (typeof category === 'string' && category.trim() !== '' && category !== 'Entity') {
		return category.toUpperCase()
	}
	
	// 最后尝试 labels
	if (Array.isArray(rawNode.labels) && rawNode.labels.length > 0) {
		// 过滤掉通用标签
		const specificLabels = rawNode.labels.filter((l: string) => 
			!['Entity', 'Chunk', 'Document', 'Node'].includes(l)
		)
		if (specificLabels.length > 0) {
			return String(specificLabels[0]).toUpperCase()
		}
	}
	
	return 'DEFAULT'
}

function resolveNumeric(value: unknown, defaultValue = 1): number {
	if (typeof value === 'number' && Number.isFinite(value)) {
		return value
	}
	if (typeof value === 'string') {
		const parsed = Number(value)
		if (Number.isFinite(parsed)) {
			return parsed
		}
	}
	return defaultValue
}

function resolveEndpoint(
	edge: Record<string, any>,
	keyCandidates: string[]
): string | null {
	const directCandidate = pickFromContainers(edge, keyCandidates)
	let endpointCandidate = directCandidate
	if (typeof endpointCandidate === 'object' && endpointCandidate !== null) {
		const endpointObj = toPlainObject(endpointCandidate)
		if (endpointObj) {
			const nestedId = pickFromContainers(endpointObj, ['id', 'neo_id', 'neoId', 'elementId', 'ID', 'Id', 'identity', 'uuid', 'nodeId'])
			if (typeof nestedId === 'string' && nestedId.trim() !== '') {
				endpointCandidate = nestedId
			} else if (typeof nestedId === 'number') {
				endpointCandidate = String(nestedId)
			}
		}
	}
	if (typeof endpointCandidate === 'string' && endpointCandidate.trim() !== '') {
		return endpointCandidate
	}
	if (typeof endpointCandidate === 'number') {
		return String(endpointCandidate)
	}
	return null
}

function ensureNodeExists(
	nodeMap: Map<string, GraphNode>,
	nodeId: string
) {
	if (!nodeMap.has(nodeId)) {
		nodeMap.set(nodeId, {
			id: nodeId,
			label: nodeId,
			value: 1,
			category: 'DEFAULT'
		})
	}
}

function normalizeBackendGraph(
	rawNodes: unknown[],
	rawEdges: unknown[]
): VisualizerData {
	const nodeMap = new Map<string, GraphNode>()
	const discoveredIds = new Set<string>()
	rawNodes.forEach((rawNode, index) => {
		const nodeObj = toPlainObject(rawNode)
		if (!nodeObj) return
		const id = resolveNodeId(nodeObj, index)
		const label = resolveNodeLabel(nodeObj, id)
		const value = resolveNumeric(pickFromContainers(nodeObj, ['value', 'weight', 'score', 'size']), 1)
		const category = resolveNodeCategory(nodeObj)
		nodeMap.set(id, {
			id,
			label,
			value,
			category
		})
		discoveredIds.add(id)
	})

	const edges: GraphEdge[] = []
	rawEdges.forEach(rawEdge => {
		const edgeObj = toPlainObject(rawEdge)
		if (!edgeObj) return
		const source = resolveEndpoint(edgeObj, ['source', 'from', 'start', 'startNode', 'sourceId', 'fromId'])
		const target = resolveEndpoint(edgeObj, ['target', 'to', 'end', 'endNode', 'targetId', 'toId'])
		if (!source || !target) return
		discoveredIds.add(source)
		discoveredIds.add(target)
		ensureNodeExists(nodeMap, source)
		ensureNodeExists(nodeMap, target)
		const labelCandidate = pickFromContainers(edgeObj, ['label', 'name', 'type', 'relationship', 'rel'])
		let label = typeof labelCandidate === 'string' && labelCandidate.trim() !== ''
			? labelCandidate
			: `${source} → ${target}`
		
		// 尝试汉化
		if (relationMap.value[label]) {
			label = relationMap.value[label]
		}

		const value = resolveNumeric(pickFromContainers(edgeObj, ['value', 'weight', 'score', 'size', 'count']), 1)
		
		// 提取属性
		const properties = edgeObj.properties || edgeObj.props || edgeObj.data || {}
		
		// 提取 description（优先从 properties 中获取，也可能在顶层）
		const description = edgeObj.description || properties.description || properties.desc || ''

		edges.push({
			source,
			target,
			label: description || label, // 优先显示 description
			description,
			value,
			properties
		})
	})

	const normalizedNodes = Array.from(nodeMap.values())
	const filteredEdges = edges.filter(edge => nodeMap.has(String(edge.source)) && nodeMap.has(String(edge.target)))
	if (filteredEdges.length === 0 && edges.length > 0) {
		return {
			nodes: normalizedNodes,
			edges
		}
	}
	return {
		nodes: normalizedNodes,
		edges: filteredEdges
	}
}

const props = withDefaults(
	defineProps<{
		searchKeyword?: string
		selectedCategory?: string
		selectedDocId?: string
		showLabels?: boolean
		showEdges?: boolean
		nodeSize?: number
		autoRotate?: boolean
		nodeStyle?: string
	}>(),
	{
		searchKeyword: '',
		selectedCategory: '',
		selectedDocId: '',
		showLabels: true,
		showEdges: true,
		nodeSize: 1,
			autoRotate: true,
			nodeStyle: 'style1'
	}
)


particleAutoRotateActive = props.autoRotate

function setupParticleBackground() {
	if (!graphInstance) return
	const THREE = ensureThree()
	if (!THREE) {
		if (!particleSetupScheduled && threeImportPromise) {
			particleSetupScheduled = true
			threeImportPromise
				.then(resolved => {
					particleSetupScheduled = false
					if (resolved && graphInstance) {
						setupParticleBackground()
					}
				})
				.catch(() => {
					particleSetupScheduled = false
				})
		}
		return
	}
	particleSetupScheduled = false
	const scene = (graphInstance.scene?.() ?? null) as Record<string, any> | null
	if (!scene) return
	disposeParticleBackground()
	const geometry = new THREE.BufferGeometry()
	const vertices: number[] = []
	const spread = 2700
	// TODO 调整密度
	const count = 9000
	for (let i = 0; i < count; i++) {
		const x = (Math.random() * spread + Math.random() * spread) * 0.5 - spread * 0.5
		const y = (Math.random() * spread + Math.random() * spread) * 0.5 - spread * 0.5
		const z = (Math.random() * spread + Math.random() * spread) * 0.5 - spread * 0.5
		vertices.push(x, y, z)
	}
	geometry.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3))
	const material = new THREE.PointsMaterial({
		size: 1.6,
		color: new THREE.Color('#cbd5f5'),
		transparent: true,
		opacity: 0.65,
		blending: THREE.AdditiveBlending,
		depthWrite: false
	})
	const particles = new THREE.Points(geometry, material)
	particles.name = 'kg-background-particles'
	particles.renderOrder = -1
	particleSystem = particles
	particleAutoRotateActive = props.autoRotate
	scene.add(particles)
	startParticleAnimation()
}

function startParticleAnimation() {
	stopParticleAnimation()
	if (!particleSystem) return
	const animate = () => {
		if (!particleSystem) return
		const factor = particleAutoRotateActive ? 1 : 0
		particleSystem.rotation.x += 0.0005 * factor
		particleSystem.rotation.y += 0.0008 * factor
		const controls = graphInstance?.controls?.() as { autoRotate?: boolean; update?: () => void } | undefined
		if (controls?.autoRotate) {
			controls.update?.()
		}
		particleAnimationId = requestAnimationFrame(animate)
	}
	particleAnimationId = requestAnimationFrame(animate)
}

function stopParticleAnimation() {
	if (particleAnimationId !== null) {
		cancelAnimationFrame(particleAnimationId)
		particleAnimationId = null
	}
}

function disposeParticleBackground() {
	stopParticleAnimation()
	if (!graphInstance || !particleSystem) {
		particleSystem = null
		return
	}
	const scene = graphInstance.scene?.()
	if (scene) {
		scene.remove(particleSystem)
	}
	particleSystem.geometry?.dispose?.()
	particleSystem.material?.dispose?.()
	particleSystem = null
}

function updateParticleAutoRotate(enabled: boolean) {
	particleAutoRotateActive = enabled
}
const loading = ref(false)
const graphData = ref<VisualizerData>({ nodes: [], edges: [] })
const containerRef = ref<HTMLDivElement | null>(null)
let graphInstance: ForceGraph3DInstance | null = null

// 定义更多类别颜色
const categoryColors: Record<string, string> = {
	// 人物相关
	PERSON: '#4e9af1',
	人物: '#4e9af1',
	角色: '#4e9af1',
	CHARACTER: '#4e9af1',
	
	// 组织相关
	ORGANIZATION: '#f38b3f',
	组织: '#f38b3f',
	机构: '#f38b3f',
	公司: '#f38b3f',
	ORG: '#f38b3f',
	
	// 地点相关
	LOCATION: '#4caf50',
	地点: '#4caf50',
	地名: '#4caf50',
	PLACE: '#4caf50',
	GEO: '#4caf50',
	
	// 产品相关
	PRODUCT: '#9b59b6',
	产品: '#9b59b6',
	物品: '#9b59b6',
	ITEM: '#9b59b6',
	OBJECT: '#9b59b6',
	
	// 概念相关
	CONCEPT: '#1abc9c',
	概念: '#1abc9c',
	IDEA: '#1abc9c',
	
	// 事件相关
	EVENT: '#e74c3c',
	事件: '#e74c3c',
	
	// 时间相关
	TIME: '#f39c12',
	时间: '#f39c12',
	DATE: '#f39c12',
	
	// 默认/未知
	DEFAULT: '#95a5a6',
	UNKNOWN: '#95a5a6',
	ENTITY: '#7f8c8d'
}

// 为未知类别生成稳定的颜色
function hashStringToColor(str: string): string {
	let hash = 0
	for (let i = 0; i < str.length; i++) {
		hash = str.charCodeAt(i) + ((hash << 5) - hash)
	}
	const hue = Math.abs(hash % 360)
	return `hsl(${hue}, 65%, 55%)`
}

const relationMap = ref<Record<string, string>>({})

async function fetchMappings() {
    try {
        const response = await fetch('/api/kg/mappings')
        if (response.ok) {
            const res = await response.json()
            if (res.success && res.data && res.data.relation_display) {
                relationMap.value = res.data.relation_display
            }
        }
    } catch (error) {
        console.error('Failed to fetch mappings:', error)
    }
}

const filteredGraph = computed<{ nodes: GraphNode[]; edges: GraphEdge[] }>(() => {
	const keyword = props.searchKeyword.trim().toLowerCase()
	const nodes = graphData.value.nodes.filter((node: GraphNode) => {
		const matchesKeyword = keyword === '' || node.label.toLowerCase().includes(keyword)
		const matchesCategory = props.selectedCategory === '' || node.category === props.selectedCategory
		return matchesKeyword && matchesCategory
	})

	const visibleIds = new Set(nodes.map((node: GraphNode) => node.id))
	const edges = props.showEdges
		? graphData.value.edges.filter((edge: GraphEdge) => visibleIds.has(edge.source) && visibleIds.has(edge.target))
		: []

	return { nodes, edges }
})

function getCategoryColor(category: string): string {
	if (!category) return categoryColors.DEFAULT || '#95a5a6'
	const upperCategory = category.toUpperCase()
	// 先查预定义颜色
	if (categoryColors[upperCategory]) {
		return categoryColors[upperCategory]
	}
	// 原始大小写也查一下
	if (categoryColors[category]) {
		return categoryColors[category]
	}
	// 未知类别生成稳定颜色
	return hashStringToColor(upperCategory)
}

function getNodeColor(node: GraphNode): string {
	const baseColor = getCategoryColor(node.category)
	return baseColor // 始终保持原色，仅通过透明度区分
}

function getNodeOpacity(node: GraphNode): number {
	if (!isHighlightActive.value) return 1
	// 高亮模式下，默认所有节点透明度为 0.1 (暗淡)
	// 具体的动画效果由 highlightElements 中的 requestAnimationFrame 直接操作 ThreeJS 对象来实现
	// 这样可以避免 Vue 响应式系统的性能开销
	return 0.1
}

function getLinkColor(link: GraphEdge): string {
	if (!isHighlightActive.value) return 'rgba(102,128,255,0.6)'
	
	// 检查两端节点是否都被高亮，如果不是则完全隐藏这条边
	const sourceId = typeof link.source === 'object' ? (link.source as any).id : link.source
	const targetId = typeof link.target === 'object' ? (link.target as any).id : link.target
	
	const sourceHighlighted = highlightedNodeIds.value.has(sourceId)
	const targetHighlighted = highlightedNodeIds.value.has(targetId)
	
	if (!sourceHighlighted || !targetHighlighted) {
		return 'rgba(0,0,0,0)' // 完全透明
	}
	
	// 高亮模式下，默认连线透明度为 0 (不可见)，等待动画过渡到 0.8
	return 'rgba(102, 128, 255, 0)'
}

function getLinkWidth(link: GraphEdge): number {
	const baseWidth = Math.max((link.value ?? 1) * 0.45, 1.2)
	if (!isHighlightActive.value) return baseWidth
	// 生成连线的匹配 ID
	const sourceId = typeof link.source === 'object' ? (link.source as any).id : link.source
	const targetId = typeof link.target === 'object' ? (link.target as any).id : link.target
	
	// 检查两端节点是否都被高亮，如果不是则宽度为0
	const sourceHighlighted = highlightedNodeIds.value.has(sourceId)
	const targetHighlighted = highlightedNodeIds.value.has(targetId)
	if (!sourceHighlighted || !targetHighlighted) {
		return 0
	}
	
	const linkKey = `${sourceId}-${targetId}`
	const linkKeyReverse = `${targetId}-${sourceId}`
	const isHighlighted = highlightedLinkIds.value.has(linkKey) || highlightedLinkIds.value.has(linkKeyReverse)
	return isHighlighted ? baseWidth * 2.5 : baseWidth * 0.5
}

function shouldUseDemoData(): boolean {
	// 将返回值切换为 true 使用内置演示数据，设为 false 则请求 Neo4j 后端
	return false
}


function resolveNodeRenderer(styleKey: string) {
	const renderer = nodeStyleDefinitions[styleKey]
	if (renderer) return renderer
	return nodeStyleDefinitions.style1 ?? Object.values(nodeStyleDefinitions)[0]
}

function createNodeObject(node: GraphNode): any {
	const THREE = ensureThree()
	if (!THREE) {
		return new SpriteText(node.label)
	}
	
	// 移除降级逻辑，保持高亮模式下节点样式与默认模式一致
	// 仅通过透明度区分高亮与非高亮

	const renderer = resolveNodeRenderer(props.nodeStyle)
	const rendered = renderer?.({
		THREE,
		node,
		getCategoryColor,
		nodeSize: props.nodeSize,
		showLabels: props.showLabels
	})
	if (rendered) return rendered
	const fallbackLabel = new SpriteText(node.label)
	fallbackLabel.color = getCategoryColor(node.category)
	return fallbackLabel
}

function updateGraphData() {
	if (!graphInstance) return
	const { nodes, edges } = filteredGraph.value
	const nodeCopies = nodes.map((node: GraphNode) => ({ ...node }))
	const linkCopies = edges.map((edge: GraphEdge) => ({ ...edge }))
	graphInstance.graphData({ nodes: nodeCopies, links: linkCopies })
	refreshNodeAppearance()
	refreshLinkAppearance()
}

function refreshNodeAppearance() {
	if (!graphInstance) return
	graphInstance.nodeThreeObject((node: NodeObject) => createNodeObject(node as GraphNode))
	graphInstance.nodeThreeObjectExtend(false)
	graphInstance.refresh()
}

function refreshLinkAppearance() {
	if (!graphInstance) return
	
	// 高亮模式下为高亮的边显示描述文字和管道效果
	graphInstance.linkThreeObject((link: any) => {
		if (!isHighlightActive.value) return undefined
		
		const sourceId = typeof link.source === 'object' ? link.source.id : link.source
		const targetId = typeof link.target === 'object' ? link.target.id : link.target
		
		// 检查两端节点是否都被高亮
		const sourceHighlighted = highlightedNodeIds.value.has(sourceId)
		const targetHighlighted = highlightedNodeIds.value.has(targetId)
		if (!sourceHighlighted || !targetHighlighted) return undefined
		
		// 检查边是否被高亮
		const linkKey = `${sourceId}-${targetId}`
		const linkKeyReverse = `${targetId}-${sourceId}`
		const isHighlighted = highlightedLinkIds.value.has(linkKey) || highlightedLinkIds.value.has(linkKeyReverse)
		if (!isHighlighted) return undefined
		
		const group = new threeLib.Group()

		// 1. 创建管道 (Pipe)
		// 几何体：圆柱体，底面半径0.5，顶面半径0.5，高度1 (后续缩放)，径向分段8，高度分段1，开放两端
		const geometry = new threeLib.CylinderGeometry(0.5, 0.5, 1, 8, 1, true)
		// 调整几何体中心：默认中心在(0,0,0)，高度方向为Y轴
		// 我们希望起点在(0,0,0)，并且沿着Z轴延伸 (方便 lookAt)
		geometry.translate(0, 0.5, 0) // 将底部移动到原点 (Y轴 0 -> 1)
		geometry.rotateX(Math.PI / 2) // 旋转90度，使 Y轴 变为 Z轴 (Z轴 0 -> 1)

		const material = new threeLib.ShaderMaterial({
			uniforms: {
				color: { value: new threeLib.Color(0x6680ff) },
				progress: { value: 0.0 } // 初始进度为 0
			},
			vertexShader: pipeVertexShader,
			fragmentShader: pipeFragmentShader,
			transparent: true,
			side: threeLib.DoubleSide,
			depthWrite: false,
			blending: threeLib.AdditiveBlending
		})

		const pipe = new threeLib.Mesh(geometry, material)
		pipe.userData = { isPipe: true }
		group.add(pipe)

		// 2. 创建标签 (Label)
		// 获取关系描述（优先使用 description，其次是 label）
		const text = link.description || link.label || ''
		if (text) {
			const sprite = new SpriteText(text)
			sprite.color = '#ffffff'
			sprite.textHeight = 4
			sprite.backgroundColor = 'rgba(14, 116, 144, 0.85)' // 青色背景 (teal)
			sprite.padding = 1.5
			sprite.borderRadius = 2
			sprite.userData = { isLabel: true }
			group.add(sprite)
		}
		
		return group
	})
	graphInstance.linkThreeObjectExtend(true)
	graphInstance.linkPositionUpdate((obj: any, { start, end }: any) => {
		if (!obj) return
		
		const startV = new threeLib.Vector3(start.x, start.y, start.z)
		const endV = new threeLib.Vector3(end.x, end.y, end.z)
		const dist = startV.distanceTo(endV)

		// 处理 Group 中的子对象
		if (obj.children) {
			obj.children.forEach((child: any) => {
				if (child.userData?.isPipe) {
					// 管道：起点定位，朝向终点，Z轴缩放至距离
					child.position.copy(startV)
					child.lookAt(endV)
					// 缩放：X/Y 为粗细，Z 为长度
					child.scale.set(2, 2, dist) 
				}
				if (child.userData?.isLabel) {
					// 标签：居中
					const middlePos = startV.clone().add(endV).multiplyScalar(0.5)
					child.position.copy(middlePos)
				}
			})
		}
	})
	graphInstance.refresh()
}

function applyAutoRotate(enabled: boolean) {
	if (!graphInstance) return
	const controls = graphInstance.controls() as Record<string, any> | undefined
	if (!controls) return
	controls.autoRotate = enabled
	controls.autoRotateSpeed = 0.6
	;(graphInstance as unknown as { autoPauseRedraw?: (state: boolean) => any }).autoPauseRedraw?.(!enabled)
	graphInstance.refresh()
}

function applyLinkStyles() {
	if (!graphInstance) return
	graphInstance.linkOpacity(isHighlightActive.value ? 0.1 : 0.45)
	graphInstance.linkWidth(link => getLinkWidth(link as GraphEdge))
	graphInstance.linkColor(link => getLinkColor(link as GraphEdge))
	graphInstance.linkDirectionalParticles(props.showEdges ? 2 : 0)
	graphInstance.linkDirectionalParticleWidth(2.4)
	graphInstance.linkDirectionalParticleSpeed(() => 0.0035)
	graphInstance.linkDirectionalParticleColor(() => '#4ecdc4')
	graphInstance.refresh()
}

function applyForceSettings() {
	if (!graphInstance) return
	const linkForce = graphInstance.d3Force('link') as any
	if (linkForce?.distance) {
		linkForce.distance((link: GraphEdge) => 180 + ((link.value ?? 1) * 18))
		linkForce.strength(0.75)
	}
	const chargeForce = graphInstance.d3Force('charge') as any
	if (chargeForce?.strength) {
		chargeForce.strength(-240)
	}
	graphInstance.d3VelocityDecay(0.22)
}

function updateGraphSize() {
	if (!graphInstance || !containerRef.value) return
	const { clientWidth, clientHeight } = containerRef.value
	if (clientWidth === 0 || clientHeight === 0) return
	graphInstance.width(clientWidth)
	graphInstance.height(clientHeight)
}

function initForceGraph() {
	if (!containerRef.value || graphInstance) return
	const factory = ForceGraph3D as unknown as () => any
	const instance = factory()
	instance(containerRef.value)
		.backgroundColor('#0b1220')
		.nodeId('id')
		.nodeLabel((node: GraphNode) => node.label)
		.nodeColor((node: GraphNode) => getNodeColor(node))
		.nodeOpacity((node: GraphNode) => getNodeOpacity(node))
		.linkLabel((link: GraphEdge) => {
			const desc = link.description || '';
			const source = typeof link.source === 'object' ? (link.source as any).label : link.source;
			const target = typeof link.target === 'object' ? (link.target as any).label : link.target;
			
			return `
				<div class="p-2 bg-gray-900/90 rounded border border-gray-700 shadow-xl backdrop-blur-sm text-xs">
					<div class="font-bold text-cyan-400 mb-1">${link.label}</div>
					${desc && desc !== link.label ? `<div class="text-gray-300 mb-1 max-w-[200px] whitespace-normal">${desc}</div>` : ''}
					<div class="text-gray-500 mt-1 pt-1 border-t border-gray-700/50 flex items-center gap-1">
						<span class="truncate max-w-[80px]">${source}</span>
						<span>→</span>
						<span class="truncate max-w-[80px]">${target}</span>
					</div>
				</div>
			`;
		})
		.linkOpacity(0.35)
		.linkColor((link: GraphEdge) => getLinkColor(link))
		.warmupTicks(60)
		.cooldownTicks(150)
		.onBackgroundClick(() => {
			// 点击背景取消高亮
			clearHighlight()
		})

	graphInstance = instance as ForceGraph3DInstance
	threeLib = threeLib ?? (instance as unknown as { THREE?: ThreeLib }).THREE ?? (factory as any).THREE ?? null
	refreshNodeAppearance()
	applyLinkStyles()
	applyForceSettings()
	applyAutoRotate(props.autoRotate)
	updateGraphSize()
	setupParticleBackground()
	window.addEventListener('resize', updateGraphSize)
}

async function fetchGraphData(useDemo = false, forceRefresh = false) {
	loading.value = true
	try {
		if (!useDemo) {
			// 尝试从缓存获取数据（除非强制刷新）
			if (!forceRefresh) {
				const cachedData = getGraphCache(props.selectedDocId)
				if (cachedData) {
					graphData.value = cachedData
					updateGraphData()
					// 缓存命中时，缩短 loading 时间
					setTimeout(() => {
						loading.value = false
					}, 200)
					return
				}
			}
			
			// 构建带文档 ID 参数的 URL
			const urlParams = new URLSearchParams({ limit: '100' })
			if (props.selectedDocId) {
				urlParams.append('doc_id', props.selectedDocId)
			}
			const response = await fetch(`/api/kg/visualize?${urlParams.toString()}`)
			if (response.ok) {
				const payload = await response.json()
				const nodes = payload?.data?.nodes
				const edges = payload?.data?.edges
				if (payload?.success && Array.isArray(nodes) && Array.isArray(edges)) {
					const normalized = normalizeBackendGraph(nodes, edges)
					if (normalized.nodes.length > 0) {
						graphData.value = normalized
						// 缓存数据
						setGraphCache(normalized, props.selectedDocId)
						updateGraphData()
						return
					}
				}
			}
		}
		populateDemoData()
		updateGraphData()
	} catch (error) {
		console.warn('获取知识图谱数据失败，使用演示数据', error)
		populateDemoData()
		updateGraphData()
	} finally {
		// 延迟关闭 loading，让图谱有时间渲染和布局，配合淡出动画实现丝滑过渡
		setTimeout(() => {
			loading.value = false
		}, 600)
	}
}

function populateDemoData() {
	const nodes: GraphNode[] = [
		{ id: 'node1', label: '张三', value: 18, category: 'PERSON' },
		{ id: 'node2', label: '李四', value: 15, category: 'PERSON' },
		{ id: 'node3', label: '王敏', value: 16, category: 'PERSON' },
		{ id: 'node4', label: '百度医疗知识库', value: 28, category: 'ORGANIZATION' },
		{ id: 'node5', label: '腾讯云医学平台', value: 26, category: 'ORGANIZATION' },
		{ id: 'node6', label: '北京协和医院', value: 24, category: 'ORGANIZATION' },
		{ id: 'node7', label: '上海瑞金医院', value: 23, category: 'ORGANIZATION' },
		{ id: 'node8', label: '北京', value: 20, category: 'LOCATION' },
		{ id: 'node9', label: '上海', value: 19, category: 'LOCATION' },
		{ id: 'node10', label: '肺炎', value: 18, category: 'DISEASE' },
		{ id: 'node11', label: 'CT 影像', value: 17, category: 'PRODUCT' },
		{ id: 'node12', label: '知识图谱问答', value: 24, category: 'CONCEPT' },
		{ id: 'node13', label: '呼吸科', value: 14, category: 'DEPARTMENT' },
		{ id: 'node14', label: '临床路径', value: 16, category: 'CONCEPT' },
		{ id: 'node15', label: '多模态检索', value: 18, category: 'CONCEPT' }
	]

	const edges: GraphEdge[] = [
		{ source: 'node1', target: 'node4', label: '负责建设', value: 1.3 },
		{ source: 'node2', target: 'node5', label: '参与研发', value: 1.2 },
		{ source: 'node3', target: 'node6', label: '联合项目', value: 1.2 },
		{ source: 'node4', target: 'node8', label: '总部在', value: 1 },
		{ source: 'node5', target: 'node9', label: '总部在', value: 1 },
		{ source: 'node6', target: 'node13', label: '设有', value: 1.1 },
		{ source: 'node7', target: 'node13', label: '重点科室', value: 1.1 },
		{ source: 'node10', target: 'node11', label: '诊断依赖', value: 1.3 },
		{ source: 'node10', target: 'node13', label: '治疗归属', value: 1.2 },
		{ source: 'node12', target: 'node10', label: '回答疾病问题', value: 1.4 },
		{ source: 'node12', target: 'node14', label: '支撑流程', value: 1.2 },
		{ source: 'node12', target: 'node15', label: '结合能力', value: 1.2 },
		{ source: 'node14', target: 'node6', label: '落地机构', value: 1.1 },
		{ source: 'node15', target: 'node11', label: '检索媒介', value: 1.1 },
		{ source: 'node2', target: 'node1', label: '协作', value: 1 },
		{ source: 'node1', target: 'node12', label: '应用场景', value: 1.3 }
	]

	graphData.value = { nodes, edges }
}

function handleReset() {
	if (!graphInstance) return
	graphInstance.cameraPosition({ x: 0, y: 0, z: 600 }, { x: 0, y: 0, z: 0 }, 1000)
}

// 强制刷新图谱数据（清除缓存并重新获取）
function handleRefresh() {
	clearGraphCache()
	fetchGraphData(shouldUseDemoData(), true)
	ElMessage.success('正在刷新图谱数据...')
}

function handleDownload() {
	if (!graphInstance) return
	const renderer = graphInstance.renderer()
	const canvas = renderer?.domElement
	if (!canvas) return
	const link = document.createElement('a')
	link.href = canvas.toDataURL('image/png')
	link.download = `knowledge-graph-${Date.now()}.png`
	link.click()
}

watch(filteredGraph, () => updateGraphData())
watch(() => props.nodeSize, () => refreshNodeAppearance())
watch(() => props.showLabels, () => refreshNodeAppearance())
watch(() => props.autoRotate, value => {
	applyAutoRotate(value)
	updateParticleAutoRotate(value)
})
watch(() => props.nodeStyle, () => refreshNodeAppearance())
watch(
	() => props.showEdges,
	() => {
		updateGraphData()
		applyLinkStyles()
		refreshLinkAppearance()
	}
)
watch(() => [props.searchKeyword, props.selectedCategory], () => updateGraphData())
// 文档 ID 变化时重新获取数据
watch(() => props.selectedDocId, () => fetchGraphData(shouldUseDemoData()))

onMounted(async () => {
	initForceGraph()
	if (!graphInstance) {
		ElMessage.error('3D 引擎初始化失败')
		return
	}
	await fetchGraphData(shouldUseDemoData())
})

onBeforeUnmount(() => {
	window.removeEventListener('resize', updateGraphSize)
	disposeParticleBackground()
	if (graphInstance) {
		;(graphInstance as unknown as { _destructor?: () => void })._destructor?.()
		graphInstance = null
	}
})

function clearHighlight() {
	// 停止所有正在进行的动画
	currentAnimationId++
	
	if (!graphInstance || isAnimating.value) return
	
	// 如果有保存的原始位置，先恢复节点位置
	if (originalNodePositions.value.size > 0) {
		isAnimating.value = true
		const { nodes } = graphInstance.graphData()
		
		// 动画恢复原始位置
		animateNodesToPositions(nodes, originalNodePositions.value, 400, () => {
			originalNodePositions.value.clear()
			highlightedNodeIds.value.clear()
			highlightedLinkIds.value.clear()
			refreshNodeAppearance()
			applyLinkStyles()
			isAnimating.value = false
		})
	} else {
		highlightedNodeIds.value.clear()
		highlightedLinkIds.value.clear()
		refreshNodeAppearance()
		applyLinkStyles()
	}
}

// 动画过渡节点到目标位置
function animateNodesToPositions(
	nodes: any[], 
	targetPositions: Map<string, { x: number; y: number; z: number }>,
	duration: number,
	onComplete?: () => void
) {
	if (!graphInstance) return
	
	const startTime = performance.now()
	const startPositions = new Map<string, { x: number; y: number; z: number }>()
	
	// 记录起始位置
	nodes.forEach((node: any) => {
		if (targetPositions.has(node.id)) {
			startPositions.set(node.id, {
				x: node.x || 0,
				y: node.y || 0,
				z: node.z || 0
			})
		}
	})
	
	function animate() {
		const elapsed = performance.now() - startTime
		const progress = Math.min(elapsed / duration, 1)
		
		// 使用 easeOutCubic 缓动函数
		const eased = 1 - Math.pow(1 - progress, 3)
		
		nodes.forEach((node: any) => {
			const start = startPositions.get(node.id)
			const target = targetPositions.get(node.id)
			if (start && target) {
				node.x = start.x + (target.x - start.x) * eased
				node.y = start.y + (target.y - start.y) * eased
				node.z = start.z + (target.z - start.z) * eased
			}
		})
		
		graphInstance?.refresh()
		
		if (progress < 1) {
			requestAnimationFrame(animate)
		} else {
			onComplete?.()
		}
	}
	
	requestAnimationFrame(animate)
}

// 简单的力导向布局（用于高亮子图的紧凑排列）
function computeCompactLayout(
	nodeIds: string[], 
	edges: any[], 
	center: { x: number; y: number; z: number },
	iterations: number = 100
): Map<string, { x: number; y: number; z: number }> {
	const positions = new Map<string, { x: number; y: number; z: number }>()
	const nodeIdSet = new Set(nodeIds)
	
	// 根据节点数量动态调整初始半径，确保节点散开
	const nodeCount = nodeIds.length
	const initialRadius = Math.max(80, nodeCount * 15) // 更大的初始半径
	
	// 初始化位置：围绕中心点均匀分布在球面上
	nodeIds.forEach((id, index) => {
		// 使用黄金角度分布，确保均匀散开
		const goldenAngle = Math.PI * (3 - Math.sqrt(5))
		const theta = goldenAngle * index
		const y = 1 - (index / (nodeCount - 1 || 1)) * 2 // y 从 1 到 -1
		const radiusAtY = Math.sqrt(1 - y * y)
		
		positions.set(id, {
			x: center.x + initialRadius * radiusAtY * Math.cos(theta),
			y: center.y + initialRadius * y,
			z: center.z + initialRadius * radiusAtY * Math.sin(theta)
		})
	})
	
	// 筛选子图的边
	const subEdges = edges.filter((edge: any) => {
		const sourceId = typeof edge.source === 'object' ? edge.source.id : edge.source
		const targetId = typeof edge.target === 'object' ? edge.target.id : edge.target
		return nodeIdSet.has(sourceId) && nodeIdSet.has(targetId)
	})
	
	// 力导向迭代 - 调整参数使节点散开
	const repulsionStrength = 2000 // 增大斥力
	const attractionStrength = 0.02 // 减小引力
	const centeringStrength = 0.008 // 减小向心力
	const damping = 0.85
	const minDistance = 30 // 最小距离
	
	const velocities = new Map<string, { vx: number; vy: number; vz: number }>()
	nodeIds.forEach(id => velocities.set(id, { vx: 0, vy: 0, vz: 0 }))
	
	for (let iter = 0; iter < iterations; iter++) {
		const temperature = 1 - iter / iterations
		
		// 斥力（节点之间）- 确保节点散开
		for (let i = 0; i < nodeIds.length; i++) {
			for (let j = i + 1; j < nodeIds.length; j++) {
				const idA = nodeIds[i] as string
				const idB = nodeIds[j] as string
				const posA = positions.get(idA)
				const posB = positions.get(idB)
				if (!posA || !posB) continue
				
				const dx = posA.x - posB.x
				const dy = posA.y - posB.y
				const dz = posA.z - posB.z
				const dist = Math.sqrt(dx * dx + dy * dy + dz * dz) + 0.1
				
				// 如果距离小于最小距离，增加额外斥力
				const effectiveDist = Math.max(dist, minDistance)
				const force = (repulsionStrength / (effectiveDist * effectiveDist)) * temperature
				
				// 如果太近，给一个随机扰动
				let fx = (dx / dist) * force
				let fy = (dy / dist) * force
				let fz = (dz / dist) * force
				
				if (dist < minDistance) {
					fx += (Math.random() - 0.5) * force * 0.5
					fy += (Math.random() - 0.5) * force * 0.5
					fz += (Math.random() - 0.5) * force * 0.5
				}
				
				const velA = velocities.get(idA)
				const velB = velocities.get(idB)
				if (!velA || !velB) continue
				velA.vx += fx; velA.vy += fy; velA.vz += fz
				velB.vx -= fx; velB.vy -= fy; velB.vz -= fz
			}
		}
		
		// 引力（连接的节点之间）
		subEdges.forEach((edge: any) => {
			const sourceId = typeof edge.source === 'object' ? edge.source.id : edge.source
			const targetId = typeof edge.target === 'object' ? edge.target.id : edge.target
			const posSource = positions.get(sourceId)
			const posTarget = positions.get(targetId)
			if (!posSource || !posTarget) return
			
			const dx = posTarget.x - posSource.x
			const dy = posTarget.y - posSource.y
			const dz = posTarget.z - posSource.z
			const dist = Math.sqrt(dx * dx + dy * dy + dz * dz) + 0.1
			
			const force = dist * attractionStrength * temperature
			const fx = (dx / dist) * force
			const fy = (dy / dist) * force
			const fz = (dz / dist) * force
			
			const velSource = velocities.get(sourceId)
			const velTarget = velocities.get(targetId)
			if (!velSource || !velTarget) return
			velSource.vx += fx; velSource.vy += fy; velSource.vz += fz
			velTarget.vx -= fx; velTarget.vy -= fy; velTarget.vz -= fz
		})
		
		// 向心力（向中心聚拢）
		nodeIds.forEach(id => {
			const pos = positions.get(id)
			const vel = velocities.get(id)
			if (!pos || !vel) return
			vel.vx += (center.x - pos.x) * centeringStrength * temperature
			vel.vy += (center.y - pos.y) * centeringStrength * temperature
			vel.vz += (center.z - pos.z) * centeringStrength * temperature
		})
		
		// 应用速度并阻尼
		nodeIds.forEach(id => {
			const pos = positions.get(id)
			const vel = velocities.get(id)
			if (!pos || !vel) return
			pos.x += vel.vx
			pos.y += vel.vy
			pos.z += vel.vz
			vel.vx *= damping
			vel.vy *= damping
			vel.vz *= damping
		})
	}
	
	return positions
}



// 缓动函数（ease-in-cubic）
function easeInCubic(t: number): number {
	return t * t * t
}

function getLayerScaleFactor(depth: number): number {
	if (depth <= 0) return 1.52
	if (depth === 1) return 1.28
	if (depth === 2) return 1.12
	if (depth === 3) return 1.02
	return 0.94
}

function setNodeOpacityAndGlow(threeObj: any, opacity: number, pulseIntensity = 0, baseScale = 1) {
	if (!threeObj) return
	const safeOpacity = Math.min(Math.max(opacity, 0.05), 1)
	const pulseScale = baseScale * (1 + pulseIntensity * 0.24)
	threeObj.scale?.setScalar?.(pulseScale)

	const applyMaterial = (material: any) => {
		if (!material) return
		material.opacity = safeOpacity
		material.transparent = safeOpacity < 0.999
		if ('emissiveIntensity' in material && typeof material.emissiveIntensity === 'number') {
			material.emissiveIntensity = 0.12 + pulseIntensity * 1.8
		}
		material.needsUpdate = true
	}

	if (threeObj.material) {
		applyMaterial(threeObj.material)
		return
	}

	if (threeObj.traverse) {
		threeObj.traverse((child: any) => {
			if (child?.material) {
				applyMaterial(child.material)
			}
		})
	}
}

function focusCameraOnSeedNodes(nodeMap: Map<string, any>, seedNodeIds: string[]) {
	if (!graphInstance || !seedNodeIds.length) return
	const points = seedNodeIds
		.map(id => nodeMap.get(id))
		.filter(Boolean)
		.map((node: any) => ({
			x: Number(node.x ?? node.__threeObj?.position?.x ?? 0),
			y: Number(node.y ?? node.__threeObj?.position?.y ?? 0),
			z: Number(node.z ?? node.__threeObj?.position?.z ?? 0)
		}))

	if (!points.length) return
	const centroid = points.reduce((acc, p) => {
		acc.x += p.x
		acc.y += p.y
		acc.z += p.z
		return acc
	}, { x: 0, y: 0, z: 0 })
	centroid.x /= points.length
	centroid.y /= points.length
	centroid.z /= points.length

	const radius = Math.max(220, 140 + points.length * 45)
	graphInstance.cameraPosition(
		{ x: centroid.x + radius, y: centroid.y + radius * 0.35, z: centroid.z + radius * 1.2 },
		{ x: centroid.x, y: centroid.y, z: centroid.z },
		1100
	)
}

function highlightElements(nodeIds: string[], linkIds: string[], options: HighlightOptions = {}) {
	if (!graphInstance) return

	// 1. 状态重置与初始化
	currentAnimationId++
	const animationId = currentAnimationId

	// 立即设置高亮集合
	highlightedNodeIds.value = new Set(nodeIds)
	highlightedLinkIds.value = new Set(linkIds)
	
	// 立即刷新视图，应用初始暗淡状态
	refreshNodeAppearance()
	refreshLinkAppearance() // 必须调用以创建管道对象
	applyLinkStyles()

	// 延迟一帧执行动画逻辑，确保 refresh() 后的 ThreeJS 对象已就绪
	requestAnimationFrame(() => {
		if (currentAnimationId !== animationId) return
		
		// 2. 数据准备 (BFS)
		const { links, nodes } = graphInstance.graphData()
		const nodeMap = new Map(nodes.map((n: any) => [n.id, n]))
		
		// 预先设置高亮节点的初始透明度为 0.1 (避免从 1 闪烁到 0.1)
		nodeIds.forEach(id => {
			const node = nodeMap.get(id)
			if (node && node.__threeObj) {
				const obj = node.__threeObj
				if (obj.material) {
					obj.material.opacity = 0.1
					obj.material.transparent = true
				} else if (obj.children) {
					obj.traverse((c: any) => { 
						if (c.material) {
							c.material.opacity = 0.1 
							c.material.transparent = true
						}
					})
				}
			}
		})

		// 构建邻接表
		const adjacency = new Map<string, Array<{ neighbor: string, linkId: string }>>()
		const subsetNodeSet = new Set(nodeIds)
		const subsetLinkSet = new Set(linkIds)
		const linkObjMap = new Map<string, any>()

		links.forEach((edge: any) => {
			const sourceId = typeof edge.source === 'object' ? edge.source.id : edge.source
			const targetId = typeof edge.target === 'object' ? edge.target.id : edge.target
			const linkKey = `${sourceId}-${targetId}`
			const linkKeyReverse = `${targetId}-${sourceId}`
			
			// 捕获连线对象 (优先捕获自定义对象 Group)
			if (edge.__threeObj) {
				linkObjMap.set(linkKey, edge.__threeObj)
				linkObjMap.set(linkKeyReverse, edge.__threeObj)
			}

			if ((subsetLinkSet.has(linkKey) || subsetLinkSet.has(linkKeyReverse)) && 
				subsetNodeSet.has(sourceId) && subsetNodeSet.has(targetId)) {
				
				const validLinkId = subsetLinkSet.has(linkKey) ? linkKey : linkKeyReverse
				
				if (!adjacency.has(sourceId)) adjacency.set(sourceId, [])
				if (!adjacency.has(targetId)) adjacency.set(targetId, [])
				
				adjacency.get(sourceId)?.push({ neighbor: targetId, linkId: validLinkId })
				adjacency.get(targetId)?.push({ neighbor: sourceId, linkId: validLinkId })
			}
		})

		// BFS 分层（支持从指定种子节点开始，形成明显的层级扩散效果）
		const waves: Array<{ nodes: string[], links: string[] }> = []
		const visited = new Set<string>()
		const queue: string[] = []
		const remainingNodes = new Set(nodeIds)
		const seedNodeSet = new Set(
			(options.seedNodeIds ?? [])
				.map(id => String(id))
				.filter(id => subsetNodeSet.has(id))
		)
		const seedNodeIds = Array.from(seedNodeSet)
		const maxDepth = Number.isFinite(options.maxDepth) ? Math.max(1, Number(options.maxDepth)) : 4
		const depthMap = new Map<string, number>()

		if (seedNodeSet.size > 0) {
			const seeds = Array.from(seedNodeSet)
			waves.push({ nodes: seeds, links: [] })
			for (const seed of seeds) {
				visited.add(seed)
				remainingNodes.delete(seed)
				queue.push(seed)
				depthMap.set(seed, 0)
			}
		}

		focusCameraOnSeedNodes(nodeMap, seedNodeIds)
		
		while (remainingNodes.size > 0) {
			if (queue.length === 0) {
				const nextStart = remainingNodes.values().next().value
				queue.push(nextStart)
				visited.add(nextStart)
				remainingNodes.delete(nextStart)
				depthMap.set(nextStart, 0)
				waves.push({ nodes: [nextStart], links: [] })
			}

			const currentLevelSize = queue.length
			const nextLevelNodes: string[] = []
			const nextLevelLinks: string[] = []
			
			for (let i = 0; i < currentLevelSize; i++) {
				const u = queue.shift()!
				const depth = depthMap.get(u) ?? 0
				if (depth >= maxDepth) {
					continue
				}
				const neighbors = adjacency.get(u) || []
				
				for (const { neighbor: v, linkId } of neighbors) {
					if (!visited.has(v)) {
						visited.add(v)
						remainingNodes.delete(v)
						queue.push(v)
						depthMap.set(v, depth + 1)
						nextLevelNodes.push(v)
						nextLevelLinks.push(linkId)
					}
				}
			}
			
			if (nextLevelNodes.length > 0) {
				waves.push({ nodes: nextLevelNodes, links: nextLevelLinks })
			}
		}

		// 3. 预计算时间
		const totalDuration = 4400
		const waveCount = Math.max(waves.length, 1)
		const nodeFadeDuration = 900
		const linkFadeDuration = 1200 // 增加连线填充时间，使其更明显
		
		let waveDelay = 0
		if (waveCount > 1) {
			waveDelay = (totalDuration - nodeFadeDuration) / (waveCount - 1)
		}
		waveDelay = Math.max(waveDelay, 150)

		const startTimes = new Map<string, number>()
		const globalStartTime = performance.now()

		waves.forEach((wave, index) => {
			const waveStart = index * waveDelay
			wave.links.forEach(id => startTimes.set('link_' + id, globalStartTime + waveStart))
			const nodeDelay = wave.links.length > 0 ? 170 : 0
			wave.nodes.forEach(id => startTimes.set('node_' + id, globalStartTime + waveStart + nodeDelay))
		})

		// 4. 动画循环
		const animateFrame = () => {
			if (currentAnimationId !== animationId) return

			const now = performance.now()
			let isAnyAnimating = false
			
			// 节点动画
			nodeIds.forEach(nodeId => {
				const startTime = startTimes.get('node_' + nodeId)
				if (!startTime) return

				const nodeObj = nodeMap.get(nodeId)
				if (!nodeObj || !nodeObj.__threeObj) return

				const elapsed = now - startTime
				if (elapsed < 0) return

				const progress = Math.min(elapsed / nodeFadeDuration, 1)
				if (progress < 1) isAnyAnimating = true

				const eased = easeInCubic(progress)
				const currentOpacity = 0.05 + (1 - 0.05) * eased
				const pulse = Math.max(0, 1 - progress)
				const depth = depthMap.get(nodeId) ?? 4
				const layerScale = getLayerScaleFactor(depth)

				setNodeOpacityAndGlow(nodeObj.__threeObj, currentOpacity, pulse, layerScale)
			})

			// 连线动画 (管道填充)
			linkIds.forEach(linkId => {
				const startTime = startTimes.get('link_' + linkId)
				if (!startTime) return

				// 懒加载获取连线对象 (Group)
				let linkGroup = linkObjMap.get(linkId)
				if (!linkGroup) {
					// 尝试重新查找
					const edge = links.find((e: any) => {
						const s = typeof e.source === 'object' ? e.source.id : e.source
						const t = typeof e.target === 'object' ? e.target.id : e.target
						return `${s}-${t}` === linkId || `${t}-${s}` === linkId
					})
					if (edge && edge.__threeObj) {
						linkGroup = edge.__threeObj
						linkObjMap.set(linkId, linkGroup)
					}
				}
				
				if (!linkGroup) return

				// 在 Group 中找到 Pipe Mesh
				const pipeMesh = linkGroup.children?.find((c: any) => c.userData?.isPipe)
				if (!pipeMesh) return

				const elapsed = now - startTime
				if (elapsed < 0) return

				let progress = Math.min(elapsed / linkFadeDuration, 1)
				if (progress < 1) isAnyAnimating = true
				
				const eased = easeInCubic(progress)
				
				// 更新 Shader Uniform: progress (0 -> 0.7)
				if (pipeMesh.material && pipeMesh.material.uniforms) {
					pipeMesh.material.uniforms.progress.value = eased * 0.7
				}
			})

			if (isAnyAnimating || (now - globalStartTime < totalDuration + 1000)) {
				requestAnimationFrame(animateFrame)
			} else {
				nodeIds.forEach(nodeId => {
					const nodeObj = nodeMap.get(nodeId)
					if (nodeObj?.__threeObj) {
						const depth = depthMap.get(nodeId) ?? 4
						const layerScale = getLayerScaleFactor(depth)
						setNodeOpacityAndGlow(nodeObj.__threeObj, 1, 0, layerScale)
					}
				})
			}
		}

		requestAnimationFrame(animateFrame)
	})
}

// 获取当前图谱节点列表（供父组件匹配用）
function getNodes(): GraphNode[] {
	return graphData.value.nodes
}

// 获取当前图谱连线列表（供父组件匹配用）
function getEdges(): GraphEdge[] {
	return graphData.value.edges
}

defineExpose({
	fetchGraphData,
	handleReset,
	handleRefresh,
	handleDownload,
	highlightElements,
	clearHighlight,
	clearGraphCache,
	getNodes,
	getEdges,
	graphData,
	filteredGraph
})
</script>

<style scoped>
.graph-container {
	width: 100%;
	height: 100%;
	background-color: #0b1220;
    
}

.cursor-wait {
	cursor: wait;
}

.fade-enter-active,
.fade-leave-active {
	transition: opacity 0.6s ease;
}

.fade-enter-from,
.fade-leave-to {
	opacity: 0;
}

/* Tech Spinner Styles */
.loading-spinner {
	position: relative;
	width: 80px;
	height: 80px;
}

.spinner-ring {
	position: absolute;
	inset: 0;
	border-radius: 50%;
	border: 2px solid transparent;
	border-top-color: #06b6d4; /* cyan-500 */
	border-right-color: rgba(6, 182, 212, 0.3);
	box-shadow: 0 0 10px rgba(6, 182, 212, 0.1);
}

.ring-1 {
	animation: spin 1.5s cubic-bezier(0.5, 0, 0.5, 1) infinite;
}

.ring-2 {
	inset: 10px;
	border-top-color: #3b82f6; /* blue-500 */
	border-right-color: rgba(59, 130, 246, 0.3);
	animation: spin-reverse 2s cubic-bezier(0.5, 0, 0.5, 1) infinite;
}

.spinner-core {
	position: absolute;
	inset: 25px;
	background: radial-gradient(circle, #22d3ee 0%, #06b6d4 100%);
	border-radius: 50%;
	animation: pulse 2s ease-in-out infinite;
	box-shadow: 0 0 15px rgba(6, 182, 212, 0.5);
}

@keyframes spin {
	0% { transform: rotate(0deg); }
	100% { transform: rotate(360deg); }
}

@keyframes spin-reverse {
	0% { transform: rotate(360deg); }
	100% { transform: rotate(0deg); }
}

@keyframes pulse {
	0%, 100% { transform: scale(0.8); opacity: 0.8; }
	50% { transform: scale(1.1); opacity: 1; box-shadow: 0 0 25px rgba(6, 182, 212, 0.8); }
}
</style>
