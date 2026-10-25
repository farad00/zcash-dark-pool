use std::{
    io::{Read, Write},
    net::{TcpListener, TcpStream},
    process::{Command, Output, Stdio},
    sync::Arc,
    thread,
    time::{Duration, Instant},
};

use rustls::{
    ServerConfig, ServerConnection, StreamOwned,
    pki_types::{CertificateDer, PrivateKeyDer, pem::PemObject},
};
use tonic::transport::{Certificate, ClientTlsConfig};

use super::*;

const ROOT: &[u8] = include_bytes!("../testdata/connect-only/root.pem.txt");
const CHAIN: &[u8] = include_bytes!("../testdata/connect-only/chain.pem.txt");
const KEY: &[u8] = include_bytes!("../testdata/connect-only/end.key.txt");

#[derive(Debug)]
enum FixtureEvent {
    ListenerReady,
    ConnectionAccepted,
    ClientHelloObserved,
    PeerEof,
    PeerReset,
    ReadTimeout,
    AcceptFailure(std::io::ErrorKind),
    ReadFailure(std::io::ErrorKind),
    InvalidClientHello,
    WrapperExitedBeforeAccept,
    Cancelled,
    ContainmentExpired(&'static str),
    ActiveBoundExceeded,
}

enum FixtureControl {
    WrapperExited,
    Cancel,
}

fn accept(
    listener: &TcpListener,
    deadline: Instant,
    control: Option<&std::sync::mpsc::Receiver<FixtureControl>>,
) -> Result<TcpStream, FixtureEvent> {
    listener
        .set_nonblocking(true)
        .map_err(|err| FixtureEvent::AcceptFailure(err.kind()))?;
    loop {
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return Err(FixtureEvent::ContainmentExpired("accept"));
        }
        match listener.accept() {
            Ok((socket, _)) => {
                // Windows accepts inherit the listener's nonblocking mode.
                socket
                    .set_nonblocking(false)
                    .map_err(|err| FixtureEvent::AcceptFailure(err.kind()))?;
                return Ok(socket);
            }
            Err(err) if err.kind() == std::io::ErrorKind::WouldBlock => {
                // Poll cadence only, not an independent startup deadline.
                let interval = remaining.min(Duration::from_millis(5));
                if let Some(control) = control {
                    match control.recv_timeout(interval) {
                        Ok(FixtureControl::WrapperExited) => {
                            return Err(FixtureEvent::WrapperExitedBeforeAccept);
                        }
                        Ok(FixtureControl::Cancel)
                        | Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => {
                            return Err(FixtureEvent::Cancelled);
                        }
                        Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {}
                    }
                } else {
                    thread::sleep(interval);
                }
            }
            Err(err) => return Err(FixtureEvent::AcceptFailure(err.kind())),
        }
    }
}

