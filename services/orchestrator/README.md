# Orchestrator

Owns task state, plans, agents, scheduling, checkpoints, recovery, approvals, budgets, and coordination.

The orchestrator must persist important state transitions before reporting them as complete.

The deterministic workspace executor boundary imports no shell, network, or model-provider modules. This is a code-boundary check, not machine-level sandbox isolation.
