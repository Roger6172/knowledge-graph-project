/**
 * GraphRAG 知识图谱问答 API
 */
import { baseRequestClient } from '#/api/request';

// 搜索策略类型
export type SearchStrategy = 'auto' | 'local' | 'global' | 'both';

// 实体信息
export interface EntityInfo {
  name: string;
  type: string;
  description?: string;
  neo_id?: number;
  community_id?: number;
  source?: string;
}

// 关系信息
export interface RelationInfo {
  source: string;
  target: string;
  type: string;
  description?: string;
}

// Chunk 信息
export interface ChunkInfo {
  text: string;
  score?: number;
  neo_id?: number;
  metadata?: Record<string, any>;
}

// 社区上下文
export interface CommunityContext {
  community_id: number;
  members: string[];
}

// Local Search 结果
export interface LocalSearchResult {
  success: boolean;
  answer: string;
  entities: EntityInfo[];
  relations: RelationInfo[];
  chunks: ChunkInfo[];
  community_context: CommunityContext[];
}

// Global Search 结果
export interface GlobalSearchResult {
  success: boolean;
  answer: string;
  communities_used: number;
  map_results?: Array<{
    community_id: number;
    entity_count: number;
    answer: string;
    has_relevant_info: boolean;
  }>;
  coverage?: {
    total_communities: number;
    total_entities: number;
  };
  error?: string;
}

// Hybrid Search 结果
export interface HybridSearchResult {
  success: boolean;
  strategy_used: SearchStrategy;
  answer: string;
  local_result?: LocalSearchResult;
  global_result?: GlobalSearchResult;
}

// 聊天消息
export interface KgChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  timestamp: Date;
  // 附加信息（仅 assistant 消息）
  strategy?: SearchStrategy;
  entities?: EntityInfo[];
  relations?: RelationInfo[];
  chunks?: ChunkInfo[];
  communities_used?: number;
  loading?: boolean;
  loadingText?: string;
  error?: string;
}

// 对话历史（用于 API 请求）
export interface ChatHistoryItem {
  role: 'user' | 'assistant';
  content: string;
}

// API 响应包装
interface ApiResponse<T> {
  success: boolean;
  data: T;
  error?: string;
}

// 会话信息
export interface KgSession {
  session_id: string;
  name: string;
  updated_at: string;
  created_at: string;
}

// 会话消息
export interface KgSessionMessage {
  role: 'user' | 'assistant';
  content: string;
  timestamp: string;
  sources?: {
    local?: LocalSearchResult;
    global?: GlobalSearchResult;
  };
}

/**
 * GraphRAG Hybrid Search - 混合搜索
 * @param question 用户问题
 * @param strategy 搜索策略
 * @param topK 返回的候选数量
 * @param chatHistory 对话历史（用于上下文）
 * @param sessionId 会话 ID（用于持久化）
 * @param docId 文档 ID（用于限定检索范围）
 */
export async function hybridSearch(
  question: string,
  strategy: SearchStrategy = 'auto',
  topK: number = 5,
  chatHistory: ChatHistoryItem[] = [],
  sessionId?: string,
  docId?: string
): Promise<HybridSearchResult> {
  const axiosResponse = await baseRequestClient.post<ApiResponse<HybridSearchResult>>(
    '/kg/graphrag/hybrid_search',
    {
      question,
      strategy,
      top_k: topK,
      chat_history: chatHistory,
      session_id: sessionId,
      doc_id: docId,
    },
    {
      timeout: 60000, // 60 秒超时
    }
  );
  const response = axiosResponse.data as unknown as ApiResponse<HybridSearchResult>;
  if (!response.success) {
    throw new Error(response.error || '搜索失败');
  }
  return response.data;
}

/**
 * 获取 KG 会话列表
 */
export async function getKgSessions(): Promise<KgSession[]> {
  const axiosResponse = await baseRequestClient.get<ApiResponse<KgSession[]>>('/kg/sessions');
  const response = axiosResponse.data as unknown as ApiResponse<KgSession[]>;
  if (!response.success) {
    throw new Error(response.error || '获取会话列表失败');
  }
  return response.data;
}

/**
 * 创建新的 KG 会话
 */
export async function createKgSession(name?: string): Promise<{ session_id: string; name: string }> {
  const axiosResponse = await baseRequestClient.post<ApiResponse<{ session_id: string; name: string }>>(
    '/kg/sessions',
    { name }
  );
  const response = axiosResponse.data as unknown as ApiResponse<{ session_id: string; name: string }>;
  if (!response.success) {
    throw new Error(response.error || '创建会话失败');
  }
  return response.data;
}

/**
 * 获取会话消息历史
 */
export async function getKgSessionMessages(sessionId: string): Promise<KgSessionMessage[]> {
  const axiosResponse = await baseRequestClient.get<ApiResponse<KgSessionMessage[]>>(
    `/kg/sessions/${sessionId}/messages`
  );
  const response = axiosResponse.data as unknown as ApiResponse<KgSessionMessage[]>;
  if (!response.success) {
    throw new Error(response.error || '获取消息历史失败');
  }
  return response.data;
}

