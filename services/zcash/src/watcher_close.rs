//! Bounded post-sync evidence. Wallet rows are maintained scan metadata, never a second scanner.
use super::*;
use std::collections::VecDeque;

#[derive(Clone, Debug, PartialEq)]
struct Header {
    height: u32,
    hash: Vec<u8>,
    time: u32,
}
impl Header {
    fn from_block(b: &CompactBlock) -> SpikeResult<Self> {
        if b.hash.len() != 32 || b.prev_hash.len() != 32 {
            return Err("invalid close header".into());
        }
        Ok(Self {
            height: u32::try_from(b.height)?,
            hash: b.hash.clone(),
            time: b.time,
        })
    }
}
fn median(window: &VecDeque<Header>) -> SpikeResult<u32> {
    if window.len() < 11 {
        return Err("missing MTP predecessors".into());
    }
    let mut times: Vec<_> = window.iter().rev().take(11).map(|h| h.time).collect();
    times.sort_unstable();
    Ok(times[5])
}
struct Discovery {
    rolling: VecDeque<Header>,
    expected: u64,
    close: u128,
    crossing: Option<u32>,
}
fn close_micros(text: &str) -> SpikeResult<u128> {
    // context() returns exact numeric microseconds as text; PostgreSQL may retain
    // a zero fractional scale after multiplying epoch seconds by 1,000,000.
    let (integer, fraction) = text
        .split_once('.')
        .map_or((text, None), |(i, f)| (i, Some(f)));
    if integer.is_empty()
        || !integer.bytes().all(|b| b.is_ascii_digit())
        || fraction.is_some_and(|f| f.is_empty() || !f.bytes().all(|b| b == b'0'))
    {
        return Err("invalid close microseconds".into());
    }
    Ok(integer.parse()?)
}
impl Discovery {
    fn new(seed: VecDeque<Header>, anchor: u32, close: u128) -> SpikeResult<Self> {
        if seed.len() != 11
            || seed
                .iter()
                .enumerate()
                .any(|(i, h)| h.height != anchor - 10 + i as u32 || h.hash.len() != 32)
            || u128::from(median(&seed)?) * 1_000_000 >= close
        {
            return Err("invalid anchor seed".into());
        }
        Ok(Self {
            rolling: seed,
            expected: u64::from(anchor) + 1,
            close,
            crossing: None,
        })
    }
    fn push(&mut self, h: Header) -> SpikeResult<()> {
        if u64::from(h.height) != self.expected || h.hash.len() != 32 {
            return Err("gap or malformed maintained history".into());
        }
        let mtp = median(&self.rolling)?;
        if h.time <= mtp {
            return Err("invalid median-time history".into());
        }
        if self.crossing.is_none() && u128::from(mtp) * 1_000_000 >= self.close {
            let mut previous = self.rolling.clone();
            previous.pop_back();
            if previous.len() < 11 || u128::from(median(&previous)?) * 1_000_000 >= self.close {
                return Err("invalid first crossing".into());
            }
            self.crossing = Some(h.height);
        }
        if self.rolling.len() == 13 {
            self.rolling.pop_front();
        }
        self.rolling.push_back(h);
        self.expected += 1;
        Ok(())
    }
}

fn local(read: &Connection, h: u32) -> SpikeResult<Option<Header>> {
    let row = read
        .query_row(
            "SELECT height,hash,time FROM blocks WHERE height=?",
            [h],
            |r| {
                Ok((
                    r.get::<_, i64>(0)?,
                    r.get::<_, Vec<u8>>(1)?,
                    r.get::<_, i64>(2)?,
                ))
            },
        )
        .optional()?;
    row.map(|(height, hash, time)| {
        if hash.len() != 32 {
            return Err("invalid maintained hash".into());
        }
        Ok(Header {
            height: u32::try_from(height)?,
            hash,
            time: u32::try_from(time)?,
        })
    })
    .transpose()
}
fn value(b: &CompactBlock) -> Value {
    json!({"height":b.height,"hash":hex(&b.hash),"prev_hash":hex(&b.prev_hash),"time":b.time})
}

