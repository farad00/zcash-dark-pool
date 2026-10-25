"""Independent synthetic-only reference: Python integers/UTF-8/hashlib.

No production imports, wallet input, secrets, database, network or file writes.
Emit literal vectors to stdout; run with --check <saved JSON> to reproduce them.
The recursive split implementation deliberately differs from pair/promote TS.
"""

import hashlib
import json
import sys

PROFILE = "DARKPOOL_LEDGER_V1_BIN1_B2B256"


def frame(raw):
    return len(raw).to_bytes(4, "big") + raw


def text(value):
    assert value and "\0" not in value
    return frame(value.encode("utf-8", errors="strict"))


def digest(label, *parts):
    return hashlib.blake2b(
        label.encode("ascii") + b"\0" + b"".join(parts), digest_size=32
    ).digest()


def context_bytes(ctx):
    return text(PROFILE) + b"\0\1\1" + text(ctx["market_id"])


def build(case, records, market="synthetic-market", stamp="2026-10-19T12:34:56.123456Z"):
    ctx = dict(profile=PROFILE, version=1, network="testnet", market_id=market, locked_at=stamp)
    context = context_bytes(ctx)
    ordered = sorted(records, key=lambda item: bytes.fromhex(item["ticket_id"]))
    leaves = []
    bodies = []
    leaf_preimages = []
    encoded = []
    for record in ordered:
        value = int(record["accepted_amount_zat"])
        magnitude = value.to_bytes((value.bit_length() + 7) // 8, "big")
        body = (
            context + bytes.fromhex(record["ticket_id"])
            + bytes([1 if record["side"] == "YES" else 2]) + frame(magnitude)
            + text(record["accepted_payment_ref"]) + text(record["receiver_ref"])
        )
        private = body + bytes.fromhex(record["record_blinding"])
        bodies.append(body.hex())
        encoded.append(private.hex())
        preimage = b"DARKPOOL_LEDGER_LEAF_V1\0" + private
        leaf_preimages.append(preimage.hex())
        leaves.append(digest("DARKPOOL_LEDGER_LEAF_V1", private))
    nodes = []

    def tree(start, length):
        if not length:
            return digest("DARKPOOL_LEDGER_EMPTY_V1", context)
        if length == 1:
            return leaves[start]
        split = 1 << ((length - 1).bit_length() - 1)
        left = tree(start, split)
        right = tree(start + split, length - split)
        result = digest("DARKPOOL_LEDGER_NODE_V1", context, left, right)
        preimage = b"DARKPOOL_LEDGER_NODE_V1\0" + context + left + right
        nodes.append(dict(start=start, count=length, left=left.hex(), right=right.hex(),
                          preimage=preimage.hex(), hash=result.hex()))
        return result

    top = tree(0, len(leaves))
    envelope = context + len(records).to_bytes(8, "big") + text(stamp) + top
    root = digest("DARKPOOL_LEDGER_ROOT_V1", envelope)
    return dict(
        case=case, context=ctx, records=ordered, context_hex=context.hex(),
        record_bodies=bodies, private_records=encoded, leaf_preimages=leaf_preimages,
        leaves=[leaf.hex() for leaf in leaves], internal_nodes=nodes,
        empty_preimage=(b"DARKPOOL_LEDGER_EMPTY_V1\0" + context).hex(),
        empty_hash=digest("DARKPOOL_LEDGER_EMPTY_V1", context).hex(),
        tree_hash=top.hex(), root_preimage=(b"DARKPOOL_LEDGER_ROOT_V1\0" + envelope).hex(),
        root=root.hex(),
        truncated_blake2b512=hashlib.blake2b(b"DARKPOOL_LEDGER_ROOT_V1\0" + envelope).digest()[:32].hex(),
    )


def ticket(index, amount, side="YES", payment=None, receiver=None):
    return dict(
        version=1, network="testnet", market_id="synthetic-market",
        ticket_id=f"{index:064x}", side=side, accepted_amount_zat=str(amount),
        accepted_payment_ref=payment if payment is not None else f"synthetic-payment-{index}",
        receiver_ref=receiver if receiver is not None else f"synthetic-receiver-{index}",
        record_blinding=bytes((index * 32 + offset) % 256 for offset in range(32)).hex(),
    )


def vectors():
    amounts = [1, 256, 65535, 65536, 9007199254740993, (1 << 128) - 1, 255]
    records = [ticket(index + 1, amount, "YES" if index % 2 == 0 else "NO")
               for index, amount in enumerate(amounts)]
    cases = [build(f"leaves-{count}", records[:count]) for count in [0, 1, 2, 3, 5, 6, 7]]
    unicode_record = ticket(10, 257, payment="合成-é", receiver="\ufeffsynthetic-e\u0301")
    unicode_record["market_id"] = "合成-market"
    cases.append(build("unicode", [unicode_record], market="合成-market"))
    for name, market, payment in [("split-ab-c", "ab", "c"), ("split-a-bc", "a", "bc")]:
        record = ticket(11, 1, payment=payment)
        record["market_id"] = market
        cases.append(build(name, [record], market=market))
    return dict(profile=PROFILE, generator="Python hashlib.blake2b(digest_size=32); recursive tree split", cases=cases)


if __name__ == "__main__":
    result = vectors()
    if len(sys.argv) == 3 and sys.argv[1] == "--check":
        with open(sys.argv[2], encoding="utf-8") as saved:
            if json.load(saved) != result:
                raise SystemExit("Independent ledger vectors differ")
        print(f"Independent ledger vectors reproduced: {len(result['cases'])}")
    elif len(sys.argv) == 1:
        print(json.dumps(result, ensure_ascii=True, indent=2))
    else:
        raise SystemExit("Expected no arguments or --check <saved JSON>")
