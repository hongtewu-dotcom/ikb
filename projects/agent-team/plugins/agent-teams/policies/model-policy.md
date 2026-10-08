# Delegation model policy

Applies to Agent Team child agents, including inherited models. Resolve the
effective route from the current host, not from the parent's model alone.

- Do not use Terra. Replace a Terra route with `gpt-6-luna` at xhigh.
- All Luna routes use `gpt-6-luna` at xhigh, preserving the configured provider.
  Do not substitute another Luna version or lower the reasoning level.
- Use the host's verified child default when it supplies this route; otherwise
  pass the model and reasoning explicitly through the host's supported controls.
- Roles describe responsibilities, not models. Use ordinary explorer/worker roles;
  no model-specific role is required. Explicit user routing takes precedence.
- Other models retain the host's normal routing. Inheritance and fresh-session
  defaults may differ; do not claim every child inherits the root's model.
- Apply this policy before starting a native child or a Pi workflow whose children
  inherit the session model. If the host cannot select or establish a compliant route,
  keep that work in the parent and report the delegation limitation; do not silently
  choose another provider or install a runtime.

This is an instruction-level selection policy, not a runtime enforcement hook.
