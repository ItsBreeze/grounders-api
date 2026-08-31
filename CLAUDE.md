# Repository conventions

## Documentation

**Every self-contained component gets its own README, named after the component.**

The root `README.md` documents the Grounders API itself and nothing else. A
component that could be lifted out of this repository and still make sense —
its own tables, its own env vars, its own route prefixes — is documented in its
own file at the repository root, titled with the application's name:

| Component | Documentation |
|---|---|
| Grounders API | `README.md` |
| Google Multi-Account Connector | `GOOGLE-CONNECTOR.md` |

Decisions and their reasoning go in `PROJECT-LOG.md` — the why behind a choice
does not survive in a diff, and it is what you need when changing that choice.

The root README links to each of them in a short section near the end, saying
what the component is and how it relates to the API, and nothing more. The
detail lives in the component's own file.

The reason is that the two have different readers. Someone wiring up the mobile
app has no use for OAuth scope tables, and someone linking a Google account does
not care how distance aggregates are recalculated. A single README serving both
grows until neither reader can find their half of it.

When adding a new component, create its README in the same commit as the code.
A component whose documentation is still inside the root README has not finished
landing.

## Tests

Suites are plain Node — no framework, no new dependencies. Each is a file under
`test/` with an `npm run test:<name>` script, printing one line per check and
exiting non-zero on failure.

Tests that would otherwise need the network stub `global.fetch` and assert on
what was *about* to go over the wire — the query parameters, the request path,
the multipart framing. That is deliberate: the failures worth catching in this
codebase are calls that succeed while asking the wrong question, and only a
wire-level assertion sees those.

Count the checks and state the total in the component's README when it changes.
