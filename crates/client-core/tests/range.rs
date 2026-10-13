use ashfall_client_core::range::{parse_range, ByteRange, RangeError};

#[test]
fn test_range_struct_traits() {
    let r1 = ByteRange { start: 1, end: 3 };
    let r2 = r1; // Copy
    assert_eq!(r1, r2); // PartialEq, Eq
    let cloned = r1.clone(); // Clone
    assert_eq!(format!("{:?}", cloned), "ByteRange { start: 1, end: 3 }"); // Debug
}

#[test]
fn test_parse_range_valid_standard() {
    let res = parse_range("bytes=1-3", 10).unwrap();
    assert_eq!(res, ByteRange { start: 1, end: 3 });

    let res = parse_range("bytes=0-0", 10).unwrap();
    assert_eq!(res, ByteRange { start: 0, end: 0 });

    let res = parse_range("bytes=0-9", 10).unwrap();
    assert_eq!(res, ByteRange { start: 0, end: 9 });
}

#[test]
fn test_parse_range_open_end() {
    let res = parse_range("bytes=8-", 10).unwrap();
    assert_eq!(res, ByteRange { start: 8, end: 9 });

    let res = parse_range("bytes=0-", 10).unwrap();
    assert_eq!(res, ByteRange { start: 0, end: 9 });
}

#[test]
fn test_parse_range_suffix() {
    let res = parse_range("bytes=-2", 10).unwrap();
    assert_eq!(res, ByteRange { start: 8, end: 9 });

    let res = parse_range("bytes=-1", 10).unwrap();
    assert_eq!(res, ByteRange { start: 9, end: 9 });
}

#[test]
fn test_parse_range_end_clamped() {
    // end >= size should be truncated to size - 1
    let res = parse_range("bytes=5-20", 10).unwrap();
    assert_eq!(res, ByteRange { start: 5, end: 9 });
}

#[test]
fn test_parse_range_suffix_exceeds_size() {
    // suffix > size should give the whole entity (0..size-1)
    let res = parse_range("bytes=-15", 10).unwrap();
    assert_eq!(res, ByteRange { start: 0, end: 9 });

    // suffix == size also gives the whole entity
    let res = parse_range("bytes=-10", 10).unwrap();
    assert_eq!(res, ByteRange { start: 0, end: 9 });
}

#[test]
fn test_parse_range_size_zero_unsatisfiable() {
    assert_eq!(parse_range("bytes=0-0", 0), Err(RangeError::Unsatisfiable));
    assert_eq!(parse_range("bytes=0-", 0), Err(RangeError::Unsatisfiable));
    assert_eq!(parse_range("bytes=-1", 0), Err(RangeError::Unsatisfiable));
}

#[test]
fn test_parse_range_suffix_zero_unsatisfiable() {
    assert_eq!(parse_range("bytes=-0", 10), Err(RangeError::Unsatisfiable));
}

#[test]
fn test_parse_range_start_greater_than_end() {
    assert_eq!(parse_range("bytes=5-3", 10), Err(RangeError::Unsatisfiable));
}

#[test]
fn test_parse_range_start_out_of_bounds() {
    assert_eq!(parse_range("bytes=10-", 10), Err(RangeError::Unsatisfiable));
    assert_eq!(parse_range("bytes=11-12", 10), Err(RangeError::Unsatisfiable));
}

#[test]
fn test_parse_range_multiple_ranges() {
    assert_eq!(parse_range("bytes=0-1, 2-3", 10), Err(RangeError::Multiple));
    assert_eq!(parse_range("bytes=1-, -2", 10), Err(RangeError::Multiple));
    assert_eq!(parse_range("bytes=0-0, 1-1, 2-2", 10), Err(RangeError::Multiple));
}

#[test]
fn test_parse_range_malformed() {
    // Missing prefix
    assert_eq!(parse_range("1-3", 10), Err(RangeError::Malformed));
    // Invalid unit
    assert_eq!(parse_range("items=1-3", 10), Err(RangeError::Malformed));
    // Empty range spec
    assert_eq!(parse_range("bytes=", 10), Err(RangeError::Malformed));
    // Bare hyphen
    assert_eq!(parse_range("bytes=-", 10), Err(RangeError::Malformed));
    // Multiple hyphens
    assert_eq!(parse_range("bytes=1-2-3", 10), Err(RangeError::Malformed));
    // Non-numeric
    assert_eq!(parse_range("bytes=abc-def", 10), Err(RangeError::Malformed));
    assert_eq!(parse_range("bytes=1-xyz", 10), Err(RangeError::Malformed));
    // Overflow
    assert_eq!(
        parse_range("bytes=18446744073709551616-", 10),
        Err(RangeError::Malformed)
    );
    assert_eq!(
        parse_range("bytes=0-18446744073709551616", 10),
        Err(RangeError::Malformed)
    );
}

#[test]
fn test_parse_range_reject_plus_sign() {
    // Explicit plus sign must be rejected as Malformed per RFC 9110 1*DIGIT grammar
    assert_eq!(parse_range("bytes=+1-3", 10), Err(RangeError::Malformed));
    assert_eq!(parse_range("bytes=1-+3", 10), Err(RangeError::Malformed));
    assert_eq!(parse_range("bytes=+8-", 10), Err(RangeError::Malformed));
    assert_eq!(parse_range("bytes=-+2", 10), Err(RangeError::Malformed));
}
