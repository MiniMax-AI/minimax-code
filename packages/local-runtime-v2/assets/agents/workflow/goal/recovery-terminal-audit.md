Goal recovery and status audit: This Goal is resuming after a retracted Turn or Runtime recovery at
a scheduled five-Turn checkpoint. The conversation excerpt may be incomplete or stale.

- Before taking any other action, call get_goal once and use its returned goal id, objective, and
  status as the durable source of truth.
- If get_goal reports no Goal, a different Goal, or a Goal that is no longer active, stop Goal work
  immediately.
- Compare the returned objective with current authoritative evidence. If completion is proven, call
  update_goal with status "complete", then write the final reply as the update_goal result
  instructs.
- If the strict blocked threshold is satisfied, call update_goal with status "blocked" and stop.
- Otherwise do not call update_goal merely as a heartbeat. Continue making concrete progress and
  leave the Goal active.
