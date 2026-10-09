import { TECH_DOCS } from '@pitch2plan/schemas';
import { FetchError } from './knowledge-fetcher';
import type { DocumentFetcher, FetchedDocument } from './ports';

/**
 * TEST FIXTURES — NOT real documentation (invariant K7).
 * Short paraphrased pages with the same URLs as the registry's seed pages, titled "[Test fixture] …" so they can never be mistaken for vendor text.
 * The fixture fetcher refuses to run unless explicitly allowed (ALLOW_FIXTURE_DOCS=true), so production cannot silently index them.
 */
const html = (title: string, sections: Array<[string, string]>) =>
  `<html><head><title>[Test fixture] ${title}</title></head><body><nav>Home Docs Search</nav><main><h1>[Test fixture] ${title}</h1>${sections.map(([h, b]) => `<h2>${h}</h2><p>${b}</p>`).join('')}</main><footer>Privacy Terms</footer></body></html>`;

export const FIXTURE_PAGES: Record<string, string> = {
  'https://kafka.apache.org/documentation/': html('Apache Kafka documentation', [
    ['Consumer lag', 'Consumer lag is the gap between the latest offset written to a partition and the offset a consumer group has committed. Growing lag means consumers cannot keep up with producers. Watch lag per partition to find a slow consumer or a hot partition.'],
    ['Partitions and parallelism', 'A topic is split into partitions. A partition is read by at most one consumer in a group, so the partition count caps consumer parallelism. Choose the partition count from the throughput you need divided by what one consumer can process.'],
    ['Retention', 'Retention controls how long records are kept. Records can be deleted after a time or size limit, which also bounds how far a consumer can replay.'],
    ['Authentication', 'Clients can authenticate with SASL mechanisms or mutual TLS. Encrypt traffic with TLS and restrict access to topics with ACLs.'],
  ]),
  'https://docs.aws.amazon.com/msk/latest/developerguide/iam-access-control.html': html('Amazon MSK IAM access control', [
    ['IAM access control for clients', 'Amazon MSK can authenticate and authorize Kafka clients with AWS IAM, so no separate Kafka passwords are stored. Clients connect over TLS to the IAM listener port of the cluster and sign requests with their IAM role credentials.'],
    ['Java client configuration', 'A Java Kafka client uses the SASL_SSL security protocol with the AWS_MSK_IAM mechanism and the IAM login module, and the MSK IAM authentication library on the classpath. The application assumes an IAM role, for example through an instance profile or a task role, instead of embedding access keys.'],
    ['Authorization policies', 'Attach an IAM policy to the client role that grants kafka-cluster actions such as Connect, DescribeTopic, ReadData and WriteData on the specific cluster, topic and group resources. Prefer least privilege over wildcard resources.'],
  ]),
  'https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/USER_WorkingWithAutomatedBackups.html': html('Amazon RDS automated backups', [
    ['Automated backups', 'Amazon RDS takes daily snapshots of a DB instance and keeps transaction logs, which enables point-in-time restore within the backup retention period. The retention period can be set from one to thirty-five days; zero turns automated backups off.'],
    ['Backup window', 'Choose a backup window with low write activity. Backups do not replace tested restores: restore into a new instance regularly to verify that the backup works.'],
    ['Manual snapshots', 'Manual snapshots are kept until you delete them and are useful before risky changes. Copy snapshots to another region for disaster recovery.'],
  ]),
  'https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/PostgreSQL.Concepts.General.SSL.html': html('Using SSL with an RDS for PostgreSQL instance', [
    ['Encryption in transit', 'RDS for PostgreSQL supports TLS connections. Download the RDS certificate bundle and configure the client to verify the server certificate rather than only encrypting the channel. A parameter can force all connections to use TLS.'],
  ]),
  'https://docs.aws.amazon.com/AmazonS3/latest/userguide/UsingEncryption.html': html('Amazon S3 data protection and encryption', [
    ['Default encryption', 'New objects in a bucket are encrypted at rest by default. You can choose server-side encryption with S3 managed keys or with AWS KMS keys when you need key-level audit and control.'],
    ['Block public access', 'Enable block public access at the bucket and account level unless the bucket is meant to be public, and verify the bucket policy with a test object.'],
  ]),
  'https://docs.aws.amazon.com/AmazonS3/latest/userguide/lifecycle-configuration-examples.html': html('Amazon S3 lifecycle configuration examples', [
    ['Lifecycle rules', 'A lifecycle rule moves objects to cheaper storage classes after a number of days or expires them. Scope rules with a prefix or tag filter and test them on a small prefix first.'],
  ]),
  'https://docs.aws.amazon.com/streams/latest/dev/introduction.html': html('Amazon Kinesis Data Streams introduction', [
    ['Shards and throughput', 'A Kinesis data stream is made of shards, and each shard provides a fixed read and write capacity. Capacity can be provisioned per shard or managed on demand.'],
  ]),
  'https://docs.aws.amazon.com/IAM/latest/UserGuide/best-practices.html': html('IAM security best practices', [
    ['Temporary credentials', 'Use roles with temporary credentials for workloads instead of long-lived access keys, and grant least privilege.'],
  ]),
  'https://www.postgresql.org/docs/current/runtime-config-connection.html': html('PostgreSQL connection settings', [
    ['Connections and TLS', 'The maximum number of connections is limited by a server setting. Enable TLS on the server and require it for remote clients in the client authentication file.'],
  ]),
  'https://www.postgresql.org/docs/current/continuous-archiving.html': html('PostgreSQL continuous archiving and point-in-time recovery', [
    ['Base backups and WAL', 'Point-in-time recovery combines a base backup with archived write-ahead log files. Self-managed servers must configure archiving and test restores themselves.'],
  ]),
  'https://redis.io/docs/latest/operate/oss_and_stack/management/security/': html('Redis security', [
    ['Access control', 'Do not expose Redis to the public internet. Require authentication with access control lists and restrict the network.'],
  ]),
  'https://docs.docker.com/engine/security/': html('Docker Engine security', [
    ['Container isolation', 'Run containers as a non-root user and avoid mounting the Docker socket into containers.'],
  ]),
  'https://kubernetes.io/docs/concepts/services-networking/service/': html('Kubernetes Service', [
    ['Service types', 'A Service exposes pods behind a stable address. ClusterIP is reachable only inside the cluster and is the default. NodePort opens a port on every node. LoadBalancer asks the cloud provider for an external load balancer. Choose the narrowest type that meets the need.'],
    ['Internal services', 'Services that only other workloads call should stay ClusterIP, and use network policies to limit who can reach them.'],
  ]),
  'https://kubernetes.io/docs/concepts/services-networking/ingress/': html('Kubernetes Ingress', [
    ['Ingress', 'An Ingress routes external HTTP and HTTPS traffic to services by host and path, typically behind a single load balancer. It needs an ingress controller to be installed and can terminate TLS.'],
  ]),
  'https://nextjs.org/docs/app/guides/authentication': html('Next.js authentication', [
    ['Server-side checks', 'Authentication and authorization must be verified on the server for every sensitive data access, not only in client components.'],
  ]),
  'https://nodejs.org/docs/latest/api/process.html': html('Node.js process', [
    ['Environment', 'Configuration such as secrets can be read from environment variables on the server process. Never expose them to browser bundles.'],
  ]),
  'https://docs.python.org/3/library/asyncio.html': html('Python asyncio', [
    ['Async I/O', 'The asyncio library runs coroutines on an event loop for concurrent I/O.'],
  ]),
  'https://docs.claude.com/en/api/overview': html('Anthropic API overview', [
    ['API keys', 'API requests are authenticated with an API key sent in a request header. Treat API keys as secret credentials: keep them on the server in a secrets manager or environment variable, never in browser code or in a public repository, and rotate a key that may have leaked.'],
    ['Usage and limits', 'Each organization has rate limits. Handle rate limit errors with retries and backoff.'],
  ]),
  'https://learn.microsoft.com/azure/ai-services/openai/overview': html('Azure OpenAI overview', [
    ['Resources and deployments', 'Azure OpenAI is accessed through an Azure resource with named model deployments. Authentication can use keys or Microsoft Entra ID.'],
  ]),
  'https://spark.apache.org/docs/latest/structured-streaming-programming-guide.html': html('Spark Structured Streaming', [
    ['Checkpointing', 'A streaming query needs a checkpoint location so it can recover its progress after a failure and provide end-to-end guarantees with replayable sources.'],
  ]),
};

