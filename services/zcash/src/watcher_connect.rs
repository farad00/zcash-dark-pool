//! Endpoint-only channel diagnostic. No wallet, synchronization state or RPC client.
use std::time::Instant;

use tonic::transport::Endpoint;

use super::{FailureClass, tls_endpoint};

struct Failure {
    class: FailureClass,
    grpc_code: Option<i32>,
}

impl Failure {
    fn classify(err: &(dyn std::error::Error + 'static), fallback: FailureClass) -> Self {
        let mut result = Self {
            class: fallback,
            grpc_code: None,
        };
        let mut source = Some(err);
        // Typed sources only. No Display/Debug/message matching or error retention.
        for _ in 0..16 {
            let Some(err) = source else { break };
            if let Some(status) = err.downcast_ref::<tonic::Status>() {
                result.grpc_code = Some(status.code() as i32);
                if status.code() == tonic::Code::DeadlineExceeded {
                    result.class = FailureClass::RpcTimeout;
                }
            }
            if err.is::<rustls::Error>() {
                result.class = FailureClass::TlsConnect;
            }
            if let Some(io) = err.downcast_ref::<std::io::Error>() {
                if io.get_ref().is_some_and(|err| err.is::<rustls::Error>()) {
                    result.class = FailureClass::TlsConnect;
                }
                if io.kind() == std::io::ErrorKind::TimedOut {
                    result.class = FailureClass::RpcTimeout;
                }
            }
            source = err.source();
        }
        result
    }

    fn output(&self, started: Instant) -> String {
        serde_json::json!({"class":self.class.name(), "grpc_code":self.grpc_code,
            "elapsed_ms":started.elapsed().as_millis(), "exit_code":1})
        .to_string()
    }
}

async fn connect(endpoint: Endpoint) -> Result<(), Failure> {
    // No generated gRPC client, request or synchronization entrypoint is constructed.
    let channel = endpoint
        .connect()
        .await
        .map_err(|err| Failure::classify(&err, FailureClass::RpcConnect))?;
    drop(channel);
    Ok(())
}

fn execute(endpoint: Result<Endpoint, Failure>) -> Result<(), Failure> {
    let endpoint = endpoint?;
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .map_err(|err| Failure::classify(&err, FailureClass::RpcConnect))?;
    runtime.block_on(connect(endpoint))
}

fn report(result: Result<(), Failure>, started: Instant) -> (String, u8) {
    match result {
        Ok(()) => ("CONNECT_OK".to_owned(), 0),
        Err(failure) => (failure.output(started), 1),
    }
}

/// Only input is the endpoint. Caller must apply an outer process deadline.
pub fn run(endpoint: Option<&str>) -> u8 {
    let started = Instant::now();
    let endpoint = endpoint
        .ok_or(Failure {
            class: FailureClass::TlsConnect,
            grpc_code: None,
        })
        .and_then(|endpoint| {
            tls_endpoint(endpoint)
                .map_err(|err| Failure::classify(err.as_ref(), FailureClass::TlsConnect))
        });
    let (output, exit) = report(execute(endpoint), started);
    println!("{output}");
    exit
}

#[cfg(test)]
#[path = "watcher_connect_tests.rs"]
mod tests;