// Only witness headers/links absent from SQLite are fetched; no whole-span response or map.
async fn window<T>(
    client: &mut CompactTxStreamerClient<T>,
    read: &Connection,
    start: u32,
    end: u32,
    birthday: u32,
) -> SpikeResult<Vec<Value>>
where
    T: tonic::client::GrpcService<tonic::body::Body>,
    T::Error: Into<tonic::codegen::StdError>,
    T::ResponseBody: tonic::codegen::Body<Data = tonic::codegen::Bytes> + Send + 'static,
    <T::ResponseBody as tonic::codegen::Body>::Error: Into<tonic::codegen::StdError> + Send,
{
    if end < start || end - start >= 13 {
        return Err("invalid bounded witness".into());
    }
    let mut stream = client
        .get_block_range(service::BlockRange {
            start: Some(service::BlockId {
                height: start.into(),
                hash: vec![],
            }),
            end: Some(service::BlockId {
                height: end.into(),
                hash: vec![],
            }),
            pool_types: vec![],
        })
        .await?
        .into_inner();
    let mut out = Vec::new();
    let mut previous: Option<Vec<u8>> = None;
    let mut expected = u64::from(start);
    let mut bytes = 0usize;
    while let Some(b) = stream.message().await? {
        if b.height != expected || b.height > u64::from(end) {
            return Err("incomplete witness order".into());
        }
        let h = Header::from_block(&b)?;
        if previous.as_ref().is_some_and(|p| p != &b.prev_hash) {
            return Err("mixed witness chain".into());
        }
        match local(read, h.height)? {
            Some(stored) if stored == h => {}
            None if h.height < birthday => {} // Missing pre-birthday seed only; never paper over a scanned gap.
            _ => return Err("witness conflicts with maintained history".into()),
        }
        if h.height > birthday && local(read, h.height - 1)?.is_none_or(|p| p.hash != b.prev_hash) {
            return Err("witness predecessor conflicts with maintained history".into());
        }
        bytes = bytes
            .checked_add(b.encoded_len())
            .ok_or("bounded witness bytes")?;
        if bytes > MAX_BLOCK_BYTES {
            return Err("bounded witness bytes".into());
        }
        previous = Some(b.hash.clone());
        out.push(value(&b));
        expected += 1;
    }
    if expected != u64::from(end) + 1 {
        return Err("missing witness block".into());
    }
    Ok(out)
}

pub(super) async fn build<T>(
    path: &Path,
    context: &Value,
    height: u32,
    hash: &[u8],
    client: &mut CompactTxStreamerClient<T>,
) -> SpikeResult<Value>
where
    T: tonic::client::GrpcService<tonic::body::Body>,
    T::Error: Into<tonic::codegen::StdError>,
    T::ResponseBody: tonic::codegen::Body<Data = tonic::codegen::Bytes> + Send + 'static,
    <T::ResponseBody as tonic::codegen::Body>::Error: Into<tonic::codegen::StdError> + Send,
{
    let anchor = u32::try_from(context["anchor_height"].as_u64().ok_or("missing anchor")?)?;
    let close = close_micros(field(context, "closes_at_us")?)?;
    if anchor < 11 || height < anchor {
        return Err("invalid close domain".into());
    }
    let read = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY)?;
    read.busy_timeout(Duration::from_secs(5))?;
    read.execute_batch("BEGIN;")?;
    let birthday: u32 = read.query_row("SELECT birthday_height FROM accounts", [], |r| r.get(0))?;
    if birthday > anchor {
        return Err("anchor outside maintained coverage".into());
    }
    // WalletRead::block_fully_scanned was checked by the caller. Independently require
    // the search domain to be covered only by maintained Scanned queue intervals.
    let mut covered = u64::from(anchor);
    let mut first_range = true;
    let mut query=read.prepare("SELECT block_range_start,block_range_end,priority FROM scan_queue WHERE block_range_end>? AND block_range_start<=? ORDER BY block_range_start")?;
    for row in query.query_map([anchor, height], |r| {
        Ok((
            r.get::<_, u64>(0)?,
            r.get::<_, u64>(1)?,
            r.get::<_, i64>(2)?,
        ))
    })? {
        let (start, end, priority) = row?;
        if start > covered || (!first_range && start != covered) || end <= covered || priority != 10
        {
            return Err("unscanned close history".into());
        }
        covered = end;
        first_range = false;
    }
    if covered <= u64::from(height) {
        return Err("incomplete close coverage".into());
    }
    let seed = window(client, &read, anchor - 10, anchor, birthday).await?;
    if seed.last().unwrap()["hash"].as_str() != Some(field(context, "anchor_hash")?) {
        return Err("anchor witness changed".into());
    }
    let rolling: VecDeque<_> = seed
        .iter()
        .map(|v| Header {
            height: v["height"].as_u64().unwrap() as u32,
            hash: bytes(v["hash"].as_str().unwrap()).unwrap(),
            time: v["time"].as_u64().unwrap() as u32,
        })
        .collect();
    let mut discovery = Discovery::new(rolling, anchor, close)?;
    let mut statement = read.prepare(
        "SELECT height,hash,time FROM blocks WHERE height>? AND height<=? ORDER BY height",
    )?;
    let mut rows = statement.query([anchor, height])?;
    while let Some(row) = rows.next()? {
        let h = Header {
            height: u32::try_from(row.get::<_, i64>(0)?)?,
            hash: row.get(1)?,
            time: u32::try_from(row.get::<_, i64>(2)?)?,
        };
        discovery.push(h)?;
    }
    if discovery.expected != u64::from(height) + 1
        || local(&read, height)?.is_none_or(|h| h.hash != hash)
    {
        return Err("incomplete H history".into());
    }
    let witness = if let Some(start) = discovery.crossing.map(|b| b - 12) {
        window(client, &read, start, start + 12, birthday).await?
    } else if height == anchor {
        Vec::new()
    } else {
        window(client, &read, height - 11, height, birthday).await?
    };
    let target = block(client, height, GuardPhase::Initial).await?;
    check_inclusion(&read, &target)?;
    Ok(
        json!({"version":2,"profile":"phase9-exact-chainclock-3-v1","status":if discovery.crossing.is_some(){"FOUND"}else{"NO_CROSSING_BY_H"},"boundary_height":discovery.crossing,"anchor_window":seed,"window":witness,"target":value(&target)}),
    )
}

