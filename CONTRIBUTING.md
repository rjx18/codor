# Contributing to Codor

Thanks for helping improve Codor. Small fixes, documentation, bug reports, and
larger features are all welcome.

## The quick path

1. Create a focused branch from the latest `main`.
2. Make one coherent change and add tests when behavior changes.
3. Run the relevant tests locally.
4. Open a pull request explaining what changed, why, and what you tested.

For most changes, these are the useful gates:

```sh
pnpm install --frozen-lockfile
pnpm -r build
pnpm -r test
```

If you changed the browser UI, also run the relevant Playwright tests. A
maintainer can help identify the smallest useful test command.

## Harn: important, but not a barrier to contributing

Codor uses [Harn](https://github.com/rjx18/harn) to record important behavioral
assumptions and check that sensitive changes were planned deliberately.

**You may open a pull request without installing or learning Harn.** We do not
want the guardrail to discourage a useful contribution. If your change needs a
Harn plan, a maintainer can help write it or reapply your patch onto a planned
branch before merge.

The one hard rule: **do not edit `.harn/assumptions/` or Harn hashes directly.**
Those files are generated truth. Describe the behavior you intend to change in
the pull request instead.

Harn review is usually needed when a change affects a protocol, authorization,
persistence, state machine, process lifecycle, compatibility contract, or other
important runtime behavior. A typo or ordinary documentation improvement does
not require contributors to learn the full workflow.

<details>
<summary>If you already use Harn</summary>

Please follow the repository's plan-first flow:

```sh
harn find
harn plan check <plan-id>
harn plan lock <plan-id>
# implement and test
harn check <plan-id>
```

Lock the plan before implementation. Do not create an after-the-fact plan to
justify code that is already written. The implementation commit should include
the applied plan and generated assumption updates.

</details>

## Make the pull request easy to review

Please include:

- the user-visible problem and intended result;
- the important implementation or compatibility decisions;
- exact test commands and results;
- screenshots for visible UI changes;
- any platform, provider, or real-device behavior you could not test.

Keep unrelated changes in separate pull requests. Large platform ports, new
agent adapters, migrations, and release/version changes are much easier to
review independently.

If you are unsure about scope, open the pull request early as a draft. A
maintainer will help shape it rather than asking you to predict every internal
contract up front.
