// Node provenance: src/execution-boundary.ts; verifies the Rust per-key async gate with controlled thread futures.
use agents_relay_rust2::cli_shutdown::run_cli_entrypoint;
use agents_relay_rust2::execution_boundary::with_execution_boundary;
use std::future::Future;
use std::sync::mpsc;
use std::task::{Context, Poll, Waker};
fn block_on<F: Future>(future: F) -> F::Output {
    let mut cx = Context::from_waker(Waker::noop());
    let mut future = Box::pin(future);
    loop {
        if let Poll::Ready(value) = future.as_mut().poll(&mut cx) {
            return value;
        }
        std::thread::yield_now();
    }
}

#[test]
fn same_key_waits_different_key_runs_and_panic_releases_gate() {
    let (started_tx, started_rx) = mpsc::channel();
    let (release_tx, release_rx) = mpsc::channel();
    let first = std::thread::spawn(move || {
        block_on(with_execution_boundary("batch5", "same", async move {
            started_tx.send("first").unwrap();
            release_rx.recv().unwrap();
        }))
    });
    assert_eq!(started_rx.recv().unwrap(), "first");
    let (second_tx, second_rx) = mpsc::channel();
    let second = std::thread::spawn(move || {
        block_on(with_execution_boundary("batch5", "same", async move {
            second_tx.send("second").unwrap();
        }))
    });
    let (other_tx, other_rx) = mpsc::channel();
    let other = std::thread::spawn(move || {
        block_on(with_execution_boundary("batch5", "other", async move {
            other_tx.send("other").unwrap();
        }))
    });
    assert_eq!(
        other_rx
            .recv_timeout(std::time::Duration::from_secs(1))
            .unwrap(),
        "other"
    );
    assert!(second_rx
        .recv_timeout(std::time::Duration::from_millis(20))
        .is_err());
    release_tx.send(()).unwrap();
    assert_eq!(second_rx.recv().unwrap(), "second");
    first.join().unwrap();
    second.join().unwrap();
    other.join().unwrap();
    let failed = std::panic::catch_unwind(|| {
        block_on(with_execution_boundary("batch5", "same", async {
            panic!("controlled failure")
        }))
    });
    assert!(failed.is_err());
    assert_eq!(
        block_on(with_execution_boundary("batch5", "same", async { 9 })),
        9
    );
}

#[test]
fn shutdown_schedules_delayed_injected_exit_and_serve_skips_it() {
    let (tx, rx) = mpsc::channel();
    assert_eq!(
        run_cli_entrypoint(
            || Ok(()),
            false,
            Some(3),
            Some(15),
            move |code| tx.send(code).unwrap()
        )
        .unwrap(),
        3
    );
    assert_eq!(
        rx.recv_timeout(std::time::Duration::from_millis(5))
            .unwrap_err(),
        mpsc::RecvTimeoutError::Timeout
    );
    assert_eq!(
        rx.recv_timeout(std::time::Duration::from_secs(1)).unwrap(),
        3
    );
    let (tx, rx) = mpsc::channel();
    assert_eq!(
        run_cli_entrypoint(
            || Err("expected".into()),
            true,
            Some(0),
            Some(1),
            move |code| tx.send(code).unwrap()
        )
        .unwrap(),
        1
    );
    assert!(rx.try_recv().is_err());
}
