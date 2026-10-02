# Performance verification

Aeonic treats performance claims as reproducible release evidence, not universal guarantees. The
reference profile is a Linux host with 4 vCPU, 8 GiB RAM, SSD-backed local storage, and the supported
Docker Compose deployment.

## Metadata control plane

`pnpm bench:metadata` creates a disposable on-disk installation, seeds 100,000 assets, starts the real
HTTP application with authentication, and requests 50-item asset pages at 20 requests per second for
20 seconds. It fails unless all requests succeed, measured throughput remains within 5% of the target,
p95 latency is at most 200 ms, and request-phase RSS growth stays below 128 MiB.

The workload is configurable for soak and capacity work:

```bash
BENCHMARK_ASSETS=100000 \
BENCHMARK_REQUESTS_PER_SECOND=20 \
BENCHMARK_DURATION_SECONDS=86400 \
pnpm bench:metadata | tee metadata-soak.json
```

Run the command on an otherwise idle reference host. Preserve its JSON output with the release
evidence. A short result from a developer machine is useful for regressions but does not certify the
reference profile.

## Image transformation

`pnpm bench:transform` measures a deterministic 12-megapixel JPEG-to-WebP transformation after two
warm-up runs. It fails if p95 exceeds two seconds or any output hash differs. Increase
`BENCHMARK_SAMPLES` for release evidence; the default is ten measured runs.

## Local original delivery

`pnpm bench:delivery` creates a disposable installation, ingests a public 1 MiB original through
the authenticated upload API, and downloads the complete immutable object 100 times per second for
20 seconds. It fails on an incorrect body length, any HTTP error, less than 95% of target throughput,
p95 time-to-first-byte above 100 ms, or request-phase RSS growth above 128 MiB.

The result applies only to local storage on the benchmark host. It does not describe internet,
proxy, TLS, S3, or client latency. Use `BENCHMARK_DURATION_SECONDS=86400` for a release soak and retain
the JSON output.

## Interpretation

- Compare results only when the host, storage backend, runtime, fixture, and benchmark version match.
- Keep raw JSON, the tested Git commit, container digests, and host details together.
- Investigate latency distributions and memory growth rather than reporting only an average.
- Do not convert local-storage results into S3 or network-delivery claims.
