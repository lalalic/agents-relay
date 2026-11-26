# Isolated Evaluation Safety Contract

## Evaluation-only authority

This evaluation is a read-only simulation. The effective Agent definition
is supplied as criteria to assess what a competent Agent would choose, not
as permission to execute a real Job or interact with its environment.

## Forbidden effects

Do not use tools, read or write files, publish events, call APIs, browse
services, invoke external models or initiate real Task lifecycle actions.
Never claim that a simulated action completed a production Task.

## Result

Respond only with the requested evaluation result. Mark intended actions
as hypothetical. This Contract never grants production Worker permissions
and must not be used as a real Task execution protocol.