// Minimal HTTP/2 transport peer: SETTINGS/ACK only, no gRPC service or RPC handler.
fn tls_fixture() -> (String, thread::JoinHandle<(bool, usize)>) {
    let deadline = Instant::now() + Duration::from_secs(10);
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let endpoint = format!("https://{}", listener.local_addr().unwrap());
    let server = thread::spawn(move || {
        let socket = accept(&listener, deadline, None).expect("local TLS fixture accept failed");
        socket
            .set_read_timeout(Some(Duration::from_secs(2)))
            .unwrap();
        socket
            .set_write_timeout(Some(Duration::from_secs(2)))
            .unwrap();
        let certs = CertificateDer::pem_slice_iter(CHAIN)
            .collect::<Result<Vec<_>, _>>()
            .unwrap();
        let key = PrivateKeyDer::from_pem_slice(KEY).unwrap();
        let mut config =
            ServerConfig::builder_with_provider(Arc::new(rustls::crypto::ring::default_provider()))
                .with_safe_default_protocol_versions()
                .unwrap()
                .with_no_client_auth()
                .with_single_cert(certs, key)
                .unwrap();
        config.alpn_protocols = vec![b"h2".to_vec()];
        let mut stream = StreamOwned::new(ServerConnection::new(Arc::new(config)).unwrap(), socket);
        let mut preface = [0; 24];
        if stream.read_exact(&mut preface).is_err() {
            // Channel establishment may finish before its background HTTP2 driver
            // flushes the preface. Immediate runtime shutdown is intentional.
            // A completed TLS handshake with h2 ALPN still proves verified transport;
            // EOF before a complete preface cannot contain application HTTP2 frames.
            return (
                !stream.conn.is_handshaking()
                    && stream.conn.alpn_protocol() == Some(b"h2".as_slice()),
                0,
            );
        }
        assert_eq!(&preface, b"PRI * HTTP/2.0\r\n\r\nSM\r\n\r\n");
        assert_eq!(stream.conn.alpn_protocol(), Some(b"h2".as_slice()));
        // The diagnostic immediately drops its channel; peer closure is expected.
        let _ = stream.write_all(&[0, 0, 0, 4, 0, 0, 0, 0, 0]);
        let _ = stream.flush();
        let mut application_frames = 0;
        loop {
            let mut header = [0; 9];
            if stream.read_exact(&mut header).is_err() {
                break;
            }
            let len = (usize::from(header[0]) << 16)
                | (usize::from(header[1]) << 8)
                | usize::from(header[2]);
            assert!(len <= 16_384);
            let stream_id = u32::from_be_bytes(header[5..9].try_into().unwrap()) & 0x7fffffff;
            if stream_id != 0 || matches!(header[3], 0 | 1 | 9) {
                application_frames += 1;
            }
            let mut payload = vec![0; len];
            if stream.read_exact(&mut payload).is_err() {
                break;
            }
            if header[3] == 4 && header[4] == 0 {
                if stream.write_all(&[0, 0, 0, 4, 1, 0, 0, 0, 0]).is_err() {
                    break;
                }
                if stream.flush().is_err() {
                    break;
                }
            }
        }
        (true, application_frames)
    });
    (endpoint, server)
}

fn fixture_endpoint(endpoint: &str, hostname: &str) -> Endpoint {
    // Exact production factory first; test-only trust override, with full validation.
    // No fixture CA or hostname override is exposed by the diagnostic CLI.
    tls_endpoint(endpoint)
        .unwrap()
        .tls_config(
            ClientTlsConfig::new()
                .ca_certificate(Certificate::from_pem(ROOT))
                .domain_name(hostname),
        )
        .unwrap()
}

fn binary() -> std::path::PathBuf {
    std::env::current_exe()
        .unwrap()
        .parent()
        .unwrap()
        .parent()
        .unwrap()
        .join(format!("darkpool-zcash{}", std::env::consts::EXE_SUFFIX))
}

fn closed_output(output: &Output) -> serde_json::Value {
    assert_eq!(output.status.code(), Some(1));
    assert!(output.stderr.is_empty());
    assert!(output.stdout.len() <= 256);
    let value: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
    let keys: Vec<_> = value
        .as_object()
        .unwrap()
        .keys()
        .map(String::as_str)
        .collect();
    assert_eq!(keys, ["class", "elapsed_ms", "exit_code", "grpc_code"]);
    assert!(matches!(
        value["class"].as_str(),
        Some("TLS_CONNECT" | "RPC_CONNECT" | "RPC_TIMEOUT")
    ));
    assert_eq!(value["exit_code"], 1);
    value
}

fn child_output(command: &mut Command) -> Output {
    child_output_until(command, Instant::now() + Duration::from_secs(10))
}

fn child_output_until(command: &mut Command, deadline: Instant) -> Output {
    let mut child = command
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    loop {
        if child.try_wait().unwrap().is_some() {
            return child.wait_with_output().unwrap();
        }
        if Instant::now() >= deadline {
            child.kill().unwrap();
            child.wait().unwrap();
            panic!("local diagnostic exceeded outer test deadline");
        }
        thread::sleep(Duration::from_millis(5));
    }
}

#[test]
fn verified_local_tls_h2_success_reports_only_ok_and_sends_no_rpc() {
    let (endpoint, server) = tls_fixture();
    let started = Instant::now();
    let result = execute(Ok(fixture_endpoint(&endpoint, "foobar.com")));
    let (output, exit) = report(result, started);
    assert_eq!(server.join().unwrap(), (true, 0));
    assert_eq!((output.as_str(), exit), ("CONNECT_OK", 0));
}