/**
 * 删除会话
 */
export async function deleteKgSession(sessionId: string): Promise<void> {
  const axiosResponse = await baseRequestClient.delete<ApiResponse<void>>(
    `/kg/sessions/${sessionId}`
  );
  const response = axiosResponse.data as unknown as ApiResponse<void>;
  if (!response.success) {
    throw new Error(response.error || '删除会话失败');
  }
}

/**
 * GraphRAG Local Search - 局部搜索
 */
export async function localSearch(
  question: string,
  topK: number = 5
): Promise<LocalSearchResult> {
  const axiosResponse = await baseRequestClient.post<ApiResponse<LocalSearchResult>>(
    '/kg/graphrag/local_search',
    {
      question,
      top_k: topK,
    }
  );
  const response = axiosResponse.data as unknown as ApiResponse<LocalSearchResult>;
  if (!response.success) {
    throw new Error(response.error || '搜索失败');
  }
  return response.data;
}

/**
 * GraphRAG Global Search - 全局搜索
 */
export async function globalSearch(
  question: string,
  maxCommunities: number = 10
): Promise<GlobalSearchResult> {
  const axiosResponse = await baseRequestClient.post<ApiResponse<GlobalSearchResult>>(
    '/kg/graphrag/global_search',
    {
      question,
      max_communities: maxCommunities,
    }
  );
  const response = axiosResponse.data as unknown as ApiResponse<GlobalSearchResult>;
  if (!response.success) {
    throw new Error(response.error || '搜索失败');
  }
  return response.data;
}

/**
 * 获取图谱统计信息
 */
export async function getGraphStats(): Promise<{
  nodes: number;
  edges: number;
  communities?: number;
}> {
  const axiosResponse = await baseRequestClient.get<ApiResponse<any>>('/kg/stats');
  const response = axiosResponse.data as unknown as ApiResponse<any>;
  if (!response.success) {
    throw new Error(response.error || '获取统计信息失败');
  }
  return response.data;
}

/**
 * 触发社区检测
 */
export async function detectCommunities(): Promise<{
  success: boolean;
  communities: Array<{
    community_id: number;
    members: string[];
    size: number;
  }>;
  total_communities: number;
  total_entities: number;
  error?: string;
}> {
  const axiosResponse = await baseRequestClient.post<ApiResponse<any>>(
    '/kg/graphrag/detect_communities'
  );
  const response = axiosResponse.data as unknown as ApiResponse<any>;
  if (!response.success) {
    throw new Error(response.error || '社区检测失败');
  }
  return response.data;
}

/**
 * 生成所有社区报告
 */
export async function generateCommunityReports(): Promise<{
  success: boolean;
  total_communities: number;
  generated_reports: number;
}> {
  const axiosResponse = await baseRequestClient.post<ApiResponse<any>>(
    '/kg/graphrag/generate_reports'
  );
  const response = axiosResponse.data as unknown as ApiResponse<any>;
  if (!response.success) {
    throw new Error(response.error || '生成报告失败');
  }
  return response.data;
}

/**
 * 简单问答（使用原有的 graph_rag_qa 接口）
 */
export async function simpleQA(
  question: string,
  topK: number = 5
): Promise<{
  success: boolean;
  answer: string;
  candidates: any[];
  raw_docs: any[];
}> {
  const axiosResponse = await baseRequestClient.post<ApiResponse<any>>('/kg/graph_rag_qa', {
    question,
    top_k: topK,
  }, {
    timeout: 60000, // 60 秒超时
  });
  const response = axiosResponse.data as unknown as ApiResponse<any>;
  if (!response.success) {
    throw new Error(response.error || '问答失败');
  }
  return response.data;
}

/**
 * 获取可视化数据
 * @param limit 返回节点数量限制
 * @param docId 文档 ID，按文档筛选图谱范围
 * @param communityId 社区 ID，按社区筛选图谱范围
 */
export async function getVisualizeData(
  limit = 100,
  docId?: string,
  communityId?: number
): Promise<{
  nodes: Array<{ id: string; name: string; category: string }>;
  links: Array<{ source: string; target: string; label: string }>;
}> {
  const params: Record<string, any> = { limit };
  if (docId) params.doc_id = docId;
  if (communityId !== undefined) params.community_id = communityId;
  
  const axiosResponse = await baseRequestClient.get<ApiResponse<any>>('/kg/visualize', { params });
  const response = axiosResponse.data as unknown as ApiResponse<any>;
  if (!response.success) {
    throw new Error(response.error || '获取可视化数据失败');
  }
  return response.data;
}

/**
 * 获取文档列表
 */
export interface DocumentInfo {
  doc_id: string;
  title?: string;
  created_at?: string;
}

export async function getDocuments(): Promise<DocumentInfo[]> {
  const axiosResponse = await baseRequestClient.get<ApiResponse<{ documents: DocumentInfo[] }>>('/kg/documents');
  const response = axiosResponse.data as unknown as ApiResponse<{ documents: DocumentInfo[] }>;
  if (!response.success) {
    throw new Error(response.error || '获取文档列表失败');
  }
  return response.data?.documents || [];
}
