use pvm_stream_mailbox::cursor::{ConsumerCursor, CursorError, ProducerCursor};

#[test]
fn consumer_rejects_guest_producer_jump() {
    let cursor = ConsumerCursor::<8>::new().unwrap();
    assert_eq!(cursor.available(8), Ok(8));
    assert_eq!(cursor.available(9), Err(CursorError::PeerAdvancedTooFar));
}

#[test]
fn producer_rejects_impossible_guest_consumption() {
    let mut cursor = ProducerCursor::<4>::new().unwrap();
    assert_eq!(cursor.reserve_one(), Ok(0));
    assert_eq!(cursor.reserve_one(), Ok(1));
    assert_eq!(
        cursor.observe_consumer(3),
        Err(CursorError::PeerAdvancedTooFar)
    );
    assert_eq!(cursor.free(), 2);
    assert_eq!(cursor.observe_consumer(1), Ok(()));
    assert_eq!(cursor.free(), 3);
}

#[test]
fn wrapping_indices_remain_bounded() {
    let mut consumer = ConsumerCursor::<4>::from_consumed(u32::MAX - 1).unwrap();
    assert_eq!(consumer.available(1), Ok(3));
    assert_eq!(consumer.consume_one(1), Ok(2));
    assert_eq!(consumer.consume_one(1), Ok(3));
    assert_eq!(consumer.consume_one(1), Ok(0));
    assert_eq!(consumer.consume_one(1), Err(CursorError::Empty));

    let mut producer = ProducerCursor::<4>::from_counters(u32::MAX, u32::MAX - 1).unwrap();
    assert_eq!(producer.reserve_one(), Ok(3));
    assert_eq!(producer.reserve_one(), Ok(0));
    assert_eq!(producer.observe_consumer(0), Ok(()));
    assert_eq!(producer.free(), 3);
}

#[test]
fn invalid_capacities_fail_closed() {
    assert_eq!(
        ConsumerCursor::<0>::new(),
        Err(CursorError::InvalidCapacity)
    );
    assert_eq!(
        ProducerCursor::<0>::new(),
        Err(CursorError::InvalidCapacity)
    );
}
