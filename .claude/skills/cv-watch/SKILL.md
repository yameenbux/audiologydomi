---
name: cv-watch
description: Spot work in this repo that changes what Yameen's CV can claim, and route it to the evidence log in the portfolio repo. Use whenever something ships here, a number gets measured, a status changes, or a claim this repo backs is contradicted. Also use when asked "is this CV-worthy" or "should this go on the CV".
---

# CV watch — satellite

**This is the satellite copy. It keeps no log of its own, on purpose.**

The home of record is `yameenbux/ysbdesignsportfolio`:

- `.claude/skills/cv-watch/SKILL.md` — the full process
- `.claude/skills/cv-watch/EVIDENCE.md` — the single append-only log
- `cv/cv.template.html` — the CV itself

A copy of the log in every project repo would be five logs drifting apart,
and that is the exact failure the portfolio spec records **four separate
times**: a number corrected in one file and left wrong in another. One log,
or it is worse than none.

So the job here is to **notice and report**, not to record.

---

## Notice

When work lands in this repo, ask four questions. Most work fails all four and
saying so takes one line — **do not manufacture a finding to look useful.**

1. **Is there a number here that was measured, not estimated?** Test counts,
   migrations, request volumes, durations, rates. The bar: a figure is usable
   only if the command that reproduces it could be printed underneath it.
   Summing `plan()` lines is not measuring; running the suite is.
2. **Does this prove a capability the CV cannot currently evidence?** Not a
   tool touched once — something built, shipped, and still standing.
3. **Does this change a claim the CV already makes?** A status moving
   pre-launch → live, a count rising, a platform swapped out.
4. **Does this INVALIDATE a claim?** The one most easily missed, and the most
   expensive. A renamed repo, a retired feature, a number that moved, a
   product that has not launched after all.

## Honesty gates

Binding, and carried from the portfolio spec. A claim failing any of these does
not go anywhere near the CV:

- **No invented metrics.** No reach, usage, download or client counts.
- **Nothing about a client's own operations** — roll sizes, role counts,
  registration or charity numbers, office lines, named staff. Those are the
  client's facts, not Yameen's, and several of these repos contain them.
- **A README is a claim, not evidence.** Prefer the running system, the
  schema, the workflow file. The portfolio spec records this being got wrong
  three times.
- **Zero rows means nobody has used it yet, not that it does not exist** — the
  test is whether the function exists and enforces, not whether data does.
- **Built ≠ running ≠ launched.** Keep the three apart, in this repo's own
  words rather than paraphrased upward.

## Report

Tell Yameen in plain terms: what passed, which question it passed on, the
measurement, and where a stranger could verify it. Then say it needs adding to
`EVIDENCE.md` in the portfolio repo.

**Do not edit the CV from here.** It is one page and already full, so every
addition has to displace something — that judgement needs the whole log in
view, which only the portfolio repo has.

If this repo has its own `CLAUDE.md`, that file wins on anything to do with
this project. This skill only governs what gets carried outward.
