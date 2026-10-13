#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ByteRange {
    pub start: u64,
    pub end: u64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, thiserror::Error)]
pub enum RangeError {
    #[error("malformed range header")]
    Malformed,
    #[error("range unsatisfiable")]
    Unsatisfiable,
    #[error("multiple ranges are not supported")]
    Multiple,
}

#[inline]
fn parse_digits(s: &str) -> Result<u64, RangeError> {
    if s.is_empty() || !s.chars().all(|c| c.is_ascii_digit()) {
        return Err(RangeError::Malformed);
    }
    s.parse::<u64>().map_err(|_| RangeError::Malformed)
}

/// Parses a single HTTP Byte Range header value according to RFC 7233 / RFC 9110 rules.
///
/// Rules:
/// - Header must start with `bytes=`.
/// - Rejects multiple ranges (containing commas) with `RangeError::Multiple`.
/// - Supports `bytes=start-end` (e.g. `1-3`), `bytes=start-` (e.g. `8-`), `bytes=-suffix` (e.g. `-2`).
/// - Numbers must be non-empty sequence of ASCII digits (no signs like `+` or `-`).
/// - If `size == 0`, any range request returns `RangeError::Unsatisfiable`.
/// - Suffix 0 (`bytes=-0`) returns `RangeError::Unsatisfiable`.
/// - If `start > end`, returns `RangeError::Unsatisfiable`.
/// - If `start >= size`, returns `RangeError::Unsatisfiable`.
/// - If `end >= size`, it is truncated to `size - 1`.
/// - If suffix exceeds or equals file size, the entire entity is returned (`0..=size-1`).
/// - Arithmetic uses checked operations to avoid integer overflows.
pub fn parse_range(header_val: &str, size: u64) -> Result<ByteRange, RangeError> {
    if size == 0 {
        return Err(RangeError::Unsatisfiable);
    }

    let trimmed = header_val.trim();
    let ranges_spec = trimmed
        .strip_prefix("bytes=")
        .ok_or(RangeError::Malformed)?
        .trim();

    if ranges_spec.is_empty() {
        return Err(RangeError::Malformed);
    }

    // Multiple ranges separated by comma
    if ranges_spec.contains(',') {
        return Err(RangeError::Multiple);
    }

    let (start_part, end_part) = ranges_spec.split_once('-').ok_or(RangeError::Malformed)?;
    let start_part = start_part.trim();
    let end_part = end_part.trim();

    // Reject additional hyphens
    if end_part.contains('-') {
        return Err(RangeError::Malformed);
    }

    let max_end = size.checked_sub(1).ok_or(RangeError::Unsatisfiable)?;

    match (start_part.is_empty(), end_part.is_empty()) {
        (true, true) => {
            // "bytes=-" is malformed
            Err(RangeError::Malformed)
        }
        (true, false) => {
            // Suffix range: bytes=-<suffix-length>
            let suffix_len: u64 = parse_digits(end_part)?;
            if suffix_len == 0 {
                return Err(RangeError::Unsatisfiable);
            }

            if suffix_len >= size {
                // Suffix exceeds or equals size: return entire entity
                Ok(ByteRange {
                    start: 0,
                    end: max_end,
                })
            } else {
                let start = size
                    .checked_sub(suffix_len)
                    .ok_or(RangeError::Unsatisfiable)?;
                Ok(ByteRange {
                    start,
                    end: max_end,
                })
            }
        }
        (false, true) => {
            // Open-ended range: bytes=<start>-
            let start: u64 = parse_digits(start_part)?;
            if start >= size {
                return Err(RangeError::Unsatisfiable);
            }
            Ok(ByteRange {
                start,
                end: max_end,
            })
        }
        (false, false) => {
            // Closed range: bytes=<start>-<end>
            let start: u64 = parse_digits(start_part)?;
            let end: u64 = parse_digits(end_part)?;

            if start > end {
                return Err(RangeError::Unsatisfiable);
            }
            if start >= size {
                return Err(RangeError::Unsatisfiable);
            }

            // Truncate end if it exceeds size - 1
            let effective_end = if end >= size { max_end } else { end };

            Ok(ByteRange {
                start,
                end: effective_end,
            })
        }
    }
}
