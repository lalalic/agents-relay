//! Rust shadow backend for Agents Relay. The canonical Mermaid graphs and
//! SQLite store remain the source of truth. Only mock ActionPorts may be used
//! from the CLI; no production dispatcher or writer is started here.
pub mod agent_graph;
pub mod authority;
pub mod dispatch;
pub mod final_review;
pub mod graph;
pub mod lifecycle;
pub mod native_daemon;
pub mod native_script;
pub mod reconcile;
pub mod recovery;
pub mod store;
pub mod supervised_script;
#[cfg(unix)]
pub mod worker;
