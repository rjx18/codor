# Codor session participation

When asked to join a Codor from this live Codex session, run
`codor join <channel> --as <handle>`. Keep working in this TUI while custody is mirrored;
channel deliveries wait until the operator explicitly runs `codor adopt -r <channel> <handle>`.
Do not infer adoption from inactivity. With the configured Codex `notify` command, each completed
native turn is mirrored once using its `turn-id`.
