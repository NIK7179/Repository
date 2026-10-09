import type { NodeCategory } from '@pitch2plan/schemas';

/**
 * The single place that knows about technology branding and documentation. The UI never imports icons directly.
 * We do NOT ship third-party trademarked logos: known technologies get a monogram badge in a neutral brand-adjacent colour,
 * and everything else falls back to a clean generic icon for its category. A missing entry can never break the architecture view.
 */
export interface TechnologyInfo { slug: string; displayName: string; provider: string | null; monogram: string; color: string; documentationUrl: string; category: NodeCategory | null }

const T = (slug: string, displayName: string, provider: string | null, monogram: string, color: string, documentationUrl: string, category: NodeCategory | null = null): [string, TechnologyInfo] =>
  [slug, { slug, displayName, provider, monogram, color, documentationUrl, category }];

export const TECHNOLOGY_REGISTRY: Record<string, TechnologyInfo> = Object.fromEntries([
  T('apache-kafka', 'Apache Kafka', 'Apache', 'Ka', '#4b5563', 'https://kafka.apache.org/documentation/', 'EVENT_STREAM'),
  T('apache-spark', 'Apache Spark', 'Apache', 'Sp', '#c2410c', 'https://spark.apache.org/docs/latest/', 'STREAM_PROCESSOR'),
  T('apache-flink', 'Apache Flink', 'Apache', 'Fl', '#be185d', 'https://nightlies.apache.org/flink/', 'STREAM_PROCESSOR'),
  T('aws-s3', 'Amazon S3', 'AWS', 'S3', '#15803d', 'https://docs.aws.amazon.com/s3/', 'OBJECT_STORAGE'),
  T('aws-kinesis', 'Amazon Kinesis', 'AWS', 'Ki', '#7c3aed', 'https://docs.aws.amazon.com/kinesis/', 'EVENT_STREAM'),
  T('aws-sqs', 'Amazon SQS', 'AWS', 'Sq', '#b45309', 'https://docs.aws.amazon.com/sqs/', 'QUEUE'),
  T('aws-lambda', 'AWS Lambda', 'AWS', 'λ', '#c2410c', 'https://docs.aws.amazon.com/lambda/'),
  T('aws-rds-postgresql', 'Amazon RDS for PostgreSQL', 'AWS', 'Pg', '#1d4ed8', 'https://docs.aws.amazon.com/rds/', 'DATABASE'),
  T('postgresql', 'PostgreSQL', null, 'Pg', '#1d4ed8', 'https://www.postgresql.org/docs/', 'DATABASE'),
  T('mysql', 'MySQL', null, 'My', '#0369a1', 'https://dev.mysql.com/doc/', 'DATABASE'),
  T('mongodb', 'MongoDB', null, 'Mg', '#15803d', 'https://www.mongodb.com/docs/', 'DATABASE'),
  T('redis', 'Redis', null, 'Rd', '#b91c1c', 'https://redis.io/docs/', 'CACHE'),
  T('opensearch', 'OpenSearch', null, 'Os', '#0e7490', 'https://opensearch.org/docs/', 'SEARCH'),
  T('elasticsearch', 'Elasticsearch', null, 'Es', '#0e7490', 'https://www.elastic.co/guide/', 'SEARCH'),
  T('rabbitmq', 'RabbitMQ', null, 'Rb', '#c2410c', 'https://www.rabbitmq.com/docs', 'QUEUE'),
  T('kubernetes', 'Kubernetes', null, 'K8', '#1d4ed8', 'https://kubernetes.io/docs/'),
  T('docker', 'Docker', null, 'Dk', '#0369a1', 'https://docs.docker.com/'),
  T('terraform', 'Terraform', null, 'Tf', '#6d28d9', 'https://developer.hashicorp.com/terraform/docs', 'CI_CD'),
  T('github-actions', 'GitHub Actions', 'GitHub', 'GA', '#374151', 'https://docs.github.com/actions', 'CI_CD'),
  T('openai', 'OpenAI API', 'OpenAI', 'Ai', '#047857', 'https://platform.openai.com/docs', 'AI_MODEL'),
  T('anthropic', 'Anthropic Claude', 'Anthropic', 'Cl', '#b45309', 'https://docs.anthropic.com/', 'AI_MODEL'),
  T('anthropic-claude', 'Anthropic Claude', 'Anthropic', 'Cl', '#b45309', 'https://docs.anthropic.com/', 'AI_MODEL'),
  T('nextjs', 'Next.js', 'Vercel', 'Nx', '#111827', 'https://nextjs.org/docs', 'CLIENT'),
  T('react', 'React', 'Meta', 'Re', '#0e7490', 'https://react.dev/', 'CLIENT'),
  T('nodejs', 'Node.js', null, 'No', '#15803d', 'https://nodejs.org/docs/latest/api/', 'API'),
  T('prometheus', 'Prometheus', null, 'Pr', '#c2410c', 'https://prometheus.io/docs/', 'OBSERVABILITY'),
  T('grafana', 'Grafana', null, 'Gr', '#ea580c', 'https://grafana.com/docs/', 'OBSERVABILITY'),
].map(([k, v]) => [k, v] as const));

