# Planner trust boundary

The executable prompt is exported as `systemPrompt` from `src/llm/provider.ts`.
It treats repository text as untrusted data and has no API tools. Configuration is
read only from the default branch. Every output is schema validated, then checked
independently by policy and current GitHub facts. Prompt instructions alone are
not a security boundary. Semantic scope classification remains reviewable; use
supervised approval for all follow-ups when scope mistakes would be costly.