#[test]
fn production_factory_does_not_trust_public_test_ca() {
    let (endpoint, server) = tls_fixture();
    assert!(execute(Ok(tls_endpoint(&endpoint).unwrap())).is_err());
    assert_eq!(server.join().unwrap(), (false, 0));
}

#[test]
fn fixture_still_verifies_hostname() {
    let (endpoint, server) = tls_fixture();
    assert!(execute(Ok(fixture_endpoint(&endpoint, "wrong.example"))).is_err());
    assert_eq!(server.join().unwrap(), (false, 0));
}

#[test]
fn unavailable_local_endpoint_naturally_fails_with_closed_output() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let endpoint = format!("https://{}", listener.local_addr().unwrap());
    drop(listener);
    let started = Instant::now();
    let output = child_output(
        Command::new(binary())
            .env_clear()
            .args(["diagnose-connection", &endpoint]),
    );
    let value = closed_output(&output);
    assert_eq!(value["class"], "RPC_CONNECT");
    assert!(value["grpc_code"].is_null());
    assert!(started.elapsed() < Duration::from_secs(10));
}

#[test]
fn cli_requires_no_context_and_ignores_fake_wallet_and_pg_inputs() {
    let directory = tempfile::tempdir().unwrap();
    let wallet = directory.path().join("fake-wallet-sentinel");
    std::fs::write(&wallet, b"non-wallet sentinel").unwrap();
    let pg = TcpListener::bind("127.0.0.1:0").unwrap();
    pg.set_nonblocking(true).unwrap();
    let output = child_output(
        Command::new(binary())
            .env_clear()
            .current_dir(directory.path())
            .env("ZCASH_NETWORK", "mainnet")
            .env("WALLET_DB_PATH", &wallet)
            .env("PGHOST", "127.0.0.1")
            .env("PGPORT", pg.local_addr().unwrap().port().to_string())
            .env(
                "DATABASE_URL",
                format!(
                    "postgresql://fixture:fixture@{}/fixture",
                    pg.local_addr().unwrap()
                ),
            )
            .args(["diagnose-connection", "https://invalid host/private"]),
    );
    assert_eq!(closed_output(&output)["class"], "TLS_CONNECT");
    assert_eq!(std::fs::read(&wallet).unwrap(), b"non-wallet sentinel");
    assert_eq!(std::fs::read_dir(directory.path()).unwrap().count(), 1);
    assert!(matches!(pg.accept(), Err(err) if err.kind() == std::io::ErrorKind::WouldBlock));
}

#[test]
fn missing_or_extra_arguments_are_closed_without_environment() {
    for args in [
        vec!["diagnose-connection"],
        vec!["diagnose-connection", "private-endpoint", "private-extra"],
    ] {
        let output = child_output(Command::new(binary()).env_clear().args(args));
        assert_eq!(closed_output(&output)["class"], "TLS_CONNECT");
    }
}

#[test]
fn typed_errors_preserve_only_closed_class_and_genuine_grpc_code() {
    let started = Instant::now();
    let error = tonic::Status::deadline_exceeded("private arbitrary payload");
    let failure = Failure::classify(&error, FailureClass::RpcConnect);
    assert_eq!(failure.class, FailureClass::RpcTimeout);
    assert_eq!(failure.grpc_code, Some(4));
    assert!(!failure.output(started).contains("private"));
    let error = std::io::Error::new(std::io::ErrorKind::ConnectionRefused, "private OS error");
    let failure = Failure::classify(&error, FailureClass::RpcConnect);
    assert_eq!(failure.class, FailureClass::RpcConnect);
    assert_eq!(failure.grpc_code, None);
    assert!(!failure.output(started).contains("private"));
    let error = rustls::Error::General("private certificate error".to_owned());
    assert_eq!(
        Failure::classify(&error, FailureClass::RpcConnect).class,
        FailureClass::TlsConnect
    );
    let error = std::io::Error::new(std::io::ErrorKind::TimedOut, "private timeout error");
    assert_eq!(
        Failure::classify(&error, FailureClass::RpcConnect).class,
        FailureClass::RpcTimeout
    );
}

