use serde::{Deserialize, Serialize};

// ---------------------------------------------------------------------------
// Levenshtein distance — optimized single-row DP
// ---------------------------------------------------------------------------

/// Compute Levenshtein distance between two strings.
/// Uses O(min(m,n)) space instead of O(m×n).
pub fn levenshtein(a: &str, b: &str) -> usize {
    let a_bytes = a.as_bytes();
    let b_bytes = b.as_bytes();

    let (short, long) = if a_bytes.len() <= b_bytes.len() {
        (a_bytes, b_bytes)
    } else {
        (b_bytes, a_bytes)
    };

    let m = short.len();
    let n = long.len();

    if m == 0 {
        return n;
    }

    let mut prev_row: Vec<usize> = (0..=m).collect();
    let mut curr_row = vec![0usize; m + 1];

    for j in 1..=n {
        curr_row[0] = j;
        for i in 1..=m {
            let cost = if short[i - 1] == long[j - 1] { 0 } else { 1 };
            curr_row[i] = (prev_row[i] + 1)
                .min(curr_row[i - 1] + 1)
                .min(prev_row[i - 1] + cost);
        }
        std::mem::swap(&mut prev_row, &mut curr_row);
    }

    prev_row[m]
}

// ---------------------------------------------------------------------------
// Fuzzy keyword matching
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct KeywordEntry {
    pub keyword: String,
    pub module: String,
    pub action: String,
}

#[derive(Debug, Serialize)]
pub struct FuzzyMatch {
    pub keyword: String,
    pub module: String,
    pub action: String,
    pub distance: usize,
    pub confidence: f32,
}

/// Given input words and a keyword map, find the best fuzzy match.
/// Returns None if no match within tolerance.
pub fn fuzzy_match(words: &[&str], keywords: &[KeywordEntry], max_distance: usize) -> Option<FuzzyMatch> {
    let mut best: Option<FuzzyMatch> = None;

    for word in words {
        if word.len() < 3 {
            continue;
        }
        for entry in keywords {
            let dist = levenshtein(word, &entry.keyword);
            let threshold = ((word.len() as f32) * 0.45) as usize;
            if dist <= max_distance && dist <= threshold {
                let confidence = 1.0 - (dist as f32 / word.len().max(1) as f32);
                if best.as_ref().map_or(true, |b| dist < b.distance || (dist == b.distance && confidence > b.confidence)) {
                    best = Some(FuzzyMatch {
                        keyword: entry.keyword.clone(),
                        module: entry.module.clone(),
                        action: entry.action.clone(),
                        distance: dist,
                        confidence,
                    });
                }
            }
        }
    }

    best
}

// ---------------------------------------------------------------------------
// Batch Levenshtein — compare one word against many candidates at once
// ---------------------------------------------------------------------------

#[derive(Debug, Serialize)]
pub struct BatchResult {
    pub candidate: String,
    pub distance: usize,
}

/// Compute Levenshtein distance from `input` to every candidate.
/// Returns only those within `max_distance`, sorted by distance.
pub fn batch_levenshtein(input: &str, candidates: &[String], max_distance: usize) -> Vec<BatchResult> {
    let mut results: Vec<BatchResult> = candidates
        .iter()
        .filter_map(|c| {
            let dist = levenshtein(input, c);
            if dist <= max_distance {
                Some(BatchResult {
                    candidate: c.clone(),
                    distance: dist,
                })
            } else {
                None
            }
        })
        .collect();

    results.sort_by_key(|r| r.distance);
    results
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_levenshtein_identical() {
        assert_eq!(levenshtein("hello", "hello"), 0);
    }

    #[test]
    fn test_levenshtein_one_edit() {
        assert_eq!(levenshtein("hello", "helo"), 1);
        assert_eq!(levenshtein("hello", "hellp"), 1);
    }

    #[test]
    fn test_levenshtein_empty() {
        assert_eq!(levenshtein("", "abc"), 3);
        assert_eq!(levenshtein("abc", ""), 3);
    }

    #[test]
    fn test_fuzzy_match() {
        let keywords = vec![
            KeywordEntry { keyword: "battery".into(), module: "system-monitor".into(), action: "battery".into() },
            KeywordEntry { keyword: "weather".into(), module: "weather-news".into(), action: "weather".into() },
        ];

        // Exact
        let m = fuzzy_match(&["battery"], &keywords, 2);
        assert!(m.is_some());
        assert_eq!(m.unwrap().keyword, "battery");

        // Typo
        let m = fuzzy_match(&["baterry"], &keywords, 2);
        assert!(m.is_some());
        assert_eq!(m.unwrap().keyword, "battery");
    }
}
