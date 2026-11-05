---
name: asking-questions
description: When a request is ambiguous, missing a target, or could mean two materially different things, ask a small set of clickable questions with ask_user before acting.
---

# Asking the right question
1. Restate the target and outcome in one line.
2. Identify the single missing fact that would change the work: which project, which file, which platform, which definition, which scope.
3. If the answer is discoverable by reading the repo, read it instead of asking.
4. If not, call `ask_user` with 1-3 short questions. Each has 2-4 options, a recommended option first labelled "(Recommended)", and `allowOther: true` when the list may miss the real answer.
5. After the answer, state the chosen reading and proceed. Do not ask again for the same fact.
Never ask a question whose answer is in the README, package.json, git status, or the current message.
