//! Loopback internal transport: five fields in TEST; LIVE adds its fixed instance.
//! Authentication capability is deployment-only; not the browser issuance token.
use crate::{SpikeResult, issuance};
use std::{
    env,
    io::{Read, Write},
    net::{TcpListener, TcpStream},
    time::Duration,
};

fn read_field(stream: &mut TcpStream) -> SpikeResult<String> {
    let mut length = [0; 4];
    stream.read_exact(&mut length)?;
    let n = u32::from_be_bytes(length) as usize;
    if n == 0 || n > 8192 {
        return Err("invalid internal frame".into());
    }
    let mut data = vec![0; n];
    stream.read_exact(&mut data)?;
    Ok(String::from_utf8(data)?)
}
fn write_field(stream: &mut TcpStream, field: &str) -> SpikeResult<()> {
    stream.write_all(&(u32::try_from(field.len())?).to_be_bytes())?;
    stream.write_all(field.as_bytes())?;
    Ok(())
}
pub fn serve() -> SpikeResult<()> {
    if env::var("ZCASH_NETWORK").as_deref() != Ok("testnet") {
        return Err("testnet required".into());
    }
    let (path, instance) = crate::live_target::configuration("watcher")?;
    let market = env::var("ALLOCATION_MARKET_ID")?;
    let vault = env::var("ALLOCATION_VAULT_CONTEXT")?;
    let authority = env::var("ALLOCATION_AUTH")?;
    if !issuance::id(&authority) || market.is_empty() || vault.is_empty() {
        return Err("invalid configuration".into());
    }
    let port: u16 = env::var("ALLOCATION_PORT")?.parse()?;
    let listener = TcpListener::bind(("127.0.0.1", port))?;
    println!(
        "Private testnet allocator listening on 127.0.0.1:{}",
        listener.local_addr()?.port()
    );
    for connection in listener.incoming() {
        let Ok(mut stream) = connection else {
            continue;
        };
        stream.set_read_timeout(Some(Duration::from_secs(3)))?;
        stream.set_write_timeout(Some(Duration::from_secs(3)))?;
        let result = (|| -> SpikeResult<issuance::Allocation> {
            let auth = read_field(&mut stream)?;
            let valid = auth.len() == authority.len()
                && auth
                    .bytes()
                    .zip(authority.bytes())
                    .fold(0u8, |a, (x, y)| a | (x ^ y))
                    == 0;
            if !valid {
                return Err("internal authorization rejected".into());
            }
            let requested_market = read_field(&mut stream)?;
            let requested_vault = read_field(&mut stream)?;
            let ticket = read_field(&mut stream)?;
            let commitment = read_field(&mut stream)?;
            if let Some(expected) = &instance
                && read_field(&mut stream)? != *expected
            {
                return Err("context rejected".into());
            }
            let mut extra = [0; 1];
            if stream.read(&mut extra)? != 0
                || requested_market != market
                || requested_vault != vault
            {
                return Err("context rejected".into());
            }
            issuance::allocate(&path, &market, &vault, &ticket, &commitment)
        })();
        match result {
            Ok(a) => {
                let _ = write_field(&mut stream, &a.ua)
                    .and_then(|()| write_field(&mut stream, &a.diversifier));
            }
            Err(_) => {
                let _ = stream.write_all(&[0; 4]);
            }
        }
        // All failures are intentionally silent; never dump wallet/request context.
    }
    Ok(())
}