export class FixtureDocumentFetcher implements DocumentFetcher {
  /** `overrides` lets a test replace a page (for example with a prompt-injection page); `missing` simulates removed or failing pages. */
  constructor(private readonly o: { allow: boolean; overrides?: Record<string, string>; failing?: Record<string, FetchError>; delayMs?: number }) {}
  readonly calls: string[] = [];
  async fetch(url: string): Promise<FetchedDocument> {
    if (!this.o.allow) throw new FetchError('FIXTURES_DISABLED', 'Fixture documentation is disabled. Set ALLOW_FIXTURE_DOCS=true for tests only.');
    this.calls.push(url);
    if (this.o.delayMs) await new Promise((r) => setTimeout(r, this.o.delayMs));
    const failing = this.o.failing?.[url]; if (failing) throw failing;
    const body = this.o.overrides?.[url] ?? FIXTURE_PAGES[url];
    if (body === undefined) throw new FetchError('NOT_FOUND', 'No fixture for this URL.');
    return { finalUrl: url, contentType: 'text/html', body: String(body), lastModified: null };
  }
}

/** Guard used by tests: every registry seed URL has a fixture. */
export const FIXTURE_COVERS_REGISTRY = TECH_DOCS.every((t) => t.seedUrls.every((u) => u in FIXTURE_PAGES));
