// Direct port of Node src/reconciler-workflow-outbox.ts: transport effects only, SQLite outbox remains the durable publisher.
use crate::workflow::durable_publication::{DurableWorkflowPublication, PendingWorkflowEvent};
pub fn drain_production_workflow_outbox<Bus, Emit>(
    publisher: Option<&DurableWorkflowPublication<'_>>,
    mut event_bus: Option<Bus>,
    mut emit: Option<Emit>,
) -> Result<usize, String>
where
    Bus: FnMut(&PendingWorkflowEvent) -> Result<(), String>,
    Emit: FnMut(&PendingWorkflowEvent) -> Result<(), String>,
{
    let Some(publisher) = publisher else {
        return Ok(0);
    };
    if event_bus.is_none() && emit.is_none() {
        return Ok(0);
    }
    publisher.replay(|event| {
        if let Some(bus) = event_bus.as_mut() {
            bus(event)?;
        }
        if let Some(emit) = emit.as_mut() {
            emit(event)?;
        }
        Ok(())
    })
}
