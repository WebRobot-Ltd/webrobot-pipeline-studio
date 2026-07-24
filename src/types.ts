/**
 * Domain types for the native pipeline designer, ported 1:1 from the Vue DemoApp's runtime
 * shapes. Kept in one place so every section maps the backend the same way — the Vue version
 * re-mapped `list` inline in several spots, which is how fields drifted.
 */

export interface Pipeline {
  id: string;
  name: string;
  description: string;
  source: string;
  docLink: string;
  stages: PipelineStage[];
  requiresInputDataset: boolean;
  csvFormatDescription: string | null;
  pipelineYaml: string | null;
  /** Backend flags wizard-saved pipelines (Generated:* agents) so the selector can mark them. */
  isDraft: boolean;
  categoryId: string | number | null;
  categoryName: string;
}

export interface PipelineStage {
  name?: string;
  args?: Record<string, unknown> | string | null;
  [k: string]: unknown;
}

export interface PipelineCategory {
  categoryId: string | number | null;
  categoryName: string;
  items: Pipeline[];
}

/** The exact field mapping loadPipelines() used in the Vue app, against `/tenant/list`. */
export function mapPipeline(demo: any): Pipeline {
  return {
    id: demo.pipeline_name || demo.name,
    name: demo.display_name || demo.name || demo.pipeline_name,
    description: demo.description || 'No description available',
    source: demo.source || demo.pipeline_name,
    docLink: demo.doc_link || 'https://docs.webrobot.eu',
    stages: demo.stages || [],
    requiresInputDataset: demo.requires_input_dataset || false,
    csvFormatDescription: demo.csv_format_description || null,
    pipelineYaml: demo.pipeline_yaml || null,
    isDraft: !!demo.is_draft,
    categoryId: demo.category_id ?? null,
    categoryName: demo.category_name || 'Uncategorized',
  };
}

/** Group pipelines by category, preserving first-seen order — the Vue pipelinesByCategory. */
export function groupByCategory(pipelines: Pipeline[]): PipelineCategory[] {
  const order: (string | number | null)[] = [];
  const byKey = new Map<string, PipelineCategory>();
  for (const p of pipelines) {
    const key = String(p.categoryId ?? p.categoryName);
    let g = byKey.get(key);
    if (!g) {
      g = { categoryId: p.categoryId, categoryName: p.categoryName, items: [] };
      byKey.set(key, g);
      order.push(key as string);
    }
    g.items.push(p);
  }
  return order.map((k) => byKey.get(String(k))!).filter(Boolean);
}

export type ExecutionMode = 'shared' | 'byoc';
export type WizRuntime = 'spark' | 'ray_actor';

export interface ExecutionState {
  executionId: string | null;
  status: 'idle' | 'running' | 'succeeded' | 'failed' | 'cancelled';
  logs: string;
  output: unknown;
  error: string | null;
}
