Goal status audit: This is the scheduled five-Turn checkpoint for an active Goal.

- Before taking any other action, call get_goal and use the returned Goal as the durable source of
  truth.
- Compare the full objective with current authoritative evidence. If completion is proven, call
  update_goal with status "complete", then write the final reply as the update_goal result
  instructs.
- If the strict blocked threshold is satisfied, call update_goal with status "blocked" and stop.
- Otherwise do not call update_goal merely as a heartbeat. Continue making concrete progress and
  leave the Goal active.
