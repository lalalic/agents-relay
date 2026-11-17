// Direct native tests for per-Job, coalesced wakeup coordinator.
use agents_relay_rust2::reconcile_coordinator::ReconcileCoordinator;
use serde_json::{json, Value};
use std::{
    sync::{
        atomic::{AtomicUsize, Ordering},
        Arc, Condvar, Mutex,
    },
    thread,
    time::Duration,
};

#[test]
fn rejects_one_batch_without_losing_subsequent_wakeups() {
    let count = Arc::new(AtomicUsize::new(0));
    let count2 = Arc::clone(&count);
    let errors = Arc::new(Mutex::new(Vec::<String>::new()));
    let errors2 = Arc::clone(&errors);
    let coordinator = ReconcileCoordinator::new(
        move |job, events| {
            assert_eq!(job, "job-7");
            assert!(!events.is_empty());
            if count2.fetch_add(1, Ordering::SeqCst) == 0 {
                Err("first-batch-failure".into())
            } else {
                Ok(())
            }
        },
        Some(Arc::new(move |message, _| {
            errors2.lock().expect("error mutex").push(message.into());
        })),
    );
    let first = coordinator.accept(json!({"jobId":"job-7","reason":"first"}));
    let _ = first.recv_timeout(Duration::from_secs(3)).unwrap();
    let second = coordinator.accept(json!({"jobId":"job-7","reason":"second"}));
    assert_eq!(second.recv_timeout(Duration::from_secs(3)).unwrap(), Ok(()));
    coordinator.settle();
    assert!(coordinator.is_idle());
    assert!(count.load(Ordering::SeqCst) >= 2);
    assert!(errors.lock().unwrap().is_empty());
}
#[test]
fn same_job_reconcile_is_serial_but_different_jobs_can_overlap() {
    let active = Arc::new(AtomicUsize::new(0));
    let serial = Arc::new(AtomicUsize::new(0));
    let active2 = Arc::clone(&active);
    let serial2 = Arc::clone(&serial);
    let coordinator = ReconcileCoordinator::new(
        move |_job, _signals| {
            if active2.fetch_add(1, Ordering::SeqCst) > 0 {
                // Different Jobs can execute concurrently; synchronization is per Job.
            }
            serial2.fetch_add(1, Ordering::SeqCst);
            thread::sleep(Duration::from_millis(5));
            active2.fetch_sub(1, Ordering::SeqCst);
            Ok(())
        },
        None,
    );
    let mut result = Vec::new();
    for index in 0..20 {
        result.push(coordinator.accept(json!({"jobId":format!("job-{}",index%2),"reason":index})));
    }
    for item in result {
        assert_eq!(item.recv_timeout(Duration::from_secs(3)).unwrap(), Ok(()));
    }
    coordinator.settle();
    assert!(coordinator.is_idle());
    assert!(serial.load(Ordering::SeqCst) >= 2);
}
#[test]
fn transport_returns_before_consumer_while_observed_running_is_detached() {
    let gate = Arc::new((Mutex::new(false), Condvar::new()));
    let gate2 = Arc::clone(&gate);
    let invoked = Arc::new(AtomicUsize::new(0));
    let invoked2 = Arc::clone(&invoked);
    let coordinator = ReconcileCoordinator::new(
        move |_, signals: &[Value]| {
            invoked2.fetch_add(signals.len(), Ordering::SeqCst);
            let (lock, cv) = &*gate2;
            let mut open = lock.lock().unwrap();
            while !*open {
                open = cv.wait(open).unwrap();
            }
            Err("consumer-broken".into())
        },
        None,
    );
    let transport = coordinator.accept_transport(json!({"jobId":"single","reason":"transport"}));
    assert_eq!(
        transport.recv_timeout(Duration::from_secs(1)).unwrap(),
        Ok(())
    );
    while invoked.load(Ordering::SeqCst) == 0 {
        thread::yield_now();
    }
    let observed = coordinator.accept_observed(json!({"jobId":"single","reason":"observed"}));
    assert_eq!(
        observed.recv_timeout(Duration::from_secs(1)).unwrap(),
        Ok(())
    );
    {
        let (lock, cv) = &*gate;
        *lock.lock().unwrap() = true;
        cv.notify_all();
    }
    coordinator.settle();
    assert!(coordinator.is_idle());
    assert_eq!(invoked.load(Ordering::SeqCst), 2);
}