pub(super) fn inclusion(b: &CompactBlock) -> Value {
    value(b)
}
pub(super) fn check_inclusion(read: &Connection, b: &CompactBlock) -> SpikeResult<()> {
    let h = Header::from_block(b)?;
    if local(read, h.height)?.as_ref() != Some(&h) {
        return Err("containing metadata conflicts with maintained history".into());
    }
    let birthday: u32 = read.query_row("SELECT birthday_height FROM accounts", [], |r| r.get(0))?;
    if h.height > birthday && local(read, h.height - 1)?.is_none_or(|p| p.hash != b.prev_hash) {
        return Err("containing predecessor changed".into());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn header(h: u32, time: u32) -> Header {
        Header {
            height: h,
            hash: vec![1; 32],
            time,
        }
    }
    fn state(close: u128) -> SpikeResult<Discovery> {
        Discovery::new((90..=100).map(|h| header(h, h)).collect(), 100, close)
    }
    #[test]
    fn bounded_discovery_first_middle_final_none_equality_fractional() -> SpikeResult<()> {
        assert_eq!(close_micros("110500000.000000")?, 110_500_000);
        assert_eq!(close_micros("110500000")?, 110_500_000);
        for invalid in ["", "-1", "+1", "1.1", "1.", "1e3", "1.000.0"] {
            assert!(close_micros(invalid).is_err());
        }
        for (close, end, expected) in [
            (96_000_000, 110, Some(102)),
            (110_000_000, 130, Some(116)),
            (124_000_000, 130, Some(130)),
            (125_000_000, 130, None),
            (110_000_001, 130, Some(117)),
        ] {
            let mut d = state(close)?;
            for h in 101..=end {
                d.push(header(h, h))?;
                assert!(d.rolling.len() <= 13);
            }
            assert_eq!(d.crossing, expected);
        }
        Ok(())
    }
    #[test]
    fn bounded_discovery_legal_backstep_plateau_and_bad_prefix() -> SpikeResult<()> {
        let mut d = state(110_000_000)?;
        d.push(header(101, 96))?; // less than t[100], but greater than preceding median 95.
        for h in 102..=130 {
            d.push(header(h, h))?;
        }
        assert!(d.crossing.is_some());
        for bad in [
            header(102, 102),
            header(100, 100),
            Header {
                height: 101,
                hash: vec![0; 31],
                time: 101,
            },
            header(101, 95),
        ] {
            assert!(state(110_000_000)?.push(bad).is_err());
        }
        assert!(
            Discovery::new((91..=100).map(|h| header(h, h)).collect(), 100, 110_000_000).is_err()
        );
        Ok(())
    }
    #[test]
    fn bounded_metadata_rejects_missing_or_malformed_timestamp() -> SpikeResult<()> {
        // Adapter corruption tests use a standalone in-memory metadata table, not fabricated WalletDb state.
        let read = Connection::open_in_memory()?;
        read.execute_batch("CREATE TABLE blocks(height INTEGER,hash BLOB,time);INSERT INTO blocks VALUES(100,zeroblob(31),100);")?;
        assert!(local(&read, 100).is_err());
        read.execute_batch("UPDATE blocks SET hash=zeroblob(32),time=NULL;")?;
        assert!(local(&read, 100).is_err());
        read.execute_batch("UPDATE blocks SET time=-1;")?;
        assert!(local(&read, 100).is_err());
        Ok(())
    }
    #[test]
    fn bounded_inclusion_rejects_wrong_action_index_and_transparent_pool() {
        use zcash_client_backend::proto::compact_formats::CompactTx;
        let b = CompactBlock {
            height: 100,
            hash: vec![1; 32],
            prev_hash: vec![2; 32],
            vtx: vec![CompactTx {
                txid: vec![3; 32],
                index: 7,
                ..Default::default()
            }],
            ..Default::default()
        };
        for pool in ["SAPLING", "ORCHARD", "IRONWOOD", "TRANSPARENT"] {
            let mut note = json!({"txid":hex(&[3;32]),"block_hash":hex(&b.hash),"tx_index":7,"output_index":0,"pool":pool});
            assert!(validate_output_inclusion(&mut note, &b).is_err());
        }
    }
}
