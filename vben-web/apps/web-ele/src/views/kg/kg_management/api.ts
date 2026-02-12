import { baseRequestClient } from '#/api/request';

export async function getDocuments() {
  return baseRequestClient.get('/kg/documents');
}

export async function getCommunities(docId?: string) {
  return baseRequestClient.get('/kg/communities', { params: { doc_id: docId } });
}

export async function getVisualizeData(limit = 100, docId?: string, communityId?: number) {
  const params: Record<string, any> = { limit };
  if (docId) params.doc_id = docId;
  if (communityId !== undefined) params.community_id = communityId;
  return baseRequestClient.get('/kg/visualize', { params });
}

export async function updateNode(nodeId: string, properties: Record<string, any>) {
  return baseRequestClient.put(`/kg/nodes/${nodeId}`, { properties });
}

export async function updateRelation(relationId: string, properties: Record<string, any>) {
  return baseRequestClient.put(`/kg/relations/${relationId}`, { properties });
}

export async function deleteNode(nodeId: string) {
  return baseRequestClient.delete(`/kg/nodes/${nodeId}`);
}

export async function deleteRelation(relationId: string) {
  return baseRequestClient.delete(`/kg/relations/${relationId}`);
}

export async function deleteDocument(docId: string) {
  return baseRequestClient.delete(`/kg/documents/${docId}`);
}

export async function exportDocument(docId: string) {
  return baseRequestClient.get(`/kg/documents/${docId}/export`);
}

export async function cleanupVectors() {
  return baseRequestClient.post('/kg/vectors/cleanup');
}