export interface ResolvedTechnology { displayName: string; provider: string | null; monogram: string; color: string | null; documentationUrl: string | null; known: boolean }

export function resolveTechnology(slug: string, fallbackName: string, provider?: string | null): ResolvedTechnology {
  const hit = TECHNOLOGY_REGISTRY[slug.toLowerCase()];
  if (hit) return { displayName: hit.displayName, provider: hit.provider ?? provider ?? null, monogram: hit.monogram, color: hit.color, documentationUrl: hit.documentationUrl, known: true };
  return { displayName: fallbackName, provider: provider ?? null, monogram: fallbackName.replace(/[^A-Za-z0-9]/g, '').slice(0, 2) || '?', color: null, documentationUrl: null, known: false };
}

/** Generic category glyphs (24x24 stroke paths). Used when a technology has no registry entry. */
export const CATEGORY_GLYPH: Record<string, string> = {
  CLIENT: 'M3 5h18v11H3zM8 20h8M12 16v4', EDGE: 'M12 3a9 9 0 100 18 9 9 0 000-18zM3 12h18M12 3c3 3 3 15 0 18M12 3c-3 3-3 15 0 18',
  API: 'M8 8l-4 4 4 4M16 8l4 4-4 4M14 5l-4 14', APPLICATION_SERVICE: 'M4 6h16v5H4zM4 13h16v5H4zM7 8.5h.01M7 15.5h.01',
  AUTH: 'M7 11V8a5 5 0 0110 0v3M5 11h14v9H5z', DATABASE: 'M4 6c0-1.7 3.6-3 8-3s8 1.3 8 3-3.6 3-8 3-8-1.3-8-3zM4 6v12c0 1.7 3.6 3 8 3s8-1.3 8-3V6M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3',
  CACHE: 'M13 3L5 14h6l-1 7 8-11h-6z', QUEUE: 'M4 7h12M4 12h16M4 17h12M18 5l3 2-3 2', EVENT_STREAM: 'M3 12h4l2-6 4 12 2-6h6',
  STREAM_PROCESSOR: 'M3 8h6l3 8h9M3 16h6M17 6l4 2-4 2', BATCH_PROCESSOR: 'M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h6v6h-6z',
  OBJECT_STORAGE: 'M4 8l8-4 8 4v8l-8 4-8-4zM4 8l8 4 8-4M12 12v8', DATA_WAREHOUSE: 'M4 20V10M10 20V4M16 20v-8M22 20H2', SEARCH: 'M11 4a7 7 0 100 14 7 7 0 000-14zM21 21l-5-5',
  AI_MODEL: 'M9 3v3M15 3v3M9 18v3M15 18v3M3 9h3M3 15h3M18 9h3M18 15h3M7 7h10v10H7z', VECTOR_DATABASE: 'M5 19L19 5M5 5h.01M19 19h.01M12 12h.01M5 19h.01M19 5h.01',
  OBSERVABILITY: 'M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12zM12 9a3 3 0 100 6 3 3 0 000-6z', SECURITY: 'M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z',
  CI_CD: 'M6 3v12M6 15a3 3 0 100 6 3 3 0 000-6zM18 9a3 3 0 100-6 3 3 0 000 6zM18 9v3a3 3 0 01-3 3H9', NETWORK: 'M12 3v6M12 15v6M3 12h6M15 12h6M9 9h6v6H9z',
  EXTERNAL_SERVICE: 'M14 4h6v6M20 4l-9 9M10 6H5v13h13v-5', OTHER: 'M5 5h14v14H5z',
};
