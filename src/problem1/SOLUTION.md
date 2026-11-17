# Problem 1: Solution

This solution is delivered in two waves.

**Wave 1 (this commit)** proves the design with running code: the three services, the
ledger, the matcher and its recovery, plus the full test suite. It runs locally with
`make up`. See [README.md](README.md) and [reports/RESULTS.md](reports/RESULTS.md).

**Wave 2** covers what the brief asks for on AWS:

- The overview diagram.
- Why each AWS service was chosen and what the alternatives were.
- The latency budget for p99 < 100 ms at 500 rps.
- The failure-mode table.
- Cost.
- The scaling plan.

The service boundaries, contracts and recovery model in wave 1 carry over unchanged. Only
the infrastructure underneath changes (Aurora, MSK, ElastiCache, ECS, CloudFront and ALB).
