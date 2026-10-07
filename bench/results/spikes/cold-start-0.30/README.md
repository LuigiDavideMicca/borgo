# Cold start of the 0.30 image

The measurement behind docs/deploy.md, "Cold start, measured". Build the
example's image from the repository root and run the script:

    docker build -f examples/tasks/Dockerfile -t zz-cold .
    bun bench/results/spikes/cold-start-0.30/cold.ts

It issues `docker run`, polls `/healthz` and `/` every 15 ms from that
moment, and reports each run and the median of five.

Run on 2026-10-07, Docker Desktop (WSL2), Windows 11, i7-1165G7, with
the machine not idle (an editor and other sessions running):

| run | first `"status":"ok"` on /healthz | first 200 on / |
| --- | --- | --- |
| 1 | 512 ms | 526 ms |
| 2 | 402 ms | 416 ms |
| 3 | 408 ms | 423 ms |
| 4 | 369 ms | 385 ms |
| 5 | 376 ms | 396 ms |
| median | 402 ms | 416 ms |

On 0.22 the same method, with a scaffolded `full` app, gave 330 ms and
343 ms. The image differs (examples/tasks migrates a sqlite database
with gorm at boot) and so did the machine's load, so the two are not a
before-and-after of the topology.
