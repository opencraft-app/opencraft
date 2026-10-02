use pvm_stream_mailbox::{
    Capability,
    wire::{ABI_VERSION, Command, CommandKind, DESCRIPTOR_SIZE, WireError},
};

fn capability() -> Capability {
    Capability {
        index: 7,
        generation: 9,
        session: 11,
    }
}

#[test]
fn canonical_commands_round_trip() {
    let commands = [
        Command {
            sequence: 1,
            capability: capability(),
            kind: CommandKind::Tx {
                slot: 2,
                offset: 3,
                length: 4,
            },
        },
        Command {
            sequence: 7,
            capability: capability(),
            kind: CommandKind::IngressAck,
        },
        Command {
            sequence: 8,
            capability: capability(),
            kind: CommandKind::IngressReject,
        },
        Command {
            sequence: 9,
            capability: capability(),
            kind: CommandKind::IngressAccept {
                pending_index: 12,
                pending_generation: 0x1122_3344_5566_7788,
            },
        },
        Command {
            sequence: 2,
            capability: capability(),
            kind: CommandKind::RxRelease { slot: 5 },
        },
        Command {
            sequence: 3,
            capability: capability(),
            kind: CommandKind::Close,
        },
        Command {
            sequence: 4,
            capability: capability(),
            kind: CommandKind::Connect { slot: 6, length: 8 },
        },
        Command {
            sequence: 5,
            capability: capability(),
            kind: CommandKind::Shutdown { how: 2 },
        },
        Command {
            sequence: 6,
            capability: capability(),
            kind: CommandKind::DnsQuery {
                slot: 7,
                length: 29,
            },
        },
    ];
    for command in commands {
        assert_eq!(Command::decode(&command.encode(), 11), Ok(command));
    }
}

#[test]
fn decoder_rejects_unknown_and_noncanonical_fields() {
    let mut bytes = [0_u8; DESCRIPTOR_SIZE];
    bytes[0..2].copy_from_slice(&ABI_VERSION.to_le_bytes());
    bytes[2..4].copy_from_slice(&99_u16.to_le_bytes());
    assert_eq!(Command::decode(&bytes, 11), Err(WireError::UnknownOpcode));

    let command = Command {
        sequence: 1,
        capability: capability(),
        kind: CommandKind::Close,
    };
    let mut bytes = command.encode();
    bytes[24..28].copy_from_slice(&1_u32.to_le_bytes());
    assert_eq!(Command::decode(&bytes, 11), Err(WireError::NonCanonical));

    let mut bytes = Command {
        sequence: 2,
        capability: capability(),
        kind: CommandKind::Shutdown { how: 2 },
    }
    .encode();
    bytes[24..28].copy_from_slice(&3_u32.to_le_bytes());
    assert_eq!(Command::decode(&bytes, 11), Err(WireError::NonCanonical));

    let mut bytes = command.encode();
    bytes[18..20].copy_from_slice(&1_u16.to_le_bytes());
    assert_eq!(Command::decode(&bytes, 11), Err(WireError::UnknownFlags));

    let mut bytes = command.encode();
    bytes[8..16].fill(0);
    assert_eq!(Command::decode(&bytes, 11), Err(WireError::NonCanonical));

    assert_eq!(
        Command::decode(&command.encode(), 0),
        Err(WireError::NonCanonical)
    );
}

#[test]
fn decoder_rejects_v5_after_v6_cutover() {
    let mut bytes = Command {
        sequence: 1,
        capability: capability(),
        kind: CommandKind::Close,
    }
    .encode();
    bytes[0..2].copy_from_slice(&5_u16.to_le_bytes());
    assert_eq!(Command::decode(&bytes, 11), Err(WireError::WrongVersion));
}

#[test]
fn ingress_accept_rejects_zero_pending_generation() {
    let mut bytes = Command {
        sequence: 1,
        capability: capability(),
        kind: CommandKind::IngressAccept {
            pending_index: 1,
            pending_generation: 1,
        },
    }
    .encode();
    bytes[20..28].fill(0);
    assert_eq!(Command::decode(&bytes, 11), Err(WireError::NonCanonical));
}