#[cfg(windows)]
fn wrapper(endpoint: &str, deadline: &str) -> serde_json::Value {
    wrapper_until(endpoint, deadline, Instant::now() + Duration::from_secs(10))
}

#[cfg(windows)]
fn wrapper_until(endpoint: &str, deadline: &str, containment: Instant) -> serde_json::Value {
    let repo = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
    let output = child_output_until(
        Command::new("powershell.exe")
            .args(["-NoProfile", "-ExecutionPolicy", "Bypass", "-File"])
            .arg(repo.join("scripts/dev/phase9-connect-only.ps1"))
            .args(["-Endpoint", endpoint, "-DeadlineMs", deadline]),
        containment,
    );
    assert_eq!(output.status.code(), Some(1));
    assert!(output.stderr.is_empty());
    assert!(output.stdout.len() <= 256);
    serde_json::from_slice(&output.stdout).unwrap()
}

#[test]
#[cfg(windows)]
fn wrapper_deadline_kills_stalled_tls_without_inventing_rpc_timeout() {
    let started = Instant::now();
    let deadline = started + Duration::from_secs(10);
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let endpoint = format!("https://{}", listener.local_addr().unwrap());
    let (send, events) = std::sync::mpsc::channel();
    let (stop, control) = std::sync::mpsc::channel();
    let emit = move |event, at| {
        let _ = send.send((event, at, std::time::SystemTime::now()));
    };
    // bind() has synchronously made the listener available before child launch.
    emit(FixtureEvent::ListenerReady, Instant::now());
    let server = thread::spawn(move || {
        let check = |phase| {
            if Instant::now() >= deadline {
                return Err(FixtureEvent::ContainmentExpired(phase));
            }
            match control.try_recv() {
                Ok(FixtureControl::Cancel) | Err(std::sync::mpsc::TryRecvError::Disconnected) => {
                    Err(FixtureEvent::Cancelled)
                }
                // Once connected, wrapper exit is not a substitute for peer EOF/reset.
                Ok(FixtureControl::WrapperExited) | Err(std::sync::mpsc::TryRecvError::Empty) => {
                    Ok(())
                }
            }
        };
        let read_timeout = |socket: &TcpStream, phase| {
            check(phase)?;
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                return Err(FixtureEvent::ContainmentExpired(phase));
            }
            socket
                .set_read_timeout(Some(remaining.min(Duration::from_secs(2))))
                .map_err(|err| FixtureEvent::ReadFailure(err.kind()))
        };
        let read_error = |err: std::io::Error, phase| {
            if Instant::now() >= deadline {
                FixtureEvent::ContainmentExpired(phase)
            } else if matches!(
                err.kind(),
                std::io::ErrorKind::TimedOut | std::io::ErrorKind::WouldBlock
            ) {
                FixtureEvent::ReadTimeout
            } else {
                FixtureEvent::ReadFailure(err.kind())
            }
        };
        let result = (|| -> Result<FixtureEvent, FixtureEvent> {
            let mut socket = accept(&listener, deadline, Some(&control))?;
            emit(FixtureEvent::ConnectionAccepted, Instant::now());
            // Rustls establishes a complete ClientHello without replying to it.
            let mut hello = rustls::server::Acceptor::default();
            loop {
                read_timeout(&socket, "ClientHello")?;
                if hello
                    .read_tls(&mut socket)
                    .map_err(|err| read_error(err, "ClientHello"))?
                    == 0
                {
                    return Err(FixtureEvent::ReadFailure(std::io::ErrorKind::UnexpectedEof));
                }
                check("ClientHello")?;
                match hello.accept() {
                    Ok(Some(_)) => break,
                    Ok(None) => {}
                    Err(_) => return Err(FixtureEvent::InvalidClientHello),
                }
            }
            let active = Instant::now();
            emit(FixtureEvent::ClientHelloObserved, active);
            let mut bytes = [0; 4096];
            loop {
                read_timeout(&socket, "peer termination")?;
                if active.elapsed() >= Duration::from_millis(2500) {
                    return Err(FixtureEvent::ActiveBoundExceeded);
                }
                let read = socket.read(&mut bytes);
                check("peer termination")?;
                match read {
                    Ok(0) => return Ok(FixtureEvent::PeerEof),
                    Ok(_) => {}
                    Err(err) if err.kind() == std::io::ErrorKind::ConnectionReset => {
                        return Ok(FixtureEvent::PeerReset);
                    }
                    Err(err) => return Err(read_error(err, "peer termination")),
                }
            }
        })();
        emit(result.unwrap_or_else(|event| event), Instant::now());
    });

    // Catch only to cancel/collect the fixture before preserving the original panic.
    let wrapper = std::panic::catch_unwind(|| wrapper_until(&endpoint, "1000", deadline));
    let _ = stop.send(if wrapper.is_ok() {
        FixtureControl::WrapperExited
    } else {
        FixtureControl::Cancel
    });
    let mut observations = Vec::new();
    let mut collection_expired = false;
    loop {
        match events.recv_timeout(deadline.saturating_duration_since(Instant::now())) {
            Ok(event) => observations.push(event),
            Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => break,
            Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {
                let _ = stop.send(FixtureControl::Cancel);
                collection_expired = true;
                break;
            }
        }
    }
    // All worker I/O is deadline-capped; no fresh wait budget is started for join.
    let joined = server.join();
    observations.extend(events.try_iter());
    for (event, _, wall_time) in &observations {
        println!(
            "stalled_tls_event={event:?} unix_ns={}",
            wall_time
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        );
    }
    if joined.is_err() {
        panic!("stalled TLS fixture worker panicked; lifecycle={observations:?}");
    }
    let value = match wrapper {
        Ok(value) => value,
        Err(panic) => std::panic::resume_unwind(panic),
    };
    println!("stalled_tls_wrapper={value}");
    for (event, _, _) in &observations {
        match event {
            FixtureEvent::AcceptFailure(kind) => panic!("fixture accept failed: {kind:?}"),
            FixtureEvent::ReadFailure(kind) => panic!("fixture read failed: {kind:?}"),
            FixtureEvent::ContainmentExpired("accept") => {
                panic!("diagnostic connection not established before test containment deadline");
            }
            FixtureEvent::ContainmentExpired(phase) => {
                panic!("fixture containment expired during {phase}");
            }
            FixtureEvent::ReadTimeout => panic!("read timeout instead of peer termination"),
            FixtureEvent::InvalidClientHello => panic!("complete ClientHello not observed"),
            FixtureEvent::WrapperExitedBeforeAccept => {
                panic!("wrapper exited before diagnostic connection was established");
            }
            FixtureEvent::Cancelled => panic!("stalled TLS fixture cancelled"),
            FixtureEvent::ActiveBoundExceeded => panic!("peer termination exceeded 2500 ms"),
            _ => {}
        }
    }
    assert!(
        !collection_expired,
        "fixture event collection containment expired"
    );
    let [
        (FixtureEvent::ListenerReady, _, _),
        (FixtureEvent::ConnectionAccepted, _, _),
        (FixtureEvent::ClientHelloObserved, active, _),
        (FixtureEvent::PeerEof | FixtureEvent::PeerReset, terminated, _),
    ] = observations.as_slice()
    else {
        panic!("fixture did not observe active TLS followed by genuine peer termination");
    };
    let active_elapsed = terminated.duration_since(*active);
    println!(
        "stalled_tls_active_elapsed_us={}",
        active_elapsed.as_micros()
    );
    assert_eq!(value["result"], "OUTER_TIMEOUT");
    assert_eq!(value["outer_timeout"], true);
    assert!(value["elapsed_ms"].as_u64().unwrap() >= 1000);
    assert!(active_elapsed < Duration::from_millis(2500));
    assert!(started.elapsed() < Duration::from_secs(10));
}

#[test]
#[cfg(windows)]
fn wrapper_natural_failure_is_distinct_from_outer_timeout() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let endpoint = format!("https://{}", listener.local_addr().unwrap());
    drop(listener);
    let value = wrapper(&endpoint, "10000");
    assert_eq!(value["result"], "RPC_CONNECT");
    assert_eq!(value["exit_code"], 1);
    assert_eq!(value["outer_timeout"], false);
}
