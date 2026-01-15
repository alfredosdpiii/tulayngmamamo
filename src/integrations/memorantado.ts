const MEMORANTADO_URL = process.env.MEMORANTADO_URL ?? "http://127.0.0.1:3789";

export interface MemorantadoEntity {
  name: string;
  entityType: string;
  observations: string[];
}

export interface MemorantadoMemoryItem {
  id: number;
  project: string;
  kind: string;
  title: string | null;
  content: string;
  tags: string[];
  source: string | null;
  created_at: string;
}

async function fetchMemorantado(
  path: string,
  opts: RequestInit = {}
): Promise<Response> {
  const url = new URL(path, MEMORANTADO_URL);
  const port = new URL(MEMORANTADO_URL).port || "3789";

  return fetch(url.toString(), {
    ...opts,
    headers: {
      "Content-Type": "application/json",
      Host: `127.0.0.1:${port}`,
      ...opts.headers,
    },
  });
}

export async function createEntity(
  project: string,
  entity: { name: string; entityType: string; observations?: string[] }
): Promise<MemorantadoEntity | null> {
  try {
    const res = await fetchMemorantado("/api/entity", {
      method: "POST",
      body: JSON.stringify({
        project,
        name: entity.name,
        entityType: entity.entityType,
        observations: entity.observations ?? [],
      }),
    });

    if (!res.ok) return null;
    return res.json() as Promise<MemorantadoEntity>;
  } catch {
    return null;
  }
}

export async function appendMemoryItem(
  project: string,
  item: {
    kind: string;
    title?: string;
    content: string;
    tags?: string[];
    source?: string;
  }
): Promise<MemorantadoMemoryItem | null> {
  try {
    const res = await fetchMemorantado("/api/memory-items", {
      method: "POST",
      body: JSON.stringify({
        project,
        kind: item.kind,
        title: item.title,
        content: item.content,
        tags: item.tags ?? [],
        source: item.source,
      }),
    });

    if (!res.ok) return null;
    return res.json() as Promise<MemorantadoMemoryItem>;
  } catch {
    return null;
  }
}

export async function searchMemoryItems(
  project: string,
  query: string,
  opts: { kind?: string; limit?: number } = {}
): Promise<MemorantadoMemoryItem[]> {
  try {
    const params = new URLSearchParams({
      project,
      q: query,
    });
    if (opts.kind) params.set("kind", opts.kind);
    if (opts.limit) params.set("limit", opts.limit.toString());

    const res = await fetchMemorantado(`/api/memory-items?${params.toString()}`);
    if (!res.ok) return [];

    const data = await res.json() as { items?: MemorantadoMemoryItem[] };
    return data.items ?? [];
  } catch {
    return [];
  }
}

export async function syncConversationSummary(
  conversationId: string,
  title: string,
  summary: string,
  project: string = "tulayngmamamo"
): Promise<void> {
  await createEntity(project, {
    name: `conversation:${conversationId}`,
    entityType: "conversation",
    observations: [
      `Title: ${title}`,
      `Summary: ${summary}`,
      `Synced at: ${new Date().toISOString()}`,
    ],
  });
}

export async function syncResearchFindings(
  conversationId: string,
  topic: string,
  findings: string,
  project: string = "tulayngmamamo"
): Promise<MemorantadoMemoryItem | null> {
  return appendMemoryItem(project, {
    kind: "research",
    title: topic,
    content: findings,
    tags: ["claude-codex-bridge", "research"],
    source: `conversation:${conversationId}`,
  });
}

export async function syncCodeReview(
  conversationId: string,
  reviewType: string,
  review: string,
  project: string = "tulayngmamamo"
): Promise<MemorantadoMemoryItem | null> {
  return appendMemoryItem(project, {
    kind: "code-review",
    title: `${reviewType} Review`,
    content: review,
    tags: ["claude-codex-bridge", "code-review", reviewType],
    source: `conversation:${conversationId}`,
  });
}

export async function isAvailable(): Promise<boolean> {
  try {
    const res = await fetchMemorantado("/api/projects");
    return res.ok;
  } catch {
    return false;
  }
}
