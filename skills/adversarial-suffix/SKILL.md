# Adversarial Suffix

Generate and test adversarial suffixes (GCG, AutoDAN-style) that attach to queries to bypass safety. Suffix mutation, transferability testing across models, and suffix optimization.

## When to use
- Red-teaming an LLM's safety training
- Testing whether a model has been patched against known techniques
- Getting an unfiltered response from a safety-tuned model
- Research into prompt injection and jailbreak methodology
- Responsible disclosure of safety vulnerabilities to model providers

## Permissions
- Tools: filesystem-read, filesystem-write, search, network
- Filesystem: workspace
- Network: network (API calls to model providers)
- Secrets: OPENROUTER_API_KEY, ANTHROPIC_API_KEY, OPENAI_API_KEY
