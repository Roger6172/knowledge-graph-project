import { baseRequestClient } from '#/api/request';

/**
 * 上传文档并构建知识图谱 (耗时操作，超时时间设置为 300 秒)
 */
export async function uploadDocument(text: string, documentId?: string, documentTitle?: string) {
  return baseRequestClient.post('/kg/upload', {
    text,
    document_id: documentId,
    document_title: documentTitle,
  }, {
    timeout: 300000 // 300 秒
  });
}

/**
 * 简易入库 (Ingest)
 */
export async function ingestText(text: string, docId?: string, kbId?: string, filename?: string) {
  return baseRequestClient.post('/kg/ingest', {
    text,
    doc_id: docId,
    kb_id: kbId,
    filename,
  }, {
    timeout: 300000 // 300 秒
  });
}

/**
 * 触发社区检测 (耗时操作，超时时间设置为 300 秒)
 */
export async function detectCommunities(writeProperty = true) {
  return baseRequestClient.post('/kg/graphrag/detect_communities', {
    write_property: writeProperty,
  }, {
    timeout: 300000 // 300 秒
  });
}

/**
 * 生成社区报告 (耗时操作，超时时间设置为 300 秒)
 */
export async function generateCommunityReports() {
  return baseRequestClient.post('/kg/graphrag/generate_reports', {}, {
    timeout: 300000 // 300 秒
  });
}

/**
 * 获取图谱统计信息
 */
export async function getGraphStats() {
  return baseRequestClient.get('/kg/stats');
}

/**
 * 获取可视化数据
 * @param limit 返回节点数量限制
 * @param docId 文档 ID，按文档筛选图谱范围
 * @param communityId 社区 ID，按社区筛选图谱范围
 */
export async function getVisualizeData(limit = 100, docId?: string, communityId?: number) {
  const params: Record<string, any> = { limit };
  if (docId) params.doc_id = docId;
  if (communityId !== undefined) params.community_id = communityId;
  return baseRequestClient.get('/kg/visualize', { params });
}
