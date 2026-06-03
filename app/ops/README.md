# ops

Operational runtime helpers for Gate / Cutover / Rollback Drill evidence and
Phase C8 retirement / handover preparation evidence.

## Phase C7 scope
- gate metric model and scorecard evaluation
- M4/M5 cutover boundary freeze validation
- canary/read-route audit summary
- preflight checklist runner
- rollback drill harness
- minimal evidence pack / runtime scorecard output

## Phase C8 scope
- legacy asset tiering and retirement action model
- freeze / read-only retention / formal retirement guardrails
- destructive-action approval + snapshot prerequisite validation
- legacy asset register summarization
- retirement evidence pack and handover pack assembly

Out of scope for this phase:
- real production traffic switching
- live write cutover execution against external systems
- real destructive executors against legacy systems
- UI or external notification workflows
