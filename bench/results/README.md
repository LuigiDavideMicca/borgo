# results

Output written by `bun bench/run.ts`. Each run produces a pair of files with the
same stem:

- `run-<timestamp>-<label>.json` — everything the runner saw: the environment
  block, the exact parameters, **every individual run** (not just the median),
  the per-status-code breakdown, and the per-process RSS breakdown.
- `run-<timestamp>-<label>.md` — the same data as a readable table.

The JSON is the record; the markdown is a rendering of it. If the two ever
disagree, believe the JSON.

Every file carries a `schema` number, and it is not decoration. **Schema 1**
artefacts store `latencyMs.max` for what is really p99.99, carry no `worst` run,
no response-size sample and no sweep information. **Schema 2** carries all of
them, plus a CPU-idle reading from before and after the campaign. Two payloads
that different cannot share a version number, so they no longer do; check the
field before comparing two files.

## What is committed here

One proof run of **borgo alone**, so the format is visible and the harness is
demonstrably working. It is not a comparison and must not be quoted as one:

- It measures one framework, on one Windows laptop, with the load generator
  sharing the machine.
- It is a demonstration that the pipeline runs end to end, not a result.

It is also **schema 1, and therefore stale**: the harness that produced it has
since been changed in ways that would change what it recorded. The markdown
carries a banner listing exactly which fields do not mean what their names
suggest. It has deliberately not been regenerated, because regenerating it would
mean running a campaign on a machine that was not verified idle, and a
freshly-dated file is more misleading than an openly stale one.

A comparison campaign — every implementation, on a quiet Linux box, with the
load generator on a separate machine — is a separate exercise, and its numbers
belong wherever the release decides to put them, not here.

## Reading a run

Before any number, read [../README.md](../README.md). In particular:

- **The median of the runs is reported, never the best.** The individual runs
  are in the JSON and behind the `individual runs` fold in the markdown; check
  them.
- **Check the run-to-run RSD column.** A large relative standard deviation means
  the median is not telling you much, whatever it says.
- **Check the non-2xx column.** A throughput number attached to failing requests
  is not a throughput number; the runner fails a scenario below a 99% success
  rate, but a few failures can still survive that.
- **Check the `trustworthy` column on the memory table**, and the caveats the
  probe prints under it. The memory probe grades its own output and says when it
  does not believe itself.
- **Check whether the working tree was dirty** in the environment block. If it
  was, the measured code is not exactly the commit named.
- **Check the `cpu busy before the campaign` row.** If the machine was not idle
  before the first app even started, nothing below it is a comparison.
- **Check the `Drift between sweeps` table.** Every app is measured once early
  and once late. Where its two sweeps disagree by more than the run-to-run noise
  inside a sweep, that scenario measured the machine, not the framework.
- **Check the `response bytes` column.** Two frameworks answering the same path
  with different-sized bodies are not doing the same work, and the smaller one
  is not therefore faster.
- **Read the `Configuration, as disclosed by each implementation` table** before
  the results tables. It is where an implementation admits to a tuning knob the
  others were not given, or to being written without the fast mode its framework
  offers.
