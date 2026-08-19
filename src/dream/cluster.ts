/**
 * Grouping similarity pairs into clusters.
 *
 * Neighbour expansion yields pairs, but consolidation operates on groups: three
 * thoughts that each pair with one another are one duplicate set, not three
 * overlapping decisions. Connected components over the pair graph is the
 * cheapest grouping that never splits a set an operation would want whole.
 */

export interface SimilarityEdge {
  a: string;
  b: string;
  similarity: number;
}

export function clusterByEdges(edges: SimilarityEdge[], threshold: number): string[][] {
  const parent = new Map<string, string>();

  const find = (id: string): string => {
    let root = parent.get(id) ?? id;
    while (root !== (parent.get(root) ?? root)) root = parent.get(root) ?? root;
    return root;
  };

  for (const edge of edges) {
    if (edge.similarity < threshold) continue;
    parent.set(edge.a, parent.get(edge.a) ?? edge.a);
    parent.set(edge.b, parent.get(edge.b) ?? edge.b);
    const rootA = find(edge.a);
    const rootB = find(edge.b);
    if (rootA !== rootB) parent.set(rootB, rootA);
  }

  const groups = new Map<string, string[]>();
  for (const id of parent.keys()) {
    const root = find(id);
    const members = groups.get(root);
    if (members) members.push(id);
    else groups.set(root, [id]);
  }

  return [...groups.values()];
}
