// Native companion for src/owned-process.ts Rust port. Entrypoint invokes
// ownership-validated parent-death monitoring; not a general process killer.
fn main() {
    let args: Vec<_> = std::env::args().skip(1).collect();
    if let Err(error) = agents_relay_rust2::owned_process::supervisor_main(&args) {
        eprintln!("{error}");
        std::process::exit(2);
    }
}
