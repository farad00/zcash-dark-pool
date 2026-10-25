//! Synthetic recovery helper using the already cached maintained age format.
//! Keys/plaintext use private pipes only. This is not a wallet or V2 executor.
use age::secrecy::ExposeSecret;
use std::{
    env,
    io::{self, Read, Write},
    process::ExitCode,
};

const LIMIT: u64 = 64 * 1024 * 1024;
fn run() -> Result<(), Box<dyn std::error::Error>> {
    if env::var("DARKPOOL_BACKUP_SYNTHETIC").as_deref() != Ok("1") {
        return Err("synthetic boundary required".into());
    }
    let args: Vec<String> = env::args().skip(1).collect();
    let output = match args.as_slice() {
        [command] if command == "keygen" => {
            let identity = age::x25519::Identity::generate();
            format!(
                "{}\n{}\n",
                identity.to_public(),
                identity.to_string().expose_secret()
            )
            .into_bytes()
        }
        [command, recipient] if command == "encrypt" => {
            let recipient: age::x25519::Recipient = recipient.parse()?;
            let mut plain = Vec::new();
            io::stdin().take(LIMIT + 1).read_to_end(&mut plain)?;
            if plain.len() as u64 > LIMIT {
                return Err("input limit".into());
            }
            age::encrypt(&recipient, &plain)?
        }
        [command] if command == "decrypt" => {
            let mut input = io::stdin().lock();
            let mut size = [0u8; 4];
            input.read_exact(&mut size)?;
            let length = u32::from_be_bytes(size) as usize;
            if length == 0 || length > 128 {
                return Err("identity framing".into());
            }
            let mut encoded = vec![0; length];
            input.read_exact(&mut encoded)?;
            let identity: age::x25519::Identity = std::str::from_utf8(&encoded)?.parse()?;
            let mut ciphertext = Vec::new();
            input.take(LIMIT + 1).read_to_end(&mut ciphertext)?;
            if ciphertext.len() as u64 > LIMIT {
                return Err("input limit".into());
            }
            // age::decrypt authenticates the entire bounded payload before any
            // plaintext is released on stdout, including the final chunk.
            age::decrypt(&identity, &ciphertext)?
        }
        _ => return Err("command rejected".into()),
    };
    io::stdout().lock().write_all(&output)?;
    Ok(())
}
fn main() -> ExitCode {
    match run() {
        Ok(()) => ExitCode::SUCCESS,
        Err(_) => {
            eprintln!("BACKUP_CRYPTO_REJECTED");
            ExitCode::FAILURE
        }
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn roundtrip() {
        let k = age::x25519::Identity::generate();
        let c = age::encrypt(&k.to_public(), b"synthetic recovery").unwrap();
        assert_eq!(age::decrypt(&k, &c).unwrap(), b"synthetic recovery");
    }
    #[test]
    fn wrong_key() {
        let a = age::x25519::Identity::generate();
        let b = age::x25519::Identity::generate();
        let c = age::encrypt(&a.to_public(), b"synthetic").unwrap();
        assert!(age::decrypt(&b, &c).is_err());
    }
    #[test]
    fn changed_ciphertext() {
        let k = age::x25519::Identity::generate();
        let mut c = age::encrypt(&k.to_public(), b"synthetic").unwrap();
        let last = c.len() - 1;
        c[last] ^= 1;
        assert!(age::decrypt(&k, &c).is_err());
    }
    #[test]
    fn truncated_ciphertext() {
        let k = age::x25519::Identity::generate();
        let c = age::encrypt(&k.to_public(), b"synthetic").unwrap();
        assert!(age::decrypt(&k, &c[..c.len() - 1]).is_err());
    }
}
