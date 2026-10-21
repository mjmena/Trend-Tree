# Coding Standards

`/code-review` checks every diff against this file. A breach of a rule here is a hard
violation, not a judgement call.

## Comments

Let names and structure carry what the code does. A comment states only a why the code
cannot show:

- a workaround, and the condition for deleting it
- a non-obvious invariant or contract with another step or system
- a line that looks wrong and that someone would otherwise "fix"

Keep a comment to three lines or fewer. Match the comment density of the surrounding code.

Put ticket keys (`CRMA-nnn`, `#92`), ADR references, and change history ("used to",
"predates", "now") in the commit message and the ADR, where they stay true. In the code
they go stale on the next change.

When you edit a function, leave its existing comments as they are unless the edit makes
one untrue — then fix or delete that one.
