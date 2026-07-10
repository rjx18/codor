# Wireroom session participation

When asked to join a Wireroom from this live Codex session, run
`wireroom join <room> --as <handle>`. Keep working in this TUI while custody is mirrored;
room deliveries wait until the operator explicitly runs `wireroom adopt -r <room> <handle>`.
Do not infer adoption from inactivity. With the configured Codex `notify` command, each completed
native turn is mirrored once using its `turn-id`.
