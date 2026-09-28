# Optional semantic search

Aeonic can combine its local SQLite FTS5 catalog with provider-backed media understanding and vector retrieval. The feature is disabled by default: uploads, transformations, delivery, and lexical search continue to work without an AI provider or Qdrant.

## Start the optional profile

1. Copy `.env.compose.example` to `.env` and keep `AI_ENABLED=false` until the services are configured.
2. Create `secrets/ai-provider-api-key.txt` and `secrets/qdrant-api-key.txt`. The directory is ignored by Git. Use restrictive host permissions and a long random Qdrant value.
3. Pin explicit provider model snapshots in `AI_VISION_MODEL` and `AI_EMBEDDING_MODEL`. Set the matching embedding dimensions and the provider's input/output rates in micro-US dollars per million units.
4. Set `AI_ENABLED=true`, then run `docker compose --profile ai up --build`.
5. In **Settings → Optional AI capabilities**, set a monthly ceiling, decide whether private assets may leave the installation, enable the project, save, and build a candidate index.

The API and AI worker read credentials from mounted files. Images are downscaled before transfer; video is sampled into bounded keyframes; PDF and Office documents are converted and text-extracted locally. Provider output is treated as untrusted content.

## Activation and rollback

Reindexing creates a new Qdrant collection. The existing active index continues serving requests while the candidate is built. Before activation, Aeonic runs versioned self-retrieval probes, calculates Recall@10 and nDCG@10, and verifies that deliberately foreign tenant filters return no results. The candidate activates atomically only when all thresholds pass; otherwise it is marked failed.

SQLite remains authoritative. Every vector candidate is checked against the requesting organization/project, current asset version, non-deleted asset state, and active index record before it can appear in a response. A provider or Qdrant outage degrades search to local FTS5 and does not affect core media operations.

## Privacy, spend, and deletion controls

- Enablement, private-media consent, monthly spend ceiling, maximum assets per run, and concurrency are project-scoped.
- Usage is recorded by provider, model, operation, index, input/output units, and calculated micro-USD cost.
- Asset exclusion immediately removes relational index records and queues vector deletion from every live collection.
- Deleting an index removes its relational provenance and queues collection deletion.
- A queued or running candidate can be cancelled safely by deleting it; workers use leases, timeouts, and bounded retries.

The first release supports one external provider adapter (`openai`) behind internal vision and embedding interfaces. Qdrant is pinned and isolated on the internal Compose network with no host port.
