// Node provenance: src/cli-shutdown.ts; handles one-shot CLI completion and injected delayed force exit.
pub fn final_exit_code(main_error: bool, process_exit_code: Option<i32>) -> i32 {
    i32::max(i32::from(main_error), process_exit_code.unwrap_or(0))
}

pub fn run_cli_entrypoint<F, E>(
    main: F,
    serve: bool,
    process_exit_code: Option<i32>,
    grace_ms: Option<u64>,
    force_exit: E,
) -> Result<i32, String>
where
    F: FnOnce() -> Result<(), String>,
    E: FnOnce(i32) + Send + 'static,
{
    let result = main();
    let code = final_exit_code(result.is_err(), process_exit_code);
    if let Err(error) = result {
        eprintln!("{error}");
    }
    if !serve {
        let delay = grace_ms.unwrap_or(2_000);
        std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_millis(delay));
            force_exit(code);
        });
    }
    Ok(code)
}
